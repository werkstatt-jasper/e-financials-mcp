/**
 * Tool contract used by MCP tools and bank matching: C = money in, D = money out.
 *
 * RIK stores the cash-account debit/credit letter, which is the opposite:
 * POST/PATCH `type: "D"` saves an incoming payment and `type: "C"` an outgoing
 * one. GET does not return that letter (see `stored-direction.ts`).
 */

export type ToolTransactionType = "C" | "D";
export type TransactionDirection = "incoming" | "outgoing";

/** RIK letter to send for a tool type. */
export function rikTypeForToolType(toolType: ToolTransactionType): ToolTransactionType {
  return toolType === "D" ? "C" : "D";
}

export function directionFromToolType(toolType: ToolTransactionType): TransactionDirection {
  return toolType === "D" ? "outgoing" : "incoming";
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

/** " RIK reported: …." for error text, or "" when RIK sent no message. */
export function reportedMessages(messages: readonly string[]): string {
  return messages.length > 0 ? ` RIK reported: ${messages.join("; ").replace(/\.$/, "")}.` : "";
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
