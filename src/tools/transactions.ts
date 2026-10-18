import { z } from "zod";
import { createVerifiedTransaction } from "../banking/create-verified-transaction.js";
import { errorMessage } from "../banking/errors.js";
import {
  getIncomingPage,
  labelFetchedRows,
  loadLabelledTransactions,
  pageOf,
  type StoredDirection,
  storedDirection,
  type TransactionListFilter,
  type TransactionPage,
  toolTypeForDirection,
} from "../banking/stored-direction.js";
import {
  directionFromToolType,
  reportedMessages,
  rikMessages,
  rikTypeForToolType,
} from "../banking/transaction-direction.js";
import type { EFinancialsClient } from "../client.js";
import { roundMoney } from "../money.js";
import { resolveFileInput } from "../resolve-file-input.js";
import type { PurchaseInvoice } from "../types/invoice.js";
import type { ApiFile } from "../types/journal.js";
import type {
  CreateTransactionParams,
  ListTransactionsParams,
  Transaction,
  TransactionDistributionRow,
  UpdateTransactionParams,
} from "../types/transaction.js";
import {
  creditDebitEnum,
  optionalBoolean,
  optionalNumber,
  optionalPage,
  optionalPositiveInt,
  optionalString,
  optionalYmd,
  parseToolArgs,
  positiveInt,
  transactionStatusEnum,
  ymdDateString,
} from "../validation/tool-args.js";

const listTransactionsSchema = z.object({
  status: transactionStatusEnum.optional(),
  modified_since: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  start_date: optionalYmd,
  end_date: optionalYmd,
  type: creditDebitEnum.optional(),
  clients_id: optionalPositiveInt,
  page: optionalPage,
});

const transactionIdSchema = z.object({ id: positiveInt });

const unprocessedTransactionsSchema = z.object({
  type: creditDebitEnum.optional(),
  start_date: optionalYmd,
  end_date: optionalYmd,
});

const updateTransactionSchema = z.object({
  id: positiveInt,
  clients_id: optionalPositiveInt,
  accounts_id: optionalPositiveInt,
  description: optionalString,
  type: creditDebitEnum.optional(),
});

const payPurchaseInvoiceSchema = z.object({
  purchase_invoices_id: positiveInt,
  accounts_dimensions_id: positiveInt,
  date: ymdDateString,
  amount: optionalNumber,
  description: optionalString,
  currency_rate: optionalNumber,
  allow_duplicate: optionalBoolean,
});

function samePaymentAmount(value: unknown, amount: number): boolean {
  return typeof value === "number" && roundMoney(value) === roundMoney(amount);
}

/** Supplier drafts with this amount, and this invoice's confirmed payments of this amount on this date. */
async function findPossibleDuplicatePayments(
  client: EFinancialsClient,
  invoice: PurchaseInvoice,
  amount: number,
  date: string,
): Promise<Transaction[]> {
  const drafts = (
    await client.getAllPages<Transaction>("/v1/transactions", {
      status: "PROJECT",
      clients_id: invoice.clients_id,
    })
  ).filter(
    (tx) =>
      tx.status === "PROJECT" &&
      tx.clients_id === invoice.clients_id &&
      samePaymentAmount(tx.amount, amount),
  );
  const confirmed: Transaction[] = [];
  for (const id of Array.isArray(invoice.transactions) ? invoice.transactions : []) {
    const tx = (await client.get(`/v1/transactions/${id}`)) as Transaction;
    if (
      tx.status === "CONFIRMED" &&
      String(tx.date).slice(0, 10) === date &&
      samePaymentAmount(tx.amount, amount)
    ) {
      confirmed.push(tx);
    }
  }
  return [...drafts, ...confirmed];
}

const createTransactionSchema = z.object({
  accounts_dimensions_id: positiveInt,
  type: creditDebitEnum,
  amount: z.coerce.number(),
  cl_currencies_id: z.string().min(1),
  date: ymdDateString,
  clients_id: optionalPositiveInt,
  description: optionalString,
  ref_number: optionalString,
  bank_account_name: optionalString,
  base_amount: optionalNumber,
  currency_rate: optionalNumber,
  transactions_files_id: optionalPositiveInt,
  export_format: optionalString,
});

const distributionRowSchema = z.object({
  related_table: z.string().min(1),
  amount: z.coerce.number(),
  related_id: optionalPositiveInt,
  related_sub_id: optionalPositiveInt,
});

const registerTransactionSchema = z.object({
  id: positiveInt,
  distributions: z.array(distributionRowSchema),
});

const uploadTransactionFileSchema = z.object({
  id: positiveInt,
  file_path: z.string().min(1),
  filename: optionalString,
});

export function createTransactionTools(client: EFinancialsClient) {
  return {
    list_transactions: {
      description:
        "List bank transactions with optional filters. Returns transactions from the e-Financials system.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: ["PROJECT", "CONFIRMED", "VOID"],
            description: "Filter by status (PROJECT = draft, CONFIRMED = registered)",
          },
          modified_since: {
            type: "string",
            description: "Filter by modification date (ISO format: 2024-01-15T00:00:00)",
          },
          start_date: {
            type: "string",
            description: "Filter transactions from this date (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "Filter transactions up to this date (YYYY-MM-DD)",
          },
          type: {
            type: "string",
            enum: ["C", "D"],
            description:
              "Filter by direction: C = money in, D = money out. Every returned row's type is its stored direction in the same convention (RIK's own GET type field is always C). D is filtered and paged locally, 100 rows per page.",
          },
          clients_id: {
            type: "number",
            description: "Filter by client/supplier ID",
          },
          page: {
            type: "number",
            description: "Page number for pagination (default: 1)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(listTransactionsSchema, params) as ListTransactionsParams;
        const filter: TransactionListFilter = {
          status: args.status,
          modified_since: args.modified_since,
          start_date: args.start_date,
          end_date: args.end_date,
          clients_id: args.clients_id,
        };
        let page: TransactionPage;
        if (args.type === "C") {
          page = await getIncomingPage(client, filter, args.page);
        } else if (args.type === "D") {
          const outgoing = (await loadLabelledTransactions(client, filter)).filter(
            (t) => t.type === "D",
          );
          page = pageOf(outgoing, args.page ?? 1);
        } else {
          const response = await client.get<Transaction>("/v1/transactions", {
            ...filter,
            page: args.page,
          });
          page = {
            items: await labelFetchedRows(client, response.items || [], filter),
            current_page: response.current_page || 1,
            total_pages: response.total_pages || 1,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(page, null, 2),
            },
          ],
        };
      },
    },

    get_transaction: {
      description:
        "Get a bank transaction by ID. The returned type is the stored direction (C = money in, D = money out). RIK's own GET type field is always C, so the direction comes from that day's lists: incoming when the row is in the incoming filter, outgoing when it is only in the unfiltered list. When it is in neither, or the row has no valid date, type is null and direction_confirmed is false. The JSON may include read-only items[] relation rows (relation_table, relation_id, amount, accounts_id). To add relations and confirm, use register_transaction with a full distributions array — the API does not support incremental draft rows.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Transaction ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(transactionIdSchema, params);
        const response = (await client.get(`/v1/transactions/${args.id}`)) as Transaction;
        const direction = await storedDirection(client, args.id, response.date);
        const type = direction === "unknown" ? null : toolTypeForDirection(direction);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...response, type, direction_confirmed: type != null },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    get_unprocessed_transactions: {
      description:
        "Get all unprocessed (PROJECT status) transactions that don't have a client assigned yet. These need categorization.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: ["C", "D"],
            description:
              "Filter by direction: C = money in, D = money out. Each row's type is its stored direction. If not specified, returns both.",
          },
          start_date: {
            type: "string",
            description: "Filter transactions from this date (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "Filter transactions up to this date (YYYY-MM-DD)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(unprocessedTransactionsSchema, params);
        const drafts = await loadLabelledTransactions(client, {
          status: "PROJECT",
          start_date: args.start_date,
          end_date: args.end_date,
        });
        const unprocessed = drafts.filter(
          (t) => (args.type === undefined || t.type === args.type) && !t.clients_id,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: unprocessed.length,
                  transactions: unprocessed,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    update_transaction: {
      description:
        "Update a PROJECT draft: clients_id, accounts_id, description, and optional type (C = money in, D = money out). type is translated to RIK's opposite letter, then the stored direction is checked. If RIK still stores the other direction, that is an error and the row is left as RIK saved it. If the row is not in that day's lists, it has no valid date, or the check itself fails, the update stands with direction_confirmed false. Does not add or change distribution/relation rows — that is register_transaction (e-arveldaja UI: Add a row under transaction relations, then Save and confirm). Set clients_id before register when missing; the API often rejects confirmation with buyer/supplier missing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Transaction ID to update",
          },
          clients_id: {
            type: "number",
            description: "Client/supplier ID to assign",
          },
          accounts_id: {
            type: "number",
            description: "Account ID from chart of accounts",
          },
          description: {
            type: "string",
            description: "Updated description",
          },
          type: {
            type: "string",
            enum: ["C", "D"],
            description:
              "Direction on a PROJECT draft: C = money in, D = money out. RIK stores the opposite letter; the stored direction is checked after the update. Unknown direction leaves the update in place with direction_confirmed false.",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updateTransactionSchema, params);
        const { id, type, ...updateData } = parsed as { id: number } & UpdateTransactionParams;
        const body: Record<string, string | number> = {};
        if (updateData.clients_id !== undefined) body.clients_id = updateData.clients_id;
        if (updateData.accounts_id !== undefined) body.accounts_id = updateData.accounts_id;
        if (updateData.description !== undefined) body.description = updateData.description;
        if (type !== undefined) body.type = rikTypeForToolType(type);
        const response = await client.patch<Transaction>(`/v1/transactions/${id}`, body);
        const messages = rikMessages(response);
        let stored: StoredDirection | undefined;
        if (type !== undefined) {
          try {
            const row = (await client.get(`/v1/transactions/${id}`)) as Transaction;
            stored = await storedDirection(client, id, row.date);
          } catch {
            stored = "unknown";
          }
          if (stored !== "unknown" && stored !== directionFromToolType(type)) {
            throw new Error(
              `Transaction ${id} was updated, but RIK still stores it as ${stored}, not type ${type} (${directionFromToolType(type)}).${reportedMessages(messages)}`,
            );
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Transaction ${id} updated`,
                  ...(type === undefined
                    ? {}
                    : {
                        type,
                        rik_messages: messages,
                        direction_confirmed: stored === directionFromToolType(type),
                      }),
                  response,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    create_transaction: {
      description:
        "Create a bank transaction draft (PROJECT). type C is money in and type D is money out. RIK stores the opposite letter (D incoming, C outgoing); this tool translates it and checks the stored direction. The result is the stored transaction with tool type, rik_messages, and direction_confirmed, not RIK's raw { code, messages, created_object_id }. If RIK stored the other direction, the draft is patched once and deleted if still wrong. If the row is not in that day's lists, or the check itself fails, the draft is kept with direction_confirmed false. Writable fields: accounts_dimensions_id, type, amount, cl_currencies_id, date (YYYY-MM-DD), and optional clients_id, description, ref_number, bank_account_name, base_amount, currency_rate, transactions_files_id, export_format. To pay a confirmed purchase invoice, use pay_purchase_invoice.",
      inputSchema: {
        type: "object" as const,
        properties: {
          accounts_dimensions_id: {
            type: "number",
            description: "Account dimension ID (OpenAPI required)",
          },
          type: {
            type: "string",
            enum: ["C", "D"],
            description:
              "C = money in, D = money out. RIK stores the opposite letter; the returned type is the direction you asked for. direction_confirmed is false when that day's lists do not show the row.",
          },
          amount: { type: "number", description: "Transaction amount" },
          cl_currencies_id: {
            type: "string",
            description: "ISO currency code (e.g. EUR)",
          },
          date: {
            type: "string",
            description: "Transaction date (YYYY-MM-DD)",
          },
          clients_id: {
            type: "number",
            description: "Optional buyer/supplier/employee ID",
          },
          description: {
            type: "string",
            description: "Optional description (max 150 chars per API)",
          },
          ref_number: {
            type: "string",
            description: "Optional reference number (max 20 chars per API)",
          },
          bank_account_name: {
            type: "string",
            description: "Optional remitter/beneficiary name (max 100 chars per API)",
          },
          base_amount: { type: "number", description: "Optional amount in base (EUR) currency" },
          currency_rate: { type: "number", description: "Optional exchange rate" },
          transactions_files_id: {
            type: "number",
            description: "Optional linked transaction file ID",
          },
          export_format: { type: "string", description: "Optional export format" },
        },
        required: ["accounts_dimensions_id", "type", "amount", "cl_currencies_id", "date"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(createTransactionSchema, params) as CreateTransactionParams;
        const body: Record<string, string | number> = {
          accounts_dimensions_id: args.accounts_dimensions_id,
          type: args.type,
          amount: args.amount,
          cl_currencies_id: args.cl_currencies_id,
          date: args.date,
        };
        if (args.clients_id !== undefined) body.clients_id = args.clients_id;
        if (args.description !== undefined) body.description = args.description;
        if (args.ref_number !== undefined) body.ref_number = args.ref_number;
        if (args.bank_account_name !== undefined) body.bank_account_name = args.bank_account_name;
        if (args.base_amount !== undefined) body.base_amount = args.base_amount;
        if (args.currency_rate !== undefined) body.currency_rate = args.currency_rate;
        if (args.transactions_files_id !== undefined) {
          body.transactions_files_id = args.transactions_files_id;
        }
        if (args.export_format !== undefined) body.export_format = args.export_format;

        const created = await createVerifiedTransaction(client, {
          ...body,
          type: args.type,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(created, null, 2),
            },
          ],
        };
      },
    },

    pay_purchase_invoice: {
      description:
        'Mark a CONFIRMED purchase invoice paid from a cash or bank dimension (for example account 1360, Arveldused aruandvate isikutega). Creates an outgoing transaction (type D, money out) and registers it against the invoice, which is the API form of the e-arveldaja posting "Ostuarve nr … tasumine". registered: true means the payment is registered; do not call again if the invoice could not be re-read. Amount defaults to the invoice gross price when the invoice is unpaid, and must not exceed that gross price. The API does not report the unpaid remainder, so a second partial payment can still exceed what remains. A PARTIALLY_PAID invoice requires amount. A non-EUR invoice sends currency_rate and a base_amount scaled from base_gross_price; pass currency_rate when the invoice has none. Refuses before any write when the supplier already has a PROJECT draft with the same amount, or the invoice already has a CONFIRMED payment with the same amount and date; pass allow_duplicate=true to pay anyway. When the stored direction cannot be confirmed as outgoing, the draft is kept but not registered (registered: false with its transaction_id). If registration fails, the draft is deleted.',
      inputSchema: {
        type: "object" as const,
        properties: {
          purchase_invoices_id: {
            type: "number",
            description: "CONFIRMED purchase invoice ID",
          },
          accounts_dimensions_id: {
            type: "number",
            description:
              "Cash or bank dimension the payment leaves from (account 1360's dimension, or a bank dimension)",
          },
          date: {
            type: "string",
            description: "Payment date (YYYY-MM-DD)",
          },
          amount: {
            type: "number",
            description:
              "Amount to pay. Defaults to the invoice gross price when the invoice is not partly paid. Required when payment_status is PARTIALLY_PAID.",
          },
          description: {
            type: "string",
            description:
              'Optional description. Defaults to "Ostuarve nr {number} tasumine" (max 150 characters).',
          },
          currency_rate: {
            type: "number",
            description:
              "Exchange rate to EUR. Required when the invoice is not in EUR and has no currency_rate of its own.",
          },
          allow_duplicate: {
            type: "boolean",
            description:
              "Pay even when a matching supplier draft or same-day payment of this invoice already exists.",
          },
        },
        required: ["purchase_invoices_id", "accounts_dimensions_id", "date"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(payPurchaseInvoiceSchema, params);
        const invoice = (await client.get(
          `/v1/purchase_invoices/${args.purchase_invoices_id}`,
        )) as PurchaseInvoice;
        const status = invoice.status as string | undefined;
        if (status !== "CONFIRMED") {
          throw new Error(
            `Purchase invoice ${args.purchase_invoices_id} is ${status ?? "unknown"}; only CONFIRMED invoices can be marked paid.`,
          );
        }
        const rawPaymentStatus = invoice.payment_status as string | null | undefined;
        const paymentStatus =
          rawPaymentStatus == null || rawPaymentStatus === "" ? "NOT_PAID" : rawPaymentStatus;
        if (paymentStatus === "PAID") {
          throw new Error(`Purchase invoice ${args.purchase_invoices_id} is already paid.`);
        }
        if (paymentStatus === "PARTIALLY_PAID" && args.amount === undefined) {
          throw new Error("amount is required when the purchase invoice is PARTIALLY_PAID.");
        }
        if (args.amount !== undefined && !(args.amount > 0)) {
          throw new Error("amount must be greater than 0.");
        }
        const amount = args.amount ?? invoice.gross_price;
        if (amount == null || !(amount > 0)) {
          throw new Error(
            "amount is required when the purchase invoice has no positive gross price.",
          );
        }
        if (
          invoice.gross_price != null &&
          invoice.gross_price > 0 &&
          amount > invoice.gross_price
        ) {
          throw new Error(
            `amount is greater than the invoice gross price (${invoice.gross_price}). The API does not report the unpaid remainder of a partly paid invoice.`,
          );
        }
        if (!invoice.clients_id) {
          throw new Error(`Purchase invoice ${args.purchase_invoices_id} has no supplier.`);
        }
        const number = invoice.number || invoice.invoice_no || String(args.purchase_invoices_id);
        const description = (args.description ?? `Ostuarve nr ${number} tasumine`).slice(0, 150);
        const currency = invoice.cl_currencies_id || "EUR";
        const payment: Record<string, string | number> = {
          accounts_dimensions_id: args.accounts_dimensions_id,
          type: "D",
          amount,
          cl_currencies_id: currency,
          date: args.date,
          clients_id: invoice.clients_id,
          description,
        };
        if (currency !== "EUR") {
          const invoiceRate = (invoice as { currency_rate?: number | null }).currency_rate;
          const rate =
            args.currency_rate ?? (typeof invoiceRate === "number" ? invoiceRate : undefined);
          if (rate == null || !(rate > 0)) {
            throw new Error("currency_rate is required when the purchase invoice is not in EUR.");
          }
          payment.currency_rate = rate;
          const gross = invoice.gross_price;
          const baseGross = invoice.base_gross_price;
          payment.base_amount =
            baseGross != null && gross != null && gross > 0
              ? roundMoney((baseGross * amount) / gross)
              : roundMoney(amount * rate);
        }
        if (!args.allow_duplicate) {
          const duplicates = await findPossibleDuplicatePayments(
            client,
            invoice,
            amount,
            args.date,
          );
          if (duplicates.length > 0) {
            const list = duplicates
              .map((tx) => `${tx.id} (${tx.status}, ${tx.date}, ${tx.amount})`)
              .join(", ");
            throw new Error(
              `Possible duplicate payment for purchase invoice ${args.purchase_invoices_id}: transaction ${list}. Register an existing draft with register_transaction, delete it with delete_transaction, or pass allow_duplicate=true to create another payment.`,
            );
          }
        }
        const created = await createVerifiedTransaction(client, {
          ...payment,
          type: "D",
        });
        if (!created.direction_confirmed) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    registered: false,
                    transaction_id: created.id,
                    message: `The stored direction of draft ${created.id} could not be confirmed as outgoing, so it was not registered against purchase invoice ${args.purchase_invoices_id}. Check in e-Financials that it is an outgoing payment, then register it with register_transaction, or delete it with delete_transaction.`,
                    type: created.type,
                    amount,
                    direction_confirmed: false,
                    payment_status: paymentStatus,
                    rik_messages: created.rik_messages,
                    read_back_error: created.read_back_error,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        try {
          await client.patch(`/v1/transactions/${created.id}/register`, [
            {
              related_table: "purchase_invoices",
              related_id: args.purchase_invoices_id,
              amount,
            },
          ]);
        } catch (error) {
          try {
            await client.delete(`/v1/transactions/${created.id}`);
          } catch (deleteError) {
            throw new Error(
              `Failed to register payment for purchase invoice ${args.purchase_invoices_id}: ${errorMessage(error)}. Failed to delete draft ${created.id}: ${errorMessage(deleteError)}`,
            );
          }
          throw error;
        }
        let refreshedPaymentStatus: string | null = null;
        try {
          const refreshed = (await client.get(
            `/v1/purchase_invoices/${args.purchase_invoices_id}`,
          )) as PurchaseInvoice;
          refreshedPaymentStatus = refreshed.payment_status ?? null;
        } catch {
          refreshedPaymentStatus = null;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  transaction_id: created.id,
                  type: created.type,
                  amount,
                  registered: true,
                  direction_confirmed: true,
                  payment_status: refreshedPaymentStatus,
                  rik_messages: created.rik_messages,
                  read_back_error: created.read_back_error,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    delete_transaction: {
      description:
        "Delete a transaction. Typically allowed only for draft (PROJECT) transactions; registered rows may be rejected by the API. See RIK e-Financials API documentation for state rules.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Transaction ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(transactionIdSchema, params);
        const response = await client.delete(`/v1/transactions/${args.id}`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    register_transaction: {
      description:
        'Register (confirm/post) a bank transaction with distribution rows. API equivalent of the e-arveldaja UI "Add a row" under transaction relations (purchase invoices, accounts, etc.) plus "Save and confirm" — for incoming (type C) and outgoing (type D). To pay a CONFIRMED purchase invoice in one step, use pay_purchase_invoice. Pass the complete distributions array in one call; there is no incremental add-row endpoint (Transactions.items is read-only). Each row requires related_table and amount; related_id is required in practice. related_table values: "accounts" (related_id = account id; related_sub_id = dimension id when the account has dimensions), "purchase_invoices", "sale_invoices". If clients_id is missing, set it with update_transaction first (API often rejects with buyer/supplier missing unless an invoice distribution supplies the party). Usually PROJECT drafts. CONFIRMED/VOID follow RIK rules.',
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Transaction ID",
          },
          distributions: {
            type: "array",
            description:
              'Full list of distribution rows for PATCH .../register (OpenAPI TransactionsDistributions). Example invoice: [{related_table:"purchase_invoices",related_id:123,amount:59.94}]. Example account with dimension: [{related_table:"accounts",related_id:1360,related_sub_id:456,amount:100}] — related_id is the chart account code (e.g. 1360 cash); related_sub_id is this company\'s dimension id from list_account_dimensions, not a value copied from another tenant.',
            items: {
              type: "object",
              properties: {
                related_table: {
                  type: "string",
                  description:
                    'Related object table: "accounts", "purchase_invoices", or "sale_invoices"',
                },
                amount: {
                  type: "number",
                  description: "Amount allocated to this related object (OpenAPI required)",
                },
                related_id: {
                  type: "number",
                  description:
                    "Related object ID (account id, purchase invoice id, or sale invoice id). Required in practice.",
                },
                related_sub_id: {
                  type: "number",
                  description:
                    "Required when related_table is accounts and the account has dimensions (accounts_dimensions_id). Do not put the dimension id in related_id.",
                },
              },
              required: ["related_table", "amount"],
            },
          },
        },
        required: ["id", "distributions"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(registerTransactionSchema, params);
        const response = await client.patch(
          `/v1/transactions/${args.id}/register`,
          args.distributions as TransactionDistributionRow[],
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    invalidate_transaction: {
      description:
        "Invalidate a registered transaction (reverse registration per API rules). Typically applies to posted (CONFIRMED) rows; draft PROJECT rows use delete instead. See RIK e-Financials API documentation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Transaction ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(transactionIdSchema, params);
        const response = await client.patch(`/v1/transactions/${args.id}/invalidate`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    get_transaction_file: {
      description:
        "Get the user-uploaded file attached to a bank transaction (OpenAPI ApiFile: name + base64 contents).",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Transaction ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(transactionIdSchema, params);
        const response = await client.get<ApiFile>(`/v1/transactions/${args.id}/document_user`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    upload_transaction_file: {
      description:
        "Upload a file to a bank transaction (PUT .../document_user). Accepts a local path, https:// URL, or inline base64:<data> / base64:<ext>:<data> (max 10 MiB). Sent as OpenAPI ApiFile.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Transaction ID",
          },
          file_path: {
            type: "string",
            description:
              "Local path, https:// URL (server fetches the bytes), or base64:<data> / base64:<ext>:<data>. If MCP_FILE_UPLOAD_ROOT is set, path inputs must be relative to that directory. Max 10 MiB.",
          },
          filename: {
            type: "string",
            description:
              "Optional archive name (e.g. Invoice-6390.pdf). Wins over Content-Disposition and the URL path.",
          },
        },
        required: ["id", "file_path"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(uploadTransactionFileSchema, params);
        const { buffer, filename } = await resolveFileInput(args.file_path, {
          filename: args.filename,
        });
        const base64Content = buffer.toString("base64");

        const response = await client.put(`/v1/transactions/${args.id}/document_user`, {
          name: filename,
          contents: base64Content,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `File "${filename}" uploaded to transaction ${args.id}`,
                  response,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    delete_transaction_file: {
      description: "Delete the user-uploaded file from a bank transaction.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Transaction ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(transactionIdSchema, params);
        const response = await client.delete(`/v1/transactions/${args.id}/document_user`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },
  };
}
