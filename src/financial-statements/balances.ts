import { roundMoney } from "../money.js";
import type { Account } from "../types/accounts.js";
import type { Journal, Posting } from "../types/journal.js";

export interface AccountBalance {
  account_id: number;
  name_est: string;
  name_eng: string;
  balance_type: string;
  account_type_est: string;
  debit_total: number;
  credit_total: number;
  balance: number;
}

export interface ComputeAllBalancesOptions {
  dateFrom?: string;
  dateTo?: string;
}

export const OPENING_BALANCE_API_WARNING =
  "Opening-balance entries (e-Financials UI: Algbilansi kanded) may not appear in /v1/journals. Trial balance, balance sheet, and P&L can miss opening amounts — verify opening balances in the UI.";

function postingAmount(posting: Posting): number {
  const v = posting.base_amount ?? posting.amount;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function journalInDateWindow(
  journal: Journal,
  dateFrom: string | undefined,
  dateTo: string | undefined,
): boolean {
  const d = journal.effective_date;
  if (dateFrom != null && d < dateFrom) {
    return false;
  }
  if (dateTo != null && d > dateTo) {
    return false;
  }
  return true;
}

/**
 * Aggregate registered, non-deleted journal postings into per-account balances.
 * Debit/credit accumulate unrounded; each account is rounded once at the end.
 */
export function computeAllBalances(
  accounts: Account[],
  journals: Journal[],
  options: ComputeAllBalancesOptions = {},
): AccountBalance[] {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const debit = new Map<number, number>();
  const credit = new Map<number, number>();

  for (const journal of journals) {
    if (journal.is_deleted === true || journal.registered !== true) {
      continue;
    }
    if (!journalInDateWindow(journal, options.dateFrom, options.dateTo)) {
      continue;
    }
    const postings = Array.isArray(journal.postings) ? journal.postings : [];
    for (const posting of postings) {
      if (posting.is_deleted === true) {
        continue;
      }
      const t = posting.type;
      if (t !== "D" && t !== "C") {
        continue;
      }
      const accountId = posting.accounts_id;
      if (!accountById.has(accountId)) {
        continue;
      }
      const amt = postingAmount(posting);
      if (amt === 0) {
        continue;
      }
      if (t === "D") {
        debit.set(accountId, (debit.get(accountId) ?? 0) + amt);
      } else {
        credit.set(accountId, (credit.get(accountId) ?? 0) + amt);
      }
    }
  }

  const activeIds = new Set([...debit.keys(), ...credit.keys()]);
  const results: AccountBalance[] = [];
  for (const id of activeIds) {
    // Only known chart accounts are accumulated above.
    const account = accountById.get(id) as Account;
    const d = debit.get(id) ?? 0;
    const c = credit.get(id) ?? 0;
    const balanceType = account.balance_type === "C" ? "C" : "D";
    const signed = balanceType === "D" ? d - c : c - d;
    results.push({
      account_id: id,
      name_est: account.name_est,
      name_eng: account.name_eng,
      balance_type: balanceType,
      account_type_est: account.account_type_est,
      debit_total: roundMoney(d),
      credit_total: roundMoney(c),
      balance: roundMoney(signed),
    });
  }
  results.sort((a, b) => a.account_id - b.account_id);
  return results;
}

/**
 * Sum balances for a chart category with contra-account handling.
 * Normal D (Varad, Kulud): add D-type balances, subtract C-type.
 * Normal C (Kohustused, Omakapital, Tulud): add C-type, subtract D-type.
 */
export function sumCategory(
  balances: AccountBalance[],
  accountTypeEst: string,
  normalType: "D" | "C",
): { items: AccountBalance[]; total: number } {
  const items = balances.filter((b) => b.account_type_est === accountTypeEst);
  let total = 0;
  for (const item of items) {
    if (normalType === "D") {
      total += item.balance_type === "D" ? item.balance : -item.balance;
    } else {
      total += item.balance_type === "C" ? item.balance : -item.balance;
    }
  }
  return { items, total: roundMoney(total) };
}
