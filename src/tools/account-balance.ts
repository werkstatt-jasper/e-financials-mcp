import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import {
  computeAccountBalance,
  computeClientDebt,
} from "../financial-statements/account-balance.js";
import { OPENING_BALANCE_API_WARNING } from "../financial-statements/balances.js";
import {
  JournalListTruncatedError,
  loadJournalsWithPostings,
} from "../financial-statements/load-journals.js";
import type { Account } from "../types/accounts.js";
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalYmd,
  parseToolArgs,
  positiveInt,
} from "../validation/tool-args.js";

const accountBalanceSchema = z.object({
  account_id: positiveInt,
  clients_id: optionalPositiveInt,
  date_from: optionalYmd,
  date_to: optionalYmd,
  include_entries: optionalBoolean,
});

const clientDebtSchema = z.object({
  clients_id: positiveInt,
  account_ids: z
    .array(positiveInt)
    .nullish()
    .transform((v) => v ?? undefined),
});

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

async function loadAccounts(client: EFinancialsClient): Promise<Account[]> {
  return client.getAllPages<Account>("/v1/accounts");
}

/**
 * Read-only account / client balance tools from registered journal postings.
 */
export function createAccountBalanceTools(client: EFinancialsClient) {
  return {
    compute_account_balance: {
      description:
        "Compute the balance of one chart account from registered journal postings (EUR base_amount when present). Requires account_id (DB id). Optional clients_id filters journals tagged with that client; optional date_from/date_to filter on journal effective_date (inclusive). Set include_entries=true for posting detail. Opening-balance UI entries may be missing from the API. Refuses incomplete loads when the journal list exceeds the page cap — narrow dates. Journal amendments (parent_id / amendment_number, UI 'Parandus') are additive corrections; both the original and each amendment are counted.",
      inputSchema: {
        type: "object" as const,
        properties: {
          account_id: {
            type: "number",
            description: "Chart account database id (not a display code)",
          },
          clients_id: {
            type: "number",
            description: "Optional: only journals with this clients_id",
          },
          date_from: { type: "string", description: "Inclusive start YYYY-MM-DD" },
          date_to: { type: "string", description: "Inclusive end YYYY-MM-DD" },
          include_entries: {
            type: "boolean",
            description: "Include posting detail array (default false)",
          },
        },
        required: ["account_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(accountBalanceSchema, params);
        try {
          const [accounts, journals] = await Promise.all([
            loadAccounts(client),
            loadJournalsWithPostings(client, {
              start_date: args.date_from,
              end_date: args.date_to,
            }),
          ]);
          const detail = computeAccountBalance(accounts, journals, {
            accountId: args.account_id,
            clientsId: args.clients_id,
            dateFrom: args.date_from,
            dateTo: args.date_to,
            includeEntries: args.include_entries === true,
          });
          return jsonResult(detail);
        } catch (err) {
          if (err instanceof JournalListTruncatedError) {
            return jsonResult({
              error: err.code,
              message: err.message,
              warnings: [OPENING_BALANCE_API_WARNING],
            });
          }
          throw err;
        }
      },
    },

    compute_client_debt: {
      description:
        "Compute a client's net position from registered journal postings tagged with clients_id. Optional account_ids (DB ids) limits which accounts are summarized; when omitted, every account with postings for that client is included. Summary: total_debt_to_client (C-type balances), total_receivable_from_client (D-type), net_position = receivable − debt. Opening-balance UI entries may be missing from the API.",
      inputSchema: {
        type: "object" as const,
        properties: {
          clients_id: { type: "number", description: "Client database id" },
          account_ids: {
            type: "array",
            items: { type: "number" },
            description:
              "Optional chart account DB ids. When omitted, uses all accounts with postings for this client.",
          },
        },
        required: ["clients_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(clientDebtSchema, params);
        try {
          const [accounts, journals] = await Promise.all([
            loadAccounts(client),
            loadJournalsWithPostings(client),
          ]);
          const result = computeClientDebt(accounts, journals, {
            clientsId: args.clients_id,
            accountIds: args.account_ids,
          });
          return jsonResult(result);
        } catch (err) {
          if (err instanceof JournalListTruncatedError) {
            return jsonResult({
              error: err.code,
              message: err.message,
              warnings: [OPENING_BALANCE_API_WARNING],
            });
          }
          throw err;
        }
      },
    },
  };
}
