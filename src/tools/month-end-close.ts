import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import {
  type AgingInvoiceRow,
  type AgingResult,
  computeAging,
  effectiveGross,
} from "../financial-statements/aging.js";
import {
  fetchAllJournalListPages,
  JournalListTruncatedError,
} from "../financial-statements/load-journals.js";
import { roundMoney } from "../money.js";
import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import type { Journal } from "../types/journal.js";
import type { Transaction } from "../types/transaction.js";
import { parseToolArgs } from "../validation/tool-args.js";

const monthEndCloseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM"),
});

const OVERDUE_ITEM_CAP = 10;

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Expand YYYY-MM to inclusive [dateFrom, dateTo] using UTC calendar math. */
export function monthToDateRange(month: string): { dateFrom: string; dateTo: string } {
  const [y, m] = month.split("-").map(Number);
  const dateFrom = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const dateTo = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { dateFrom, dateTo };
}

function inRange(ymd: string | null | undefined, dateFrom: string, dateTo: string): boolean {
  if (ymd == null || ymd === "") {
    return false;
  }
  return ymd >= dateFrom && ymd <= dateTo;
}

function overdueFromAging(aging: AgingResult): {
  count: number;
  total: number;
  items: Array<{
    id: number;
    number: string | null;
    client: string | null;
    gross: number;
    payment_status: string | null;
    days_overdue: number;
  }>;
} {
  const rows: AgingInvoiceRow[] = [];
  for (const bucket of aging.aging_buckets) {
    if (bucket.label === "current") {
      continue;
    }
    // Bucket invoices are capped at 10 internally; re-aggregate count/total from bucket totals.
    rows.push(...bucket.invoices);
  }
  // Prefer full counts/totals from buckets (not the per-bucket item cap).
  let count = 0;
  let total = 0;
  for (const bucket of aging.aging_buckets) {
    if (bucket.label === "current") {
      continue;
    }
    count += bucket.count;
    total = roundMoney(total + bucket.total);
  }
  // Flatten capped samples for host follow-up; keep highest-amount first across buckets.
  const items = [...rows]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, OVERDUE_ITEM_CAP)
    .map((r) => ({
      id: r.id,
      number: r.number,
      client: r.client,
      gross: r.amount,
      payment_status: r.payment_status,
      days_overdue: r.days_overdue,
    }));
  return { count, total, items };
}

function invoiceItem(inv: SalesInvoice | PurchaseInvoice) {
  const { amount } = effectiveGross(inv);
  return {
    id: inv.id,
    number: inv.number ?? null,
    client: inv.client_name ?? null,
    gross: roundMoney(amount),
    payment_status: inv.payment_status ?? "NOT_PAID",
  };
}

/**
 * Read-only month-end close checklist: unconfirmed journals/invoices/bank txs
 * plus overdue receivables/payables as of month-end.
 */
export function createMonthEndCloseTools(client: EFinancialsClient) {
  return {
    month_end_close_checklist: {
      description:
        "Surfaces everything blocking a month-end close for a YYYY-MM month. Sections: unconfirmed (PROJECT) journals, sale invoices, purchase invoices; unconfirmed bank transactions; overdue receivables/payables (confirmed unpaid with due date before month-end). Returns counts + entity IDs for follow-up tool calls. ready_to_close is true only when unconfirmed sections are empty (overdue does not block). Free-tier read-only tool.",
      inputSchema: {
        type: "object" as const,
        properties: {
          month: {
            type: "string",
            description: "Close month as YYYY-MM (e.g. 2025-06)",
          },
        },
        required: ["month"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(monthEndCloseSchema, params);
        const { dateFrom, dateTo } = monthToDateRange(args.month);

        try {
          const [journals, transactions, sales, purchases] = await Promise.all([
            fetchAllJournalListPages(client, {
              start_date: dateFrom,
              end_date: dateTo,
            }),
            client.getAllPages<Transaction>("/v1/transactions", {
              status: "PROJECT",
              start_date: dateFrom,
              end_date: dateTo,
            }),
            client.getAllPages<SalesInvoice>("/v1/sale_invoices"),
            client.getAllPages<PurchaseInvoice>("/v1/purchase_invoices"),
          ]);

          const unconfirmedJournals = journals
            .filter(
              (j: Journal) =>
                j.is_deleted !== true &&
                j.registered !== true &&
                inRange(j.effective_date, dateFrom, dateTo),
            )
            .map((j) => ({
              id: j.id ?? null,
              date: j.effective_date,
              title: j.title ?? null,
            }));

          const unconfirmedTransactions = transactions
            .filter(
              (t) => t.status === "PROJECT" && !t.is_deleted && inRange(t.date, dateFrom, dateTo),
            )
            .map((t) => ({
              id: t.id,
              date: t.date,
              amount: t.base_amount ?? t.amount,
              description: t.description ?? null,
            }));

          const unconfirmedSales = sales
            .filter(
              (inv) => inv.status === "PROJECT" && inRange(inv.journal_date, dateFrom, dateTo),
            )
            .map(invoiceItem);

          const unconfirmedPurchases = purchases
            .filter(
              (inv) => inv.status === "PROJECT" && inRange(inv.journal_date, dateFrom, dateTo),
            )
            .map(invoiceItem);

          const receivablesAging = computeAging(sales, dateTo);
          const payablesAging = computeAging(purchases, dateTo);
          const overdueReceivables = overdueFromAging(receivablesAging);
          const overduePayables = overdueFromAging(payablesAging);

          const warnings = [...receivablesAging.warnings, ...payablesAging.warnings].filter(
            (w, i, arr) => arr.indexOf(w) === i,
          );

          const unconfirmedCount =
            unconfirmedJournals.length +
            unconfirmedTransactions.length +
            unconfirmedSales.length +
            unconfirmedPurchases.length;
          const issuesFound = unconfirmedCount + overdueReceivables.count + overduePayables.count;

          return jsonResult({
            month: args.month,
            period: { from: dateFrom, to: dateTo },
            unconfirmed_journals: {
              count: unconfirmedJournals.length,
              items: unconfirmedJournals,
            },
            unconfirmed_transactions: {
              count: unconfirmedTransactions.length,
              items: unconfirmedTransactions,
            },
            unconfirmed_sale_invoices: {
              count: unconfirmedSales.length,
              items: unconfirmedSales,
            },
            unconfirmed_purchase_invoices: {
              count: unconfirmedPurchases.length,
              items: unconfirmedPurchases,
            },
            overdue_receivables: overdueReceivables,
            overdue_payables: overduePayables,
            summary: {
              issues_found: issuesFound,
              ready_to_close: unconfirmedCount === 0,
            },
            warnings,
          });
        } catch (err) {
          if (err instanceof JournalListTruncatedError) {
            return jsonResult({
              error: err.code,
              message: err.message,
              month: args.month,
              period: { from: dateFrom, to: dateTo },
            });
          }
          throw err;
        }
      },
    },
  };
}
