import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type { ApiFile } from "../types/journal.js";
import type {
  CreateTransactionParams,
  ListTransactionsParams,
  Transaction,
  TransactionDistributionRow,
  UpdateTransactionParams,
} from "../types/transaction.js";
import { resolveUploadFilePath } from "../upload-file-path.js";
import {
  creditDebitEnum,
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
});

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
            description: "Filter by type: C = Credit (money in), D = Debit (money out)",
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
        const response = await client.get<Transaction>("/v1/transactions", {
          status: args.status,
          modified_since: args.modified_since,
          start_date: args.start_date,
          end_date: args.end_date,
          type: args.type,
          clients_id: args.clients_id,
          page: args.page,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  items: response.items || [],
                  current_page: response.current_page || 1,
                  total_pages: response.total_pages || 1,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    get_transaction: {
      description: "Get details of a specific transaction by ID",
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
        const response = await client.get<Transaction>(`/v1/transactions/${args.id}`);
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
              "Filter by type: C = Credit (money in), D = Debit (money out). If not specified, returns both.",
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
        const response = await client.get<Transaction>("/v1/transactions", {
          status: "PROJECT",
          type: args.type,
          start_date: args.start_date,
          end_date: args.end_date,
        });
        // Filter to only those without a client assigned
        const unprocessed = (response.items || []).filter((t) => !t.clients_id);
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
        "Update a transaction to assign a client/supplier or change the account. Only works on PROJECT status transactions.",
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
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updateTransactionSchema, params);
        const { id, ...updateData } = parsed as { id: number } & UpdateTransactionParams;
        const response = await client.patch<Transaction>(`/v1/transactions/${id}`, updateData);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Transaction ${id} updated`,
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
        "Create a new bank transaction as a draft (PROJECT). Send only writable OpenAPI fields: accounts_dimensions_id, type (C/D), amount, cl_currencies_id, date (YYYY-MM-DD), and optional clients_id, description, ref_number, bank_account_name, base_amount, currency_rate, transactions_files_id, export_format. The API assigns id, status, accounts_id, and bank-import fields. See RIK e-Financials API documentation for full rules.",
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
            description: "C = credit (money in), D = debit (money out)",
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

        const response = await client.post("/v1/transactions", body);
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
        "Register (post to the books) a transaction. The API expects a JSON array of distribution rows (OpenAPI TransactionsDistributions): each row requires related_table and amount; optional related_id and related_sub_id (e.g. dimension when related_table is accounts). Usually applies to draft (PROJECT) transactions that are fully categorized. CONFIRMED/VOID transitions follow RIK rules — see e-Financials API documentation.",
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
              "Distribution rows for PATCH .../register (OpenAPI array of TransactionsDistribution)",
            items: {
              type: "object",
              properties: {
                related_table: {
                  type: "string",
                  description: "Related table name (OpenAPI required)",
                },
                amount: {
                  type: "number",
                  description: "Amount allocated to this related object (OpenAPI required)",
                },
                related_id: {
                  type: "number",
                  description: "Related object ID (e.g. account number)",
                },
                related_sub_id: {
                  type: "number",
                  description:
                    "Related sub-ID (e.g. accounts_dimensions_id when related_table is accounts)",
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
        "Upload a file to a bank transaction (PUT .../document_user). File is read from disk, base64-encoded, sent as OpenAPI ApiFile.",
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
              "Local path to the file to upload. If MCP_FILE_UPLOAD_ROOT is set, use a path relative to that directory (absolute paths are rejected). Otherwise any readable path is allowed.",
          },
        },
        required: ["id", "file_path"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(uploadTransactionFileSchema, params);
        const resolvedPath = await resolveUploadFilePath(args.file_path);
        const fileBuffer = await readFile(resolvedPath);
        const base64Content = fileBuffer.toString("base64");
        const filename = basename(resolvedPath);

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
