import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import {
  type AccountBalance,
  computeAllBalances,
  OPENING_BALANCE_API_WARNING,
  sumCategory,
} from "../financial-statements/balances.js";
import {
  JournalListTruncatedError,
  loadJournalsWithPostings,
} from "../financial-statements/load-journals.js";
import { roundMoney } from "../money.js";
import type { Account } from "../types/accounts.js";
import { optionalYmd, parseToolArgs, ymdDateString } from "../validation/tool-args.js";

const trialBalanceSchema = z.object({
  date_from: optionalYmd,
  date_to: optionalYmd,
});

const balanceSheetSchema = z.object({
  date_to: optionalYmd,
});

const profitAndLossSchema = z.object({
  date_from: ymdDateString,
  date_to: ymdDateString,
});

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function lineItems(balances: AccountBalance[]) {
  return balances.map((b) => ({
    id: b.account_id,
    name: b.name_est || b.name_eng,
    balance: b.balance,
  }));
}

async function loadAccounts(client: EFinancialsClient): Promise<Account[]> {
  return client.getAllPages<Account>("/v1/accounts");
}

/**
 * Read-only ledger statements from registered journal postings (EUR base).
 */
export function createFinancialStatementTools(client: EFinancialsClient) {
  return {
    compute_trial_balance: {
      description:
        "Compute a trial balance (käibeandmik) from registered journal postings. Optional date_from/date_to filter on journal effective_date. Amounts use EUR base_amount when present. Refuses incomplete loads when the journal list exceeds the page cap — narrow dates. Opening-balance UI entries may be missing from the API.",
      inputSchema: {
        type: "object" as const,
        properties: {
          date_from: { type: "string", description: "Period start YYYY-MM-DD (inclusive)" },
          date_to: { type: "string", description: "Period end YYYY-MM-DD (inclusive)" },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(trialBalanceSchema, params);
        try {
          const [accounts, journals] = await Promise.all([
            loadAccounts(client),
            loadJournalsWithPostings(client, {
              start_date: args.date_from,
              end_date: args.date_to,
            }),
          ]);
          const balances = computeAllBalances(accounts, journals, {
            dateFrom: args.date_from,
            dateTo: args.date_to,
          });
          const debit = roundMoney(balances.reduce((s, b) => s + b.debit_total, 0));
          const credit = roundMoney(balances.reduce((s, b) => s + b.credit_total, 0));
          return jsonResult({
            period: {
              from: args.date_from ?? "inception",
              to: args.date_to ?? "now",
            },
            accounts: balances,
            totals: {
              debit,
              credit,
              difference: roundMoney(debit - credit),
            },
            account_count: balances.length,
            warnings: [OPENING_BALANCE_API_WARNING],
          });
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

    compute_balance_sheet: {
      description:
        "Compute a balance sheet (bilanss) as of date_to from registered journal postings (cumulative). Groups Varad / Kohustused / Omakapital; folds open P&L (Tulud−Kulud) into equity for the A=L+E check. EUR base amounts. May fail if the unfiltered journal list is too large — pass date_to and prefer period tools for large books.",
      inputSchema: {
        type: "object" as const,
        properties: {
          date_to: { type: "string", description: "As-of date YYYY-MM-DD (inclusive)" },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(balanceSheetSchema, params);
        try {
          const [accounts, journals] = await Promise.all([
            loadAccounts(client),
            loadJournalsWithPostings(client, { end_date: args.date_to }),
          ]);
          const balances = computeAllBalances(accounts, journals, {
            dateTo: args.date_to,
          });
          const assets = sumCategory(balances, "Varad", "D");
          const liabilities = sumCategory(balances, "Kohustused", "C");
          const equityNominal = sumCategory(balances, "Omakapital", "C");
          const revenue = sumCategory(balances, "Tulud", "C");
          const expenses = sumCategory(balances, "Kulud", "D");
          const currentYearPL = roundMoney(revenue.total - expenses.total);
          const equityTotal = roundMoney(equityNominal.total + currentYearPL);
          const liabilitiesPlusEquity = roundMoney(liabilities.total + equityTotal);
          const balanced = Math.abs(assets.total - liabilitiesPlusEquity) < 0.01;
          const warnings = [OPENING_BALANCE_API_WARNING];
          if (Math.abs(currentYearPL) > 0.01) {
            warnings.push(
              "Open period P&L is folded into equity for the balance check; it is normally closed to equity at year-end.",
            );
          }
          return jsonResult({
            date: args.date_to ?? "current",
            assets: { items: lineItems(assets.items), total: assets.total },
            liabilities: { items: lineItems(liabilities.items), total: liabilities.total },
            equity: { items: lineItems(equityNominal.items), total: equityTotal },
            current_year_pl: {
              revenue: revenue.total,
              expenses: expenses.total,
              net_profit: currentYearPL,
              note: "Included in equity.total for the A = L + E check",
            },
            check: {
              assets: assets.total,
              liabilities_plus_equity: liabilitiesPlusEquity,
              balanced,
            },
            warnings,
          });
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

    compute_profit_and_loss: {
      description:
        "Compute a profit and loss statement (kasumiaruanne) for a required date_from/date_to window from registered journal postings. Tulud (revenue) and Kulud (expenses); net_profit = revenue − expenses. EUR base amounts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          date_from: { type: "string", description: "Period start YYYY-MM-DD (required)" },
          date_to: { type: "string", description: "Period end YYYY-MM-DD (required)" },
        },
        required: ["date_from", "date_to"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(profitAndLossSchema, params);
        try {
          const [accounts, journals] = await Promise.all([
            loadAccounts(client),
            loadJournalsWithPostings(client, {
              start_date: args.date_from,
              end_date: args.date_to,
            }),
          ]);
          const balances = computeAllBalances(accounts, journals, {
            dateFrom: args.date_from,
            dateTo: args.date_to,
          });
          const revenue = sumCategory(balances, "Tulud", "C");
          const expenses = sumCategory(balances, "Kulud", "D");
          return jsonResult({
            period: { from: args.date_from, to: args.date_to },
            revenue: {
              items: lineItems(revenue.items).map((i) => ({
                id: i.id,
                name: i.name,
                amount: i.balance,
              })),
              total: revenue.total,
            },
            expenses: {
              items: lineItems(expenses.items).map((i) => ({
                id: i.id,
                name: i.name,
                amount: i.balance,
              })),
              total: expenses.total,
            },
            net_profit: roundMoney(revenue.total - expenses.total),
            warnings: [OPENING_BALANCE_API_WARNING],
          });
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
