import type { EFinancialsClient } from "../client.js";
import type { Transaction } from "../types/transaction.js";
import { errorMessage } from "./errors.js";
import { type StoredDirection, storedDirection } from "./stored-direction.js";
import {
  directionFromToolType,
  reportedMessages,
  rikMessages,
  rikTypeForToolType,
  type ToolTransactionType,
  type TransactionDirection,
  transactionIdFromResponse,
} from "./transaction-direction.js";

export interface VerifiedTransaction extends Transaction {
  rik_messages: string[];
  /** False when the stored direction is unknown or could not be checked. The draft is kept. */
  direction_confirmed: boolean;
  /** Set when the draft exists but could not be read back; other fields then come from the request. */
  read_back_error?: string;
}

function oppositeDirection(direction: TransactionDirection): TransactionDirection {
  return direction === "outgoing" ? "incoming" : "outgoing";
}

function directionError(
  toolType: ToolTransactionType,
  apiType: ToolTransactionType,
  messages: string[],
): string {
  const stored = oppositeDirection(directionFromToolType(toolType));
  return `Requested type ${toolType} (${directionFromToolType(toolType)}), sent API type ${apiType}, but RIK stored the transaction as ${stored}.${reportedMessages(messages)}`;
}

async function deleteDraft(client: EFinancialsClient, id: number): Promise<void> {
  try {
    await client.delete(`/v1/transactions/${id}`);
  } catch (error) {
    throw new Error(`Failed to delete draft transaction ${id}: ${errorMessage(error)}`);
  }
}

async function checkDirection(
  client: EFinancialsClient,
  id: number,
  date: unknown,
): Promise<StoredDirection> {
  try {
    return await storedDirection(client, id, date);
  } catch {
    return "unknown";
  }
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
 * contract. When RIK stored the other direction, the draft is patched once and
 * then deleted. When the stored direction is unknown, the draft is kept with
 * `direction_confirmed: false`.
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

  const date = body.date;
  let messages = rikMessages(posted);
  let stored = await checkDirection(client, id, date);
  if (stored === oppositeDirection(direction)) {
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
    stored = await checkDirection(client, id, date);
    if (stored === oppositeDirection(direction)) {
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
    direction_confirmed: stored === direction,
  };
  if ("error" in read) {
    return {
      ...result,
      read_back_error: `Transaction ${id} was created but could not be read back: ${read.error}`,
    };
  }
  return result;
}
