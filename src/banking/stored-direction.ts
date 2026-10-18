import type { EFinancialsClient } from "../client.js";
import type { Transaction } from "../types/transaction.js";
import type { ToolTransactionType, TransactionDirection } from "./transaction-direction.js";

/** Incoming or outgoing only with positive evidence; unknown when the row cannot be placed. */
export type StoredDirection = TransactionDirection | "unknown";

/**
 * RIK's GET returns `type: "C"` for every transaction, whatever was stored.
 * The list filter ignores the letter it is given and returns the rows stored
 * as incoming. Asking for "D" (RIK's incoming letter) stays correct if RIK
 * fixes either behaviour.
 */
const INCOMING_FILTER = "D";

export interface TransactionListFilter {
  start_date?: string;
  end_date?: string;
  status?: string;
  clients_id?: number;
  modified_since?: string;
}

/** Ids of the transactions RIK stored as incoming, within the filter. */
export async function loadIncomingIds(
  client: EFinancialsClient,
  filter: TransactionListFilter,
): Promise<Set<number>> {
  const rows = await client.getAllPages<Transaction>("/v1/transactions", {
    ...filter,
    type: INCOMING_FILTER,
  });
  return new Set(rows.map((row) => row.id));
}

/** Sets the tool type: C (money in) for stored-incoming rows, D (money out) for the rest. */
export function labelDirection<T extends { id: number }>(
  rows: readonly T[],
  incomingIds: ReadonlySet<number>,
): Array<T & { type: ToolTransactionType }> {
  return rows.map((row) => ({ ...row, type: incomingIds.has(row.id) ? "C" : "D" }));
}

/** All transactions within the filter, labelled with their stored direction. */
export async function loadLabelledTransactions(
  client: EFinancialsClient,
  filter: TransactionListFilter,
): Promise<Transaction[]> {
  const [rows, incomingIds] = await Promise.all([
    client.getAllPages<Transaction>("/v1/transactions", { ...filter }),
    loadIncomingIds(client, filter),
  ]);
  return labelDirection(rows, incomingIds);
}

/** Earliest and latest `date` of the rows, as a list filter. */
export function dateRangeOf(rows: ReadonlyArray<{ date?: string | null }>): {
  start_date?: string;
  end_date?: string;
} {
  const dates = rows
    .map((row) => String(row.date ?? "").slice(0, 10))
    .filter((date) => date !== "")
    .sort();
  if (dates.length === 0) {
    return {};
  }
  return { start_date: dates[0], end_date: dates[dates.length - 1] };
}

/** Labels rows that were already fetched, using the incoming rows in their date range. */
export async function labelFetchedRows(
  client: EFinancialsClient,
  rows: readonly Transaction[],
  filter: Pick<TransactionListFilter, "status" | "clients_id">,
): Promise<Transaction[]> {
  if (rows.length === 0) {
    return [];
  }
  const incomingIds = await loadIncomingIds(client, {
    status: filter.status,
    clients_id: filter.clients_id,
    ...dateRangeOf(rows),
  });
  return labelDirection(rows, incomingIds);
}

export interface TransactionPage {
  items: Transaction[];
  current_page: number;
  total_pages: number;
}

/** One RIK page of the stored-incoming rows, labelled C. */
export async function getIncomingPage(
  client: EFinancialsClient,
  filter: TransactionListFilter,
  page?: number,
): Promise<TransactionPage> {
  const response = await client.get<Transaction>("/v1/transactions", {
    ...filter,
    type: INCOMING_FILTER,
    page,
  });
  return {
    items: (response.items || []).map((row) => ({ ...row, type: "C" as const })),
    current_page: response.current_page || 1,
    total_pages: response.total_pages || 1,
  };
}

const RIK_PAGE_SIZE = 100;

/** Pages rows locally the way RIK pages its lists. */
export function pageOf(rows: readonly Transaction[], page: number): TransactionPage {
  return {
    items: rows.slice((page - 1) * RIK_PAGE_SIZE, page * RIK_PAGE_SIZE),
    current_page: page,
    total_pages: Math.max(1, Math.ceil(rows.length / RIK_PAGE_SIZE)),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Stored direction of one transaction on that day.
 * Incoming when the row is in the incoming filter, outgoing when it is only in
 * the unfiltered list, and unknown when it is in neither or the date is unusable.
 * A missing row is not treated as outgoing.
 */
export async function storedDirection(
  client: EFinancialsClient,
  id: number,
  date: unknown,
): Promise<StoredDirection> {
  const day = typeof date === "string" ? date.slice(0, 10) : "";
  if (!DAY.test(day)) {
    return "unknown";
  }
  const filter = { start_date: day, end_date: day };
  const [rows, incomingIds] = await Promise.all([
    client.getAllPages<Transaction>("/v1/transactions", filter),
    loadIncomingIds(client, filter),
  ]);
  if (incomingIds.has(id)) {
    return "incoming";
  }
  return rows.some((row) => row.id === id) ? "outgoing" : "unknown";
}

export function toolTypeForDirection(direction: TransactionDirection): ToolTransactionType {
  return direction === "incoming" ? "C" : "D";
}
