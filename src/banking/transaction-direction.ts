/**
 * Tool contract used by MCP tools and bank matching: C = money in, D = money out.
 *
 * The live RIK API stores the cash-account debit/credit letter, which is the
 * opposite of that contract:
 * - POST/PATCH `type: "D"` → incoming ("Incoming payment has been saved.")
 * - POST/PATCH `type: "C"` → outgoing ("Outgoing payment has been saved.")
 * Reads translate the stored letter back to the tool contract. A GET that
 * returns C for every row cannot be repaired by that translation.
 */

export type ToolTransactionType = "C" | "D";
export type TransactionDirection = "incoming" | "outgoing";
export type SavedDirection = TransactionDirection | "unknown";

const OUTGOING_MESSAGE = /outgoing|väljaminev|väljuv|väljamakse/i;
const INCOMING_MESSAGE = /incoming|sissetulev|laekuv|laekumine|laekunud/i;

/** RIK letter to send for a tool type. */
export function rikTypeForToolType(toolType: ToolTransactionType): ToolTransactionType {
  return toolType === "D" ? "C" : "D";
}

/** Tool letter for a letter stored by RIK. Anything else is left unchanged. */
export function toolTypeFromRikType(
  rikType: string | null | undefined,
): ToolTransactionType | undefined {
  if (rikType === "C") {
    return "D";
  }
  if (rikType === "D") {
    return "C";
  }
  return undefined;
}

export function withToolTransactionType<T extends object>(row: T): T {
  const toolType = toolTypeFromRikType((row as { type?: string | null }).type);
  if (toolType == null) {
    return row;
  }
  return { ...row, type: toolType };
}

export function directionFromToolType(toolType: ToolTransactionType): TransactionDirection {
  return toolType === "D" ? "outgoing" : "incoming";
}

/**
 * Direction named by a save message. Empty, unrecognized, or mixed wording is
 * unknown: callers keep the row instead of treating that as the wrong direction.
 */
export function savedDirectionFromMessages(messages: readonly string[]): SavedDirection {
  const text = messages.join(" ");
  const outgoing = OUTGOING_MESSAGE.test(text);
  const incoming = INCOMING_MESSAGE.test(text);
  if (outgoing === incoming) {
    return "unknown";
  }
  return outgoing ? "outgoing" : "incoming";
}

export function messageMatchesDirection(
  messages: readonly string[],
  direction: TransactionDirection,
): boolean {
  return savedDirectionFromMessages(messages) === direction;
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
