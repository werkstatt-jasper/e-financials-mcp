import { z } from "zod";
import {
  categorizeTransactionGroup,
  defaultBankFeeSuggestion,
  groupTransactions,
  resolveApplyMode,
  type TransactionGroup,
} from "../banking/classify.js";
import { errorMessage } from "../banking/errors.js";
import {
  buildInvoiceIndexes,
  buildOpenInvoicePool,
  candidateInvoicesForTransaction,
  rankInvoiceMatches,
} from "../banking/invoice-index.js";
import { suggestBookingFromHistory } from "../banking/supplier-history.js";
import type { EFinancialsClient } from "../client.js";
import { createPurchaseInvoiceWithRepair } from "../invoices/create-purchase-invoice.js";
import { registerPurchaseInvoiceWithRepair } from "../invoices/register-purchase-invoice.js";
import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import type { Transaction } from "../types/transaction.js";
import { optionalPositiveInt, optionalYmd, parseToolArgs } from "../validation/tool-args.js";

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function isProjectTransaction(t: Transaction): boolean {
  return t.status === "PROJECT" && !t.is_deleted;
}

async function loadProjectTransactions(
  client: EFinancialsClient,
  opts: {
    accounts_dimensions_id?: number;
    start_date?: string;
    end_date?: string;
  },
): Promise<Transaction[]> {
  const all = await client.getAllPages<Transaction>("/v1/transactions", {
    status: "PROJECT",
    start_date: opts.start_date,
    end_date: opts.end_date,
  });
  return all.filter((t) => {
    if (!isProjectTransaction(t)) {
      return false;
    }
    if (
      opts.accounts_dimensions_id != null &&
      t.accounts_dimensions_id !== opts.accounts_dimensions_id
    ) {
      return false;
    }
    return true;
  });
}

const classifySchema = z.object({
  mode: z.enum(["classify", "dry_run_apply", "execute_apply"]).optional(),
  accounts_dimensions_id: optionalPositiveInt,
  start_date: optionalYmd,
  end_date: optionalYmd,
  invoice_match_threshold: z.coerce.number().min(0).max(100).optional(),
  groups: z.array(z.unknown()).optional(),
});

function amountsAreSimilar(txs: Transaction[]): boolean {
  if (txs.length < 2) {
    return false;
  }
  const amounts = txs.map((t) => Math.abs(t.amount));
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const tol = Math.max(2, avg * 0.05);
  return amounts.every((a) => Math.abs(a - avg) <= tol);
}

function bookingDescription(group: ApplyGroupInput, tx: Transaction): string {
  const trimmed = tx.description.trim();
  if (trimmed) {
    return trimmed;
  }
  const category = group.category ?? "purchase";
  const counterparty = group.counterparty ?? "";
  return `${category} ${counterparty}`.trim();
}

function bookingClientName(
  group: ApplyGroupInput,
  booking: NonNullable<ApplyGroupInput["suggested_booking"]>,
): string {
  return booking.client_name ?? group.counterparty ?? "Supplier";
}

type ApplyGroupInput = {
  counterparty?: string;
  category?: string;
  apply_mode?: string;
  transaction_ids?: number[];
  suggested_booking?: {
    clients_id?: number;
    client_name?: string;
    purchase_article_id?: number;
    purchase_accounts_dimensions_id?: number;
    vat_rate?: number;
    vat_amount?: number;
    vat_accounts_id?: number;
  } | null;
};

async function buildClassifyGroups(
  client: EFinancialsClient,
  args: {
    accounts_dimensions_id?: number;
    start_date?: string;
    end_date?: string;
    invoice_match_threshold?: number;
  },
): Promise<{ groups: TransactionGroup[]; excluded_invoice_matches: number }> {
  const threshold = args.invoice_match_threshold ?? 70;
  const projectTxs = await loadProjectTransactions(client, args);
  const [sales, purchases] = await Promise.all([
    client.getAllPages<SalesInvoice>("/v1/sale_invoices"),
    client.getAllPages<PurchaseInvoice>("/v1/purchase_invoices"),
  ]);
  const indexes = buildInvoiceIndexes(buildOpenInvoicePool(sales, purchases));

  const unmatched: Transaction[] = [];
  let excluded = 0;
  for (const tx of projectTxs) {
    const ranked = rankInvoiceMatches(tx, candidateInvoicesForTransaction(tx, indexes), threshold);
    if (ranked.best) {
      excluded += 1;
      continue;
    }
    unmatched.push(tx);
  }

  const grouped = groupTransactions(unmatched);
  const groups: TransactionGroup[] = [];

  for (const [counterparty, txs] of grouped) {
    const { category, apply_mode: baseMode } = categorizeTransactionGroup(counterparty, txs);
    let suggestion = suggestBookingFromHistory(
      counterparty,
      txs.find((t) => t.clients_id != null)?.clients_id,
      purchases,
    );
    if (category === "bank_fees" && !suggestion) {
      const clientsId = txs.find((t) => t.clients_id != null)?.clients_id ?? null;
      suggestion = defaultBankFeeSuggestion(counterparty, clientsId);
    }
    const applyMode = resolveApplyMode(category, baseMode, suggestion);
    groups.push({
      counterparty,
      category,
      apply_mode: applyMode,
      recurring: txs.length >= 2,
      similar_amounts: amountsAreSimilar(txs),
      transaction_ids: txs.map((t) => t.id),
      transactions: txs.map((t) => ({
        id: t.id,
        date: t.date,
        amount: t.amount,
        type: t.type,
        description: t.description,
        clients_id: t.clients_id,
      })),
      suggested_booking: suggestion,
    });
  }

  groups.sort((a, b) => a.counterparty.localeCompare(b.counterparty));
  return { groups, excluded_invoice_matches: excluded };
}

async function applyGroups(
  client: EFinancialsClient,
  groups: ApplyGroupInput[],
  execute: boolean,
): Promise<{
  mode: string;
  summary: Record<string, number>;
  results: unknown[];
  errors: unknown[];
}> {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  let wouldBook = 0;
  let booked = 0;
  let skipped = 0;

  for (const group of groups) {
    if (group.apply_mode !== "purchase_invoice") {
      skipped += 1;
      errors.push({
        counterparty: group.counterparty,
        reason: "review_only",
      });
      continue;
    }
    const booking = group.suggested_booking;
    if (booking?.purchase_article_id == null || booking.clients_id == null) {
      skipped += 1;
      errors.push({
        counterparty: group.counterparty,
        reason: "missing_booking_fields",
      });
      continue;
    }

    const txIds = group.transaction_ids ?? [];
    for (const txId of txIds) {
      let tx: Transaction;
      try {
        tx = (await client.get<Transaction>(`/v1/transactions/${txId}`)) as unknown as Transaction;
      } catch (err) {
        errors.push({
          transaction_id: txId,
          reason: "fetch_failed",
          message: errorMessage(err),
        });
        continue;
      }

      if (tx.is_deleted || tx.status === "VOID" || tx.status === "CONFIRMED") {
        skipped += 1;
        errors.push({
          transaction_id: txId,
          reason: "stale_or_confirmed",
          status: tx.status,
        });
        continue;
      }
      if (tx.status !== "PROJECT") {
        skipped += 1;
        errors.push({
          transaction_id: txId,
          reason: "not_project",
          status: tx.status,
        });
        continue;
      }

      const currency = tx.cl_currencies_id || "EUR";
      if (currency !== "EUR" && (tx.currency_rate == null || tx.currency_rate <= 0)) {
        skipped += 1;
        errors.push({
          transaction_id: txId,
          reason: "currency_rate_required",
          currency,
        });
        continue;
      }

      const amount = Math.abs(tx.amount);
      const vatAmount = booking.vat_amount ?? 0;
      const vatRate = booking.vat_rate ?? 0;
      const invoiceNo = `BANK-${tx.id}-${tx.date}`;
      const description = bookingDescription(group, tx);
      const createInput = {
        clients_id: booking.clients_id as number,
        client_name: bookingClientName(group, booking),
        invoice_no: invoiceNo,
        invoice_date: tx.date,
        term_days: 0,
        total_amount: amount,
        vat_amount: vatAmount,
        cl_currencies_id: currency,
        ...(typeof tx.currency_rate === "number" && tx.currency_rate > 0
          ? { currency_rate: tx.currency_rate }
          : {}),
        description,
        purchase_article_id: booking.purchase_article_id,
        purchase_accounts_dimensions_id: booking.purchase_accounts_dimensions_id,
        vat_rate: vatRate,
        vat_accounts_id: booking.vat_accounts_id,
        explicit_totals: true,
      };

      if (!execute) {
        wouldBook += 1;
        results.push({
          status: "would_book",
          transaction_id: txId,
          purchase_invoice: {
            clients_id: booking.clients_id,
            client_name: bookingClientName(group, booking),
            invoice_no: invoiceNo,
            total_amount: amount,
            vat_amount: vatAmount,
            purchase_article_id: booking.purchase_article_id,
          },
          distribution: {
            related_table: "purchase_invoices",
            related_id: null,
            amount,
          },
        });
        continue;
      }

      let invoiceId: number | undefined;
      try {
        const created = await createPurchaseInvoiceWithRepair(client, createInput);
        invoiceId = created.id;
        await registerPurchaseInvoiceWithRepair(client, {
          id: invoiceId,
          preserve_existing_totals: true,
        });

        // Re-check txn before confirm (stale race)
        const fresh = (await client.get<Transaction>(
          `/v1/transactions/${txId}`,
        )) as unknown as Transaction;
        if (fresh.is_deleted || fresh.status !== "PROJECT") {
          await client.patch(`/v1/purchase_invoices/${invoiceId}/invalidate`);
          errors.push({
            transaction_id: txId,
            reason: "stale_after_invoice_create",
            purchase_invoice_id: invoiceId,
            invalidated: true,
          });
          continue;
        }

        if (!fresh.clients_id) {
          await client.patch(`/v1/transactions/${txId}`, {
            clients_id: booking.clients_id,
          });
        }
        await client.patch(`/v1/transactions/${txId}/register`, [
          {
            related_table: "purchase_invoices",
            related_id: invoiceId,
            amount,
          },
        ]);
        booked += 1;
        results.push({
          status: "booked",
          transaction_id: txId,
          purchase_invoice_id: invoiceId,
        });
      } catch (err) {
        if (invoiceId != null) {
          try {
            await client.patch(`/v1/purchase_invoices/${invoiceId}/invalidate`);
          } catch {
            // best-effort cleanup
          }
        }
        errors.push({
          transaction_id: txId,
          reason: "apply_failed",
          message: errorMessage(err),
          purchase_invoice_id: invoiceId,
        });
      }
    }
  }

  return {
    mode: execute ? "EXECUTED" : "DRY_RUN",
    summary: {
      would_book: wouldBook,
      booked,
      skipped,
      errors: errors.length,
    },
    results,
    errors,
  };
}

export function createClassifyBankTools(client: EFinancialsClient) {
  return {
    classify_bank_transactions: {
      description:
        "Classify unmatched PROJECT bank transactions by counterparty (bank fees, SaaS, card purchases, tax, owner transfers, salary, revenue, unknown). Modes: classify (default), dry_run_apply (preview purchase-invoice booking), execute_apply (create+register PI then register_transaction). Auto-apply only with concrete supplier-history (or bank-fee defaults); never invents VAT. Tax/owner/salary/revenue stay review_only. Pro tier.",
      inputSchema: {
        type: "object" as const,
        properties: {
          mode: {
            type: "string",
            enum: ["classify", "dry_run_apply", "execute_apply"],
            description: "classify | dry_run_apply | execute_apply (default classify)",
          },
          accounts_dimensions_id: {
            type: "number",
            description: "Optional bank dimension filter",
          },
          start_date: { type: "string", description: "YYYY-MM-DD" },
          end_date: { type: "string", description: "YYYY-MM-DD" },
          invoice_match_threshold: {
            type: "number",
            description: "Exclude txs with invoice match ≥ this score (default 70)",
          },
          groups: {
            type: "array",
            description:
              "For dry_run_apply/execute_apply: groups from a prior classify result (optional; re-classifies when omitted)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(classifySchema, params);
        const mode = args.mode ?? "classify";

        if (mode === "classify") {
          const { groups, excluded_invoice_matches } = await buildClassifyGroups(client, args);
          const byCategory: Record<string, number> = {};
          for (const g of groups) {
            byCategory[g.category] = (byCategory[g.category] ?? 0) + 1;
          }
          return toolResult({
            mode: "classify",
            summary: {
              groups: groups.length,
              excluded_invoice_matches,
              by_category: byCategory,
              applyable: groups.filter((g) => g.apply_mode === "purchase_invoice").length,
              review_only: groups.filter((g) => g.apply_mode === "review_only").length,
            },
            groups,
          });
        }

        let groups = (args.groups ?? []) as ApplyGroupInput[];
        if (groups.length === 0) {
          const built = await buildClassifyGroups(client, args);
          groups = built.groups;
        }

        return toolResult(await applyGroups(client, groups, mode === "execute_apply"));
      },
    },
  };
}
