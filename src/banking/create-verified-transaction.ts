import type { EFinancialsClient } from "../client.js";
import type { Transaction } from "../types/transaction.js";
import { errorMessage } from "./errors.js";
import {
  directionFromToolType,
  messageMatchesDirection,
  rikMessages,
  rikTypeForToolType,
  type ToolTransactionType,
  transactionIdFromResponse,
} from "./transaction-direction.js";

export interface VerifiedTransaction extends Transaction {
  rik_messages: string[];
}

function directionError(
  toolType: ToolTransactionType,
  apiType: ToolTransactionType,
  messages: string[],
): string {
  const reported = messages.length > 0 ? messages.join("; ") : "(no message)";
  return `Requested type ${toolType} (${directionFromToolType(toolType)}), sent API type ${apiType}, RIK reported: ${reported}.`;
}

async function deleteDraft(client: EFinancialsClient, id: number): Promise<void> {
  try {
    await client.delete(`/v1/transactions/${id}`);
  } catch (error) {
    throw new Error(`Failed to delete draft transaction ${id}: ${errorMessage(error)}`);
  }
}

/**
 * Create a PROJECT transaction and keep it only when RIK's save message matches
 * the requested direction. The wire `type` is the opposite of the tool contract.
 * When the first message is wrong, PATCH the same API type once (that corrects
 * a dropped letter). A second miss deletes the draft.
 */
export async function createVerifiedTransaction(
  client: EFinancialsClient,
  body: Record<string, string | number> & { type: ToolTransactionType },
): Promise<VerifiedTransaction> {
  const toolType = body.type;
  const apiType = rikTypeForToolType(toolType);
  const direction = directionFromToolType(toolType);
  const posted = await client.post("/v1/transactions", { ...body, type: apiType });
  const id = transactionIdFromResponse(posted);
  if (id == null) {
    throw new Error("RIK did not return a transaction id");
  }

  let messages = rikMessages(posted);
  if (!messageMatchesDirection(messages, direction)) {
    try {
      const patched = await client.patch(`/v1/transactions/${id}`, { type: apiType });
      messages = rikMessages(patched);
    } catch (error) {
      try {
        await deleteDraft(client, id);
      } catch (deleteError) {
        throw new Error(
          `${directionError(toolType, apiType, messages)} PATCH failed: ${errorMessage(error)} ${errorMessage(deleteError)}`,
        );
      }
      throw new Error(
        `${directionError(toolType, apiType, messages)} PATCH failed: ${errorMessage(error)} The draft was deleted.`,
      );
    }
    if (!messageMatchesDirection(messages, direction)) {
      try {
        await deleteDraft(client, id);
      } catch (deleteError) {
        throw new Error(
          `${directionError(toolType, apiType, messages)} ${errorMessage(deleteError)}`,
        );
      }
      throw new Error(`${directionError(toolType, apiType, messages)} The draft was deleted.`);
    }
  }

  const stored = await client.get<Transaction>(`/v1/transactions/${id}`);
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(`RIK created transaction ${id} but the read-back was empty`);
  }
  return {
    ...(stored as Transaction),
    id,
    type: toolType,
    rik_messages: messages,
  };
}
