import type { AccountDimension, BankAccounts } from "../types/accounts.js";
import type { Journal } from "../types/journal.js";
import type { Transaction, TransactionDistributionRow } from "../types/transaction.js";
import { amountsClose, normalizeName } from "./match-score.js";

export interface OwnBankMaps {
  ibanToDimension: Map<string, number>;
  dimensionToIban: Map<number, string>;
  dimensionToAccountsId: Map<number, number>;
  dimensionToTitle: Map<number, string>;
  ownDimensions: Set<number>;
  ownIbans: Set<string>;
}

export function normalizeIban(iban: string | null | undefined): string {
  return (iban ?? "").replace(/\s+/g, "").toUpperCase();
}

export function buildOwnBankMaps(
  bankAccounts: BankAccounts[],
  dimensions: AccountDimension[],
): OwnBankMaps {
  const ibanToDimension = new Map<string, number>();
  const dimensionToIban = new Map<number, string>();
  const dimensionToAccountsId = new Map<number, number>();
  const dimensionToTitle = new Map<number, string>();
  const ownDimensions = new Set<number>();
  const ownIbans = new Set<string>();

  for (const ba of bankAccounts) {
    const iban = normalizeIban(ba.iban_code ?? ba.account_no);
    if (!iban) {
      continue;
    }
    ownIbans.add(iban);
  }

  for (const dim of dimensions) {
    dimensionToAccountsId.set(dim.id, dim.accounts_id);
    dimensionToTitle.set(dim.id, dim.title_eng || dim.title_est);
  }

  // Link dimensions that look like bank accounts: match title/account patterns via IBAN list size.
  // Prefer dimensions whose accounts_id matches known bank-account bindings when present.
  for (const ba of bankAccounts) {
    const iban = normalizeIban(ba.iban_code ?? ba.account_no);
    if (!iban) {
      continue;
    }
    // Heuristic: first unused dimension with matching currency EUR, or any dimension if only one bank.
    for (const dim of dimensions) {
      if (ownDimensions.has(dim.id)) {
        continue;
      }
      // Bind when titles share bank account name fragments
      const title = normalizeName(`${dim.title_est} ${dim.title_eng}`);
      const baName = normalizeName(`${ba.account_name_est} ${ba.account_name_eng ?? ""}`);
      if (
        baName.length >= 3 &&
        title.length >= 3 &&
        (title.includes(baName.slice(0, Math.min(8, baName.length))) ||
          baName.includes(title.slice(0, Math.min(8, title.length))))
      ) {
        ibanToDimension.set(iban, dim.id);
        dimensionToIban.set(dim.id, iban);
        ownDimensions.add(dim.id);
        break;
      }
    }
  }

  // If still unbound and exactly one bank + one dimension, pair them
  if (ownDimensions.size === 0 && bankAccounts.length === 1 && dimensions.length === 1) {
    const ba = bankAccounts[0];
    const iban = normalizeIban(ba.iban_code ?? ba.account_no);
    const dim = dimensions[0];
    if (iban) {
      ibanToDimension.set(iban, dim.id);
      dimensionToIban.set(dim.id, iban);
      ownDimensions.add(dim.id);
    }
  }

  // Also treat any dimension that already appears on PROJECT bank txs as own when IBAN matches counterparty
  return {
    ibanToDimension,
    dimensionToIban,
    dimensionToAccountsId,
    dimensionToTitle,
    ownDimensions,
    ownIbans,
  };
}

/** Mark dimensions seen on transactions as own bank dimensions. */
export function expandOwnDimensionsFromTransactions(
  maps: OwnBankMaps,
  transactions: Pick<Transaction, "accounts_dimensions_id" | "bank_account_no">[],
): void {
  for (const tx of transactions) {
    maps.ownDimensions.add(tx.accounts_dimensions_id);
  }
}

/** Explicit IBAN ↔ dimension binding (tests and callers with known mapping). */
export function bindIbanToDimension(maps: OwnBankMaps, iban: string, dimensionId: number): void {
  const normalized = normalizeIban(iban);
  if (!normalized) {
    return;
  }
  maps.ownIbans.add(normalized);
  maps.ibanToDimension.set(normalized, dimensionId);
  maps.dimensionToIban.set(dimensionId, normalized);
  maps.ownDimensions.add(dimensionId);
}

export interface TransferPairCandidate {
  outgoing: Transaction;
  incoming: Transaction;
  confidence: number;
  reasons: string[];
  targetAccountsId: number;
  targetDimensionId: number;
}

export interface OneSidedTransfer {
  transaction: Transaction;
  confidence: number;
  reasons: string[];
  targetAccountsId: number;
  targetDimensionId: number;
}

export interface AmbiguousTransfer {
  outgoingId: number;
  incomingIds: number[];
  confidence: number;
}

function dayDiff(a: string, b: string): number {
  const ms = Math.abs(Date.parse(a) - Date.parse(b));
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function pairCompatibility(
  outgoing: Transaction,
  incoming: Transaction,
  maxDateGap: number,
): { ok: boolean; confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  let confidence = 0;

  const outAmt = Math.abs(outgoing.amount);
  const inAmt = Math.abs(incoming.amount);
  const outBase = Math.abs(outgoing.base_amount ?? outgoing.amount);
  const inBase = Math.abs(incoming.base_amount ?? incoming.amount);

  const exactNominal = amountsClose(outAmt, inAmt);
  const exactBase = amountsClose(outBase, inBase);

  if (exactNominal) {
    confidence += 40;
    reasons.push("exact_amount");
  } else if (exactBase) {
    confidence += 40;
    reasons.push("exact_base_amount");
  } else {
    return { ok: false, confidence: 0, reasons: [] };
  }

  const gap = dayDiff(outgoing.date, incoming.date);
  if (gap === 0) {
    confidence += 20;
    reasons.push("same_date");
  } else if (gap <= maxDateGap) {
    confidence += 10;
    reasons.push("date_within_gap");
  } else {
    return { ok: false, confidence: 0, reasons: [] };
  }

  return { ok: true, confidence, reasons };
}

function counterpartySignals(
  a: Transaction,
  b: Transaction,
  maps: OwnBankMaps,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const aIban = normalizeIban(a.bank_account_no);
  const bIban = normalizeIban(b.bank_account_no);
  const bOwnIban = maps.dimensionToIban.get(b.accounts_dimensions_id);
  const aOwnIban = maps.dimensionToIban.get(a.accounts_dimensions_id);

  if (aIban && bOwnIban && aIban === bOwnIban) {
    score += 30;
    reasons.push("iban_matches_other_account");
  }
  if (bIban && aOwnIban && bIban === aOwnIban) {
    score += 30;
    reasons.push("iban_matches_other_account");
  }
  if (aIban && maps.ownIbans.has(aIban)) {
    score += 15;
    reasons.push("counterparty_own_iban");
  }
  if (bIban && maps.ownIbans.has(bIban)) {
    score += 15;
    reasons.push("counterparty_own_iban");
  }

  return { score, reasons };
}

export function findTransferPairs(
  projectTxs: Transaction[],
  maps: OwnBankMaps,
  maxDateGap: number,
): {
  pairs: TransferPairCandidate[];
  ambiguous: AmbiguousTransfer[];
} {
  const outgoing = projectTxs.filter((t) => t.type === "D" && !t.is_deleted);
  const incoming = projectTxs.filter((t) => t.type === "C" && !t.is_deleted);

  const pairs: TransferPairCandidate[] = [];
  const ambiguous: AmbiguousTransfer[] = [];
  const usedIncoming = new Set<number>();
  const usedOutgoing = new Set<number>();

  for (const out of outgoing) {
    const candidates: TransferPairCandidate[] = [];

    for (const inn of incoming) {
      if (out.accounts_dimensions_id === inn.accounts_dimensions_id) {
        continue;
      }
      const compat = pairCompatibility(out, inn, maxDateGap);
      if (!compat.ok) {
        continue;
      }
      const signals = counterpartySignals(out, inn, maps);
      if (signals.score === 0) {
        continue;
      }
      const confidence = Math.min(100, compat.confidence + signals.score);
      const targetDim = inn.accounts_dimensions_id;
      const targetAccountsId = maps.dimensionToAccountsId.get(targetDim);
      if (targetAccountsId == null) {
        continue;
      }
      candidates.push({
        outgoing: out,
        incoming: inn,
        confidence,
        reasons: [...compat.reasons, ...signals.reasons],
        targetAccountsId,
        targetDimensionId: targetDim,
      });
    }

    if (candidates.length === 0) {
      continue;
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    const top = candidates[0].confidence;
    const tied = candidates.filter((c) => c.confidence === top);
    if (tied.length > 1) {
      ambiguous.push({
        outgoingId: out.id,
        incomingIds: tied.map((c) => c.incoming.id),
        confidence: top,
      });
      for (const t of tied) {
        usedIncoming.add(t.incoming.id);
      }
      usedOutgoing.add(out.id);
      continue;
    }

    const best = candidates[0];
    if (usedIncoming.has(best.incoming.id)) {
      continue;
    }
    usedIncoming.add(best.incoming.id);
    usedOutgoing.add(out.id);
    pairs.push(best);
  }

  return { pairs, ambiguous };
}

export function findOneSidedTransfers(
  projectTxs: Transaction[],
  maps: OwnBankMaps,
  companyName: string | undefined,
  targetAccountsDimensionsId: number | undefined,
  excludeIds: Set<number>,
): OneSidedTransfer[] {
  const results: OneSidedTransfer[] = [];
  const otherDims = [...maps.ownDimensions];

  for (const tx of projectTxs) {
    if (excludeIds.has(tx.id) || tx.is_deleted) {
      continue;
    }
    const reasons: string[] = [];
    let confidence = 0;
    let targetDim: number | undefined;

    const counterIban = normalizeIban(tx.bank_account_no);
    if (counterIban && maps.ownIbans.has(counterIban)) {
      confidence += 90;
      reasons.push("counterparty_own_iban");
      targetDim = maps.ibanToDimension.get(counterIban);
    }

    const counterName = normalizeName(tx.bank_account_name);
    const company = normalizeName(companyName);
    if (!targetDim && company.length >= 4 && counterName.includes(company)) {
      confidence += 60;
      reasons.push("company_name_match");
      if (targetAccountsDimensionsId != null) {
        targetDim = targetAccountsDimensionsId;
      } else {
        const others = otherDims.filter((d) => d !== tx.accounts_dimensions_id);
        if (others.length === 1) {
          confidence += 20;
          reasons.push("single_other_bank");
          targetDim = others[0];
        }
      }
    }

    if (confidence < 50 || targetDim == null || targetDim === tx.accounts_dimensions_id) {
      continue;
    }
    const targetAccountsId = maps.dimensionToAccountsId.get(targetDim);
    if (targetAccountsId == null) {
      continue;
    }
    results.push({
      transaction: tx,
      confidence: Math.min(100, confidence),
      reasons,
      targetAccountsId,
      targetDimensionId: targetDim,
    });
  }

  return results;
}

export function buildAccountDistribution(
  tx: Pick<Transaction, "amount">,
  accountsId: number,
  dimensionId: number,
): TransactionDistributionRow {
  return {
    related_table: "accounts",
    related_id: accountsId,
    related_sub_id: dimensionId,
    amount: Math.abs(tx.amount),
  };
}

export function journalTransferKey(
  sourceDim: number,
  targetDim: number,
  amount: number,
  date: string,
): string {
  const a = Math.min(sourceDim, targetDim);
  const b = Math.max(sourceDim, targetDim);
  return `${a}|${b}|${Math.round(amount * 100) / 100}|${date}`;
}

export function indexInterAccountJournals(journals: Journal[], maps: OwnBankMaps): Set<string> {
  const keys = new Set<string>();
  for (const j of journals) {
    if (j.is_deleted || !j.postings?.length) {
      continue;
    }
    const bankPostings = j.postings.filter(
      (p) =>
        p.accounts_dimensions_id != null &&
        maps.ownDimensions.has(p.accounts_dimensions_id) &&
        !p.is_deleted,
    );
    if (bankPostings.length !== 2) {
      continue;
    }
    const [p1, p2] = bankPostings;
    const types = new Set([p1.type, p2.type]);
    if (!types.has("D") || !types.has("C")) {
      continue;
    }
    const dim1 = p1.accounts_dimensions_id as number;
    const dim2 = p2.accounts_dimensions_id as number;
    const amount = Math.abs(p1.amount);
    keys.add(journalTransferKey(dim1, dim2, amount, j.effective_date));
  }
  return keys;
}

export function isAlreadyJournalizedTransfer(
  sourceDim: number,
  targetDim: number,
  amount: number,
  date: string,
  journalKeys: Set<string>,
): boolean {
  return journalKeys.has(journalTransferKey(sourceDim, targetDim, amount, date));
}
