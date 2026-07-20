import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type { Client } from "../types/clients.js";
import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import type { Transaction } from "../types/transaction.js";
import {
  optionalPositiveInt,
  optionalString,
  optionalYmd,
  parseToolArgs,
} from "../validation/tool-args.js";

const reconciliationReportSchema = z.object({
  start_date: optionalYmd,
  end_date: optionalYmd,
});

const matchTransactionSchema = z.object({
  transaction_id: optionalPositiveInt,
  description: optionalString,
});

const financialSummarySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM")
    .optional(),
});

/**
 * Live API invoices carry `gross_price`; `total_amount` is a legacy alias
 * some fixtures/integrations still use. Never returns NaN (missing fields
 * used to produce `null` totals in JSON output via `sum + undefined`).
 */
function invoiceAmount(i: { gross_price?: number | null; total_amount?: number }): number {
  return i.gross_price ?? i.total_amount ?? 0;
}

function invoiceDateOf(i: {
  invoice_date?: string;
  journal_date?: string | null;
  create_date?: string | null;
}): string | undefined {
  return i.invoice_date ?? i.journal_date ?? i.create_date ?? undefined;
}

/** Round currency sums to cents; float addition otherwise leaks artifacts like 15280.699999999999. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Live invoices have no `due_date`; derive it from `create_date` + `term_days`. */
function invoiceDueDate(i: {
  due_date?: string;
  create_date?: string | null;
  term_days?: number | null;
}): string | undefined {
  if (i.due_date) {
    return i.due_date;
  }
  if (i.create_date && typeof i.term_days === "number") {
    const due = new Date(i.create_date);
    due.setUTCDate(due.getUTCDate() + i.term_days);
    return due.toISOString().split("T")[0];
  }
  return undefined;
}

export function createReportTools(client: EFinancialsClient) {
  return {
    reconciliation_report: {
      description:
        "Generate a reconciliation report comparing bank transactions with invoices. Helps identify unmatched items.",
      inputSchema: {
        type: "object" as const,
        properties: {
          start_date: {
            type: "string",
            description: "Start date for the report (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "End date for the report (YYYY-MM-DD)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(reconciliationReportSchema, params);
        // Fetch all relevant data
        const [transactionsRes, salesRes, purchaseRes] = await Promise.all([
          client.get<Transaction>("/v1/transactions", {
            start_date: args.start_date,
            end_date: args.end_date,
          }),
          client.get<SalesInvoice>("/v1/sale_invoices", {
            start_date: args.start_date,
            end_date: args.end_date,
          }),
          client.get<PurchaseInvoice>("/v1/purchase_invoices", {
            start_date: args.start_date,
            end_date: args.end_date,
          }),
        ]);

        const transactions = transactionsRes.items || [];
        const salesInvoices = salesRes.items || [];
        const purchaseInvoices = purchaseRes.items || [];

        // Categorize transactions
        const unassignedTransactions = transactions.filter(
          (t) => !t.clients_id && t.status === "PROJECT",
        );
        const creditTransactions = transactions.filter((t) => t.type === "C");
        const debitTransactions = transactions.filter((t) => t.type === "D");

        // Calculate totals
        const totalCredits = round2(creditTransactions.reduce((sum, t) => sum + t.amount, 0));
        const totalDebits = round2(debitTransactions.reduce((sum, t) => sum + t.amount, 0));

        const unpaidSalesInvoices = salesInvoices.filter((i) => i.payment_status === "NOT_PAID");
        const unpaidPurchaseInvoices = purchaseInvoices.filter(
          (i) => i.payment_status === "NOT_PAID",
        );

        const totalUnpaidReceivables = round2(
          unpaidSalesInvoices.reduce((sum, i) => sum + invoiceAmount(i), 0),
        );
        const totalUnpaidPayables = round2(
          unpaidPurchaseInvoices.reduce((sum, i) => sum + invoiceAmount(i), 0),
        );

        const report = {
          period: {
            from: args.start_date || "all time",
            to: args.end_date || "now",
          },
          transactions: {
            total: transactions.length,
            unassigned: unassignedTransactions.length,
            credits: {
              count: creditTransactions.length,
              total: totalCredits,
            },
            debits: {
              count: debitTransactions.length,
              total: totalDebits,
            },
          },
          invoices: {
            sales: {
              total: salesInvoices.length,
              unpaid: unpaidSalesInvoices.length,
              unpaid_amount: totalUnpaidReceivables,
            },
            purchase: {
              total: purchaseInvoices.length,
              unpaid: unpaidPurchaseInvoices.length,
              unpaid_amount: totalUnpaidPayables,
            },
          },
          action_items: {
            transactions_to_categorize: unassignedTransactions.map((t) => ({
              id: t.id,
              date: t.date,
              amount: t.amount,
              type: t.type,
              description: t.description,
            })),
            invoices_to_collect: unpaidSalesInvoices.map((i) => ({
              id: i.id,
              invoice_no: i.number ?? i.invoice_no,
              client: i.client_name,
              amount: invoiceAmount(i),
              due_date: invoiceDueDate(i),
            })),
            invoices_to_pay: unpaidPurchaseInvoices.map((i) => ({
              id: i.id,
              invoice_no: i.number ?? i.invoice_no,
              supplier: i.supplier_name ?? i.client_name,
              amount: invoiceAmount(i),
              due_date: invoiceDueDate(i),
            })),
          },
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      },
    },

    match_transaction_to_supplier: {
      description:
        "Analyze a transaction description and suggest matching suppliers from the client list.",
      inputSchema: {
        type: "object" as const,
        properties: {
          transaction_id: {
            type: "number",
            description: "Transaction ID to analyze",
          },
          description: {
            type: "string",
            description: "Transaction description to match (if not providing transaction_id)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(matchTransactionSchema, params);
        let description = args.description;

        // Get transaction if ID provided
        if (args.transaction_id) {
          const txnRes = await client.get<Transaction>(`/v1/transactions/${args.transaction_id}`);
          const txn = txnRes as unknown as Transaction;
          description = txn.description;
        }

        if (!description) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "Please provide either transaction_id or description",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Get all suppliers
        const suppliersRes = await client.get<Client>("/v1/clients", {
          is_supplier: true,
        });
        const suppliers = suppliersRes.items || [];

        // Simple matching - find suppliers whose name appears in the description
        const descLower = description.toLowerCase();
        const matches = suppliers
          .map((s) => {
            const nameParts = s.name.toLowerCase().split(/\s+/);
            const matchScore = nameParts.filter((part) => descLower.includes(part)).length;
            return { supplier: s, score: matchScore };
          })
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  transaction_id: args.transaction_id,
                  description,
                  suggested_suppliers: matches.map((m) => ({
                    id: m.supplier.id,
                    name: m.supplier.name,
                    match_score: m.score,
                  })),
                  note:
                    matches.length === 0
                      ? "No matching suppliers found. You may need to create a new supplier."
                      : "Suppliers are ranked by how many words from their name appear in the transaction description.",
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    financial_summary: {
      description:
        "Get a summary of financial data including transaction counts, invoice totals, and outstanding amounts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          month: {
            type: "string",
            description: "Month to summarize (YYYY-MM format). Defaults to current month.",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(financialSummarySchema, params);
        // Calculate date range for the month
        const now = new Date();
        let year = now.getFullYear();
        let month = now.getMonth();

        if (args.month) {
          const [y, m] = args.month.split("-").map(Number);
          year = y;
          month = m - 1;
        }

        // UTC date math: local-time Date + toISOString() shifts the range by a
        // day for any process timezone east of UTC.
        const startDate = new Date(Date.UTC(year, month, 1)).toISOString().split("T")[0];
        const endDate = new Date(Date.UTC(year, month + 1, 0)).toISOString().split("T")[0];

        const [transactionsRes, salesRes, purchaseRes] = await Promise.all([
          client.get<Transaction>("/v1/transactions", {
            start_date: startDate,
            end_date: endDate,
          }),
          client.get<SalesInvoice>("/v1/sale_invoices", {
            start_date: startDate,
            end_date: endDate,
          }),
          client.get<PurchaseInvoice>("/v1/purchase_invoices", {
            start_date: startDate,
            end_date: endDate,
          }),
        ]);

        const transactions = transactionsRes.items || [];
        const salesInvoices = salesRes.items || [];
        const purchaseInvoices = purchaseRes.items || [];

        const income = round2(
          transactions.filter((t) => t.type === "C").reduce((sum, t) => sum + t.amount, 0),
        );

        const expenses = round2(
          transactions.filter((t) => t.type === "D").reduce((sum, t) => sum + t.amount, 0),
        );

        const invoicedSales = round2(salesInvoices.reduce((sum, i) => sum + invoiceAmount(i), 0));

        const invoicedPurchases = round2(
          purchaseInvoices
            .filter((i) => {
              const dateStr = invoiceDateOf(i);
              if (!dateStr) {
                // No usable date on the item: trust the API-side range filter.
                return true;
              }
              const invoiceDate = new Date(dateStr);
              return invoiceDate >= new Date(startDate) && invoiceDate <= new Date(endDate);
            })
            .reduce((sum, i) => sum + invoiceAmount(i), 0),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  period: {
                    month: args.month || `${year}-${String(month + 1).padStart(2, "0")}`,
                    from: startDate,
                    to: endDate,
                  },
                  bank_transactions: {
                    income,
                    expenses,
                    net: round2(income - expenses),
                    transaction_count: transactions.length,
                    unprocessed: transactions.filter((t) => t.status === "PROJECT" && !t.clients_id)
                      .length,
                  },
                  invoices: {
                    sales_invoiced: invoicedSales,
                    purchases_invoiced: invoicedPurchases,
                    sales_invoice_count: salesInvoices.length,
                    purchase_invoice_count: purchaseInvoices.length,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },
  };
}
