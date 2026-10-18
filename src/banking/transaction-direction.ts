/**
 * Tool contract used by MCP tools and bank matching: C = money in, D = money out.
 *
 * The live RIK API (demo, 2026-10-18) stores the cash-account debit/credit letter,
 * which is the opposite of that contract:
 * - POST/PATCH `type: "D"` → "Incoming payment has been saved."
 * - POST/PATCH `type: "C"` → "Outgoing payment has been saved."
 * `GET /v1/transactions` returns `type: "C"` for both directions, so a read-back
 * cannot prove what was stored. Callers check the save message instead.
 */

export type ToolTransactionType = "C" | "D";
export type TransactionDirection = "incoming" | "outgoing";

const OUTGOING_MESSAGE = /outgoing|väljaminev|väljuv/i;
const INCOMING_MESSAGE = /incoming|sissetulev|laekuv/i;

/** RIK letter to send for a tool type. */
export function rikTypeForToolType(toolType: ToolTransactionType): ToolTransactionType {
  return toolType === "D" ? "C" : "D";
}

export function directionFromToolType(toolType: ToolTransactionType): TransactionDirection {
  return toolType === "D" ? "outgoing" : "incoming";
}

export function messageMatchesDirection(
  messages: readonly string[],
  direction: TransactionDirection,
): boolean {
  const text = messages.join(" ");
  const outgoing = OUTGOING_MESSAGE.test(text);
  const incoming = INCOMING_MESSAGE.test(text);
  if (direction === "outgoing") {
    return outgoing && !incoming;
  }
  return incoming && !outgoing;
}

/** Save-confirmation text from a RIK POST/PATCH body (`messages` or `response_message`). */
export function rikMessages(response: unknown): string[] {
  if (response == null || typeof response !== "object") {
    return [];
  }
  const record = response as Record<string, unknown>;
  if (Array.isArray(record.messages)) {
    return record.messages.filter((message): message is string => typeof message === "string");
  }
  if (typeof record.response_message === "string") {
    return [record.response_message];
  }
  return [];
}

export function transactionIdFromResponse(response: unknown): number | undefined {
  if (response == null || typeof response !== "object") {
    return undefined;
  }
  const record = response as Record<string, unknown>;
  if (typeof record.id === "number") {
    return record.id;
  }
  if (typeof record.created_object_id === "number") {
    return record.created_object_id;
  }
  return undefined;
}
