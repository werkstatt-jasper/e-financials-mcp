import { roundMoney } from "../money.js";
import type { Account } from "../types/accounts.js";
import type { Journal, Posting } from "../types/journal.js";
import { OPENING_BALANCE_API_WARNING } from "./balances.js";

export interface BalanceEntry {
  journal_id: number | null;
  date: string;
  title: string | null;
  type: "D" | "C";
  amount: number;
  clients_id: number | null;
}

export interface ComputeAccountBalanceOptions {
  accountId: number;
  clientsId?: number;
  dateFrom?: string;
  dateTo?: string;
  includeEntries?: boolean;
}

export interface AccountBalanceDetail {
  account_id: number;
  account_name: string;
  balance_type: string;
  balance: number;
  debit_total: number;
  credit_total: number;
  entry_count: number;
  clients_id?: number;
  date_from?: string;
  date_to?: string;
  entries?: BalanceEntry[];
  warnings: string[];
}

export interface ClientDebtAccountRow {
  account_id: number;
  account_name: string;
  balance_type: string;
  balance: number;
  debit_total: number;
  credit_total: number;
  entry_count: number;
}

export interface ClientDebtResult {
  clients_id: number;
  accounts: ClientDebtAccountRow[];
  summary: {
    total_debt_to_client: number;
    total_receivable_from_client: number;
    net_position: number;
  };
  warnings: string[];
}

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

function accountDisplayName(account: Account | undefined): string {
  if (account == null) {
    return "Unknown";
  }
  const est = account.name_est?.trim() ?? "";
  const eng = account.name_eng?.trim() ?? "";
  if (est && eng) {
    return `${est} / ${eng}`;
  }
  return est || eng || "Unknown";
}

/** Exported for unit tests (sort stability by date then journal id). */
export function compareBalanceEntries(a: BalanceEntry, b: BalanceEntry): number {
  if (a.date < b.date) {
    return -1;
  }
  if (a.date > b.date) {
    return 1;
  }
  return (a.journal_id ?? 0) - (b.journal_id ?? 0);
}

/**
 * Balance for one account from registered journal postings.
 * Optionally filter by journal clients_id and inclusive date window on effective_date.
 */
export function computeAccountBalance(
  accounts: Account[],
  journals: Journal[],
  options: ComputeAccountBalanceOptions,
): AccountBalanceDetail {
  const account = accounts.find((a) => a.id === options.accountId);
  const warnings: string[] = [OPENING_BALANCE_API_WARNING];
  if (account == null) {
    warnings.push(
      `Account id ${options.accountId} was not found in the chart of accounts; balance_type defaults to D.`,
    );
  }

  const balanceType = account?.balance_type === "C" ? "C" : "D";
  let debitTotal = 0;
  let creditTotal = 0;
  const entries: BalanceEntry[] = [];

  for (const journal of journals) {
    if (journal.is_deleted === true || journal.registered !== true) {
      continue;
    }
    if (!journalInDateWindow(journal, options.dateFrom, options.dateTo)) {
      continue;
    }
    if (options.clientsId != null && journal.clients_id !== options.clientsId) {
      continue;
    }

    const postings = Array.isArray(journal.postings) ? journal.postings : [];
    for (const posting of postings) {
      if (posting.is_deleted === true) {
        continue;
      }
      if (posting.accounts_id !== options.accountId) {
        continue;
      }
      const t = posting.type;
      if (t !== "D" && t !== "C") {
        continue;
      }
      const amt = postingAmount(posting);
      if (amt === 0) {
        continue;
      }
      if (t === "D") {
        debitTotal += amt;
      } else {
        creditTotal += amt;
      }
      if (options.includeEntries) {
        entries.push({
          journal_id: journal.id ?? null,
          date: journal.effective_date,
          title: journal.title ?? null,
          type: t,
          amount: roundMoney(amt),
          clients_id: journal.clients_id ?? null,
        });
      }
    }
  }

  const signed = balanceType === "D" ? debitTotal - creditTotal : creditTotal - debitTotal;
  if (options.includeEntries) {
    entries.sort(compareBalanceEntries);
  }

  const result: AccountBalanceDetail = {
    account_id: options.accountId,
    account_name: accountDisplayName(account),
    balance_type: balanceType,
    balance: roundMoney(signed),
    debit_total: roundMoney(debitTotal),
    credit_total: roundMoney(creditTotal),
    entry_count: options.includeEntries ? entries.length : countMatchingEntries(journals, options),
    warnings,
  };
  if (options.clientsId != null) {
    result.clients_id = options.clientsId;
  }
  if (options.dateFrom != null) {
    result.date_from = options.dateFrom;
  }
  if (options.dateTo != null) {
    result.date_to = options.dateTo;
  }
  if (options.includeEntries) {
    result.entries = entries;
  }
  return result;
}

/** Count matching postings without building the entries array. */
function countMatchingEntries(journals: Journal[], options: ComputeAccountBalanceOptions): number {
  let count = 0;
  for (const journal of journals) {
    if (journal.is_deleted === true || journal.registered !== true) {
      continue;
    }
    if (!journalInDateWindow(journal, options.dateFrom, options.dateTo)) {
      continue;
    }
    if (options.clientsId != null && journal.clients_id !== options.clientsId) {
      continue;
    }
    const postings = Array.isArray(journal.postings) ? journal.postings : [];
    for (const posting of postings) {
      if (posting.is_deleted === true) {
        continue;
      }
      if (posting.accounts_id !== options.accountId) {
        continue;
      }
      if (posting.type !== "D" && posting.type !== "C") {
        continue;
      }
      if (postingAmount(posting) === 0) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

export interface ComputeClientDebtOptions {
  clientsId: number;
  /** When omitted, include every account that has postings for this client. */
  accountIds?: number[];
}

/**
 * Net position for one client across selected (or all tagged) accounts.
 * C-type balances → owed to client; D-type → receivable from client.
 */
export function computeClientDebt(
  accounts: Account[],
  journals: Journal[],
  options: ComputeClientDebtOptions,
): ClientDebtResult {
  let accountIds = options.accountIds;
  if (accountIds == null || accountIds.length === 0) {
    const discovered = new Set<number>();
    for (const journal of journals) {
      if (journal.is_deleted === true || journal.registered !== true) {
        continue;
      }
      if (journal.clients_id !== options.clientsId) {
        continue;
      }
      const postings = Array.isArray(journal.postings) ? journal.postings : [];
      for (const posting of postings) {
        if (posting.is_deleted === true) {
          continue;
        }
        if (posting.type !== "D" && posting.type !== "C") {
          continue;
        }
        if (postingAmount(posting) === 0) {
          continue;
        }
        discovered.add(posting.accounts_id);
      }
    }
    accountIds = [...discovered].sort((a, b) => a - b);
  }

  const accountRows: ClientDebtAccountRow[] = [];
  let totalDebt = 0;
  let totalReceivable = 0;
  const warnings: string[] = [OPENING_BALANCE_API_WARNING];

  for (const accountId of accountIds) {
    const detail = computeAccountBalance(accounts, journals, {
      accountId,
      clientsId: options.clientsId,
    });
    for (const w of detail.warnings) {
      if (w !== OPENING_BALANCE_API_WARNING && !warnings.includes(w)) {
        warnings.push(w);
      }
    }
    accountRows.push({
      account_id: detail.account_id,
      account_name: detail.account_name,
      balance_type: detail.balance_type,
      balance: detail.balance,
      debit_total: detail.debit_total,
      credit_total: detail.credit_total,
      entry_count: detail.entry_count,
    });
    if (detail.balance_type === "C") {
      totalDebt += detail.balance;
    } else {
      totalReceivable += detail.balance;
    }
  }

  return {
    clients_id: options.clientsId,
    accounts: accountRows,
    summary: {
      total_debt_to_client: roundMoney(totalDebt),
      total_receivable_from_client: roundMoney(totalReceivable),
      net_position: roundMoney(totalReceivable - totalDebt),
    },
    warnings,
  };
}
