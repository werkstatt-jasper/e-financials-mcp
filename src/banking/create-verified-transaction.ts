import type { EFinancialsClient } from "../client.js";
import type { Transaction } from "../types/transaction.js";
import { errorMessage } from "./errors.js";
import {
  directionFromToolType,
  rikMessages,
  rikTypeForToolType,
  savedDirectionFromMessages,
  type ToolTransactionType,
  type TransactionDirection,
  transactionIdFromResponse,
} from "./transaction-direction.js";

export interface VerifiedTransaction extends Transaction {
  rik_messages: string[];
  /** False when RIK's save message did not name the requested direction. The draft is kept. */
  direction_confirmed: boolean;
  /** Set when the draft exists but could not be read back; other fields then come from the request. */
  read_back_error?: string;
}

function directionError(
  toolType: ToolTransactionType,
  apiType: ToolTransactionType,
  messages: string[],
): string {
  const reported = messages.join("; ");
  return `Requested type ${toolType} (${directionFromToolType(toolType)}), sent API type ${apiType}, RIK reported: ${reported}.`;
}

async function deleteDraft(client: EFinancialsClient, id: number): Promise<void> {
  try {
    await client.delete(`/v1/transactions/${id}`);
  } catch (error) {
    throw new Error(`Failed to delete draft transaction ${id}: ${errorMessage(error)}`);
  }
}

function oppositeDirection(direction: TransactionDirection): TransactionDirection {
  return direction === "outgoing" ? "incoming" : "outgoing";
}

async function readBack(
  client: EFinancialsClient,
  id: number,
): Promise<{ stored: Transaction } | { error: string }> {
  try {
    const stored = await client.get<Transaction>(`/v1/transactions/${id}`);
    if (stored == null || typeof stored !== "object" || Array.isArray(stored)) {
      return { error: "the response was empty" };
    }
    return { stored: stored as Transaction };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/**
 * Create a PROJECT transaction. The wire `type` is the opposite of the tool
 * contract. A save message that names the other direction is patched once and
 * then the draft is deleted. An empty or unrecognized message keeps the draft
 * with `direction_confirmed: false`.
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
  let saved = savedDirectionFromMessages(messages);
  if (saved === oppositeDirection(direction)) {
    try {
      const patched = await client.patch(`/v1/transactions/${id}`, { type: apiType });
      messages = rikMessages(patched);
      saved = savedDirectionFromMessages(messages);
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
    if (saved === oppositeDirection(direction)) {
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

  const read = await readBack(client, id);
  const result = {
    ...("stored" in read ? read.stored : (body as unknown as Transaction)),
    id,
    type: toolType,
    rik_messages: messages,
    direction_confirmed: saved === direction,
  };
  if ("error" in read) {
    return {
      ...result,
      read_back_error: `Transaction ${id} was created but could not be read back: ${read.error}`,
    };
  }
  return result;
}
