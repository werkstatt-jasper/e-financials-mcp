import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type {
  Account,
  AccountDimension,
  BankAccounts,
  Project,
  PurchaseArticle,
  VatInfo,
} from "../types/accounts.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalPositiveInt,
  optionalString,
  parseToolArgs,
  positiveInt,
} from "../validation/tool-args.js";

const bankAccountBodySchemaProps = {
  account_name_est: {
    type: "string" as const,
    description: "Account name (Estonian), max 100 characters (required on create)",
  },
  account_name_eng: {
    type: "string" as const,
    description: "Account name (English), max 100 characters",
  },
  account_no: {
    type: "string" as const,
    description: "Account number, max 100 characters (required on create)",
  },
  cl_banks_id: {
    type: "number" as const,
    description: "Bank reference ID (cl_banks)",
  },
  bank_name: {
    type: "string" as const,
    description: "Bank name, max 100 characters",
  },
  bank_regcode: {
    type: "string" as const,
    description: "Bank registry code, max 100 characters",
  },
  iban_code: {
    type: "string" as const,
    description: "IBAN, max 100 characters",
  },
  swift_code: {
    type: "string" as const,
    description: "SWIFT/BIC, max 100 characters",
  },
  start_sum: {
    type: "number" as const,
    description: "Initial balance",
  },
  day_limit: {
    type: "number" as const,
    description: "Daily limit",
  },
  credit_limit: {
    type: "number" as const,
    description: "Monthly limit",
  },
  show_in_sale_invoices: {
    type: "boolean" as const,
    description: "Whether the account is shown on sales invoices",
  },
  default_salary_account: {
    type: "boolean" as const,
    description: "Default account for outgoing salary payments",
  },
  beneficiary_name: {
    type: "string" as const,
    description: "Beneficiary name, max 70 characters",
  },
} satisfies Record<string, object>;

type BankAccountBodyKeys = keyof typeof bankAccountBodySchemaProps;

function pickBankAccountBody(
  params: Record<string, unknown>,
  keys: readonly BankAccountBodyKeys[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    const v = params[key];
    if (v !== undefined) {
      body[key] = v;
    }
  }
  return body;
}

const allBankAccountBodyKeys = Object.keys(bankAccountBodySchemaProps) as BankAccountBodyKeys[];

const bankAccountFieldsSchema = z.object({
  account_name_est: optionalString,
  account_name_eng: optionalString,
  account_no: optionalString,
  cl_banks_id: optionalPositiveInt,
  bank_name: optionalString,
  bank_regcode: optionalString,
  iban_code: optionalString,
  swift_code: optionalString,
  start_sum: optionalNumber,
  day_limit: optionalNumber,
  credit_limit: optionalNumber,
  show_in_sale_invoices: optionalBoolean,
  default_salary_account: optionalBoolean,
  beneficiary_name: optionalString,
});

const createBankAccountSchema = bankAccountFieldsSchema.extend({
  account_name_est: z.string().min(1),
  account_no: z.string().min(1),
});

const updateBankAccountSchema = bankAccountFieldsSchema.extend({
  bank_accounts_id: positiveInt,
});

const bankAccountsIdSchema = z.object({ bank_accounts_id: positiveInt });

const listAccountsSchema = z.object({
  type: optionalString,
});

const emptyToolArgs = z.object({});

const searchAccountsSchema = z.object({
  query: z.string().min(1),
});

const listAccountDimensionsSchema = z.object({
  accounts_id: optionalPositiveInt,
});

// Helper to extract items from API response (handles both {items: [...]} and direct array)
function extractItems<T>(response: unknown): T[] {
  if (Array.isArray(response)) {
    return response as T[];
  }
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return obj.items as T[];
    }
  }
  return [];
}

export function createAccountTools(client: EFinancialsClient) {
  return {
    list_accounts: {
      description: "List the chart of accounts. Returns all accounts used for bookkeeping entries.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            description: "Filter by account type (e.g., 'ASSET', 'LIABILITY', 'EXPENSE', 'INCOME')",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(listAccountsSchema, params);
        const response = await client.get<Account>("/v1/accounts", {
          type: args.type,
        });
        const items = extractItems<Account>(response);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(items, null, 2),
            },
          ],
        };
      },
    },

    get_bank_accounts: {
      description: "List all bank accounts configured in e-Financials.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<BankAccounts>("/v1/bank_accounts");
        const items = extractItems<BankAccounts>(response);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(items, null, 2),
            },
          ],
        };
      },
    },

    create_bank_account: {
      description:
        "Create a bank account in e-Financials. Required: account_name_est, account_no (per OpenAPI BankAccounts).",
      inputSchema: {
        type: "object" as const,
        properties: bankAccountBodySchemaProps,
        required: ["account_name_est", "account_no"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(createBankAccountSchema, params) as Record<string, unknown>;
        const body = pickBankAccountBody(parsed, allBankAccountBodyKeys);
        const response = await client.post("/v1/bank_accounts", body);
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

    get_bank_account: {
      description: "Get one bank account by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          bank_accounts_id: {
            type: "number",
            description: "Bank account ID",
          },
        },
        required: ["bank_accounts_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(bankAccountsIdSchema, params);
        const response = await client.get<BankAccounts>(
          `/v1/bank_accounts/${args.bank_accounts_id}`,
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

    update_bank_account: {
      description: "PATCH an existing bank account. Only include fields to change. Read-only: id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          bank_accounts_id: {
            type: "number",
            description: "Bank account ID",
          },
          ...bankAccountBodySchemaProps,
        },
        required: ["bank_accounts_id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updateBankAccountSchema, params);
        const { bank_accounts_id, ...rest } = parsed as Record<string, unknown> & {
          bank_accounts_id: number;
        };
        const body = pickBankAccountBody(rest, allBankAccountBodyKeys);
        const response = await client.patch(`/v1/bank_accounts/${bank_accounts_id}`, body);
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

    delete_bank_account: {
      description: "Delete a bank account by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          bank_accounts_id: {
            type: "number",
            description: "Bank account ID",
          },
        },
        required: ["bank_accounts_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(bankAccountsIdSchema, params);
        const response = await client.delete(`/v1/bank_accounts/${args.bank_accounts_id}`);
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

    get_vat_info: {
      description: "Get company VAT information (VAT number and tax reference number).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<VatInfo>("/v1/vat_info");
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

    list_projects: {
      description:
        "List all projects (cost/profit centers). Used for tracking expenses by project.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<Project>("/v1/projects");
        const items = extractItems<Project>(response);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(items, null, 2),
            },
          ],
        };
      },
    },

    search_accounts: {
      description:
        "Search for an account by name or ID. Useful for finding the right account to use.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query (matches account name in Estonian/English or ID)",
          },
        },
        required: ["query"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(searchAccountsSchema, params);
        const items = await client.getAllPages<Account>("/v1/accounts");
        const query = args.query.toLowerCase();
        const matches = items.filter(
          (a) =>
            a.name_est?.toLowerCase().includes(query) ||
            a.name_eng?.toLowerCase().includes(query) ||
            String(a.id).includes(query),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query: args.query,
                  count: matches.length,
                  accounts: matches,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    list_account_dimensions: {
      description:
        "List account dimensions (sub-accounts). Filter by accounts_id to see dimensions for a specific parent account.",
      inputSchema: {
        type: "object" as const,
        properties: {
          accounts_id: {
            type: "number",
            description:
              "Filter by parent account ID (e.g., 1820 to see sub-accounts of account 1820)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(listAccountDimensionsSchema, params);
        const response = await client.get<AccountDimension>("/v1/account_dimensions");
        let dimensions = extractItems<AccountDimension>(response);

        if (args.accounts_id) {
          dimensions = dimensions.filter((d) => d.accounts_id === args.accounts_id);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  filter: args.accounts_id ? `accounts_id=${args.accounts_id}` : "none",
                  count: dimensions.length,
                  dimensions: dimensions,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    list_purchase_articles: {
      description:
        "List purchase articles (expense categories). Each article maps to an account for expense categorization.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<PurchaseArticle>("/v1/purchase_articles");
        const items = extractItems<PurchaseArticle>(response);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(items, null, 2),
            },
          ],
        };
      },
    },
  };
}
