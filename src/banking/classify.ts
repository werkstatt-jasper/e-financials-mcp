import type { Transaction } from "../types/transaction.js";
import { normalizeName } from "./match-score.js";
import type { BookingSuggestion } from "./supplier-history.js";

export type ClassifyCategory =
  | "bank_fees"
  | "tax_payments"
  | "owner_transfers"
  | "revenue_without_invoice"
  | "salary_payroll"
  | "saas_subscriptions"
  | "card_purchases"
  | "unknown";

export type ApplyMode = "purchase_invoice" | "review_only";

export interface TransactionGroup {
  counterparty: string;
  category: ClassifyCategory;
  apply_mode: ApplyMode;
  recurring: boolean;
  similar_amounts: boolean;
  transaction_ids: number[];
  transactions: Array<{
    id: number;
    date: string;
    amount: number;
    type: "C" | "D";
    description: string;
    clients_id: number | null;
  }>;
  suggested_booking: BookingSuggestion | null;
}

const BANK_NAME = /\b(swedbank|seb|lhv|luminor|coop\s*pank|bank)\b/i;
const FEE_TEXT = /\b(fee|teenustasu|kuutasu|commission)\b/i;
const TAX_TEXT = /\b(emta|maksu|tax\s*board|töötulu)\b/i;
const OWNER_TEXT = /\b(owner|dividend|osanik|laen\s*omanik)\b/i;
const CARD_TEXT = /\b(bolt|uber|wolt|card|pos|terminal)\b/i;
const PERSON_LIKE = /^[A-ZÁÉÍÓÚÄÖÜÕŠŽ][a-záéíóúäöüõšž]+(\s+[A-ZÁÉÍÓÚÄÖÜÕŠŽ][a-záéíóúäöüõšž]+)+$/;
const COMPANY_TOKEN = /\b(o[uü]|as|llc|ltd|inc|gmbh|labs|bank|emta|saas|oy|ab)\b/i;

export function counterpartyKey(tx: Transaction): string {
  const name = normalizeName(tx.bank_account_name);
  if (name) {
    return name;
  }
  const desc = normalizeName(tx.description);
  return desc || "unknown";
}

function amountsSimilar(txs: Transaction[]): boolean {
  if (txs.length < 2) {
    return false;
  }
  const amounts = txs.map((t) => Math.abs(t.amount));
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const tol = Math.max(2, avg * 0.05);
  return amounts.every((a) => Math.abs(a - avg) <= tol);
}

export function categorizeTransactionGroup(
  counterparty: string,
  txs: Transaction[],
): { category: ClassifyCategory; apply_mode: ApplyMode } {
  if (txs.length === 0) {
    return { category: "unknown", apply_mode: "review_only" };
  }
  const sample = txs[0] as Transaction;
  const blob = `${counterparty} ${sample.description}`;
  const recurring = txs.length >= 2;
  const similar = amountsSimilar(txs);
  const outgoing = txs.every((t) => t.type === "D");
  const incoming = txs.every((t) => t.type === "C");
  const maxAbs = Math.max(...txs.map((t) => Math.abs(t.amount)));

  if (
    (BANK_NAME.test(blob) && FEE_TEXT.test(blob)) ||
    (outgoing && maxAbs <= 20 && FEE_TEXT.test(blob))
  ) {
    return { category: "bank_fees", apply_mode: "purchase_invoice" };
  }
  if (TAX_TEXT.test(blob)) {
    return { category: "tax_payments", apply_mode: "review_only" };
  }
  if (OWNER_TEXT.test(blob)) {
    return { category: "owner_transfers", apply_mode: "review_only" };
  }
  if (incoming) {
    return { category: "revenue_without_invoice", apply_mode: "review_only" };
  }
  const counterpartyRaw = (sample.bank_account_name ?? "").trim();
  if (
    recurring &&
    similar &&
    PERSON_LIKE.test(counterpartyRaw) &&
    !COMPANY_TOKEN.test(counterpartyRaw)
  ) {
    return { category: "salary_payroll", apply_mode: "review_only" };
  }
  if (recurring && similar) {
    return { category: "saas_subscriptions", apply_mode: "purchase_invoice" };
  }
  if (CARD_TEXT.test(blob)) {
    return { category: "card_purchases", apply_mode: "purchase_invoice" };
  }
  return { category: "unknown", apply_mode: "review_only" };
}

/** Downgrade auto-book categories to review when no concrete history suggestion (except bank_fees). */
export function resolveApplyMode(
  category: ClassifyCategory,
  baseMode: ApplyMode,
  suggestion: BookingSuggestion | null,
): ApplyMode {
  if (baseMode !== "purchase_invoice") {
    return "review_only";
  }
  if (category === "bank_fees") {
    return "purchase_invoice";
  }
  if (suggestion?.purchase_article_id != null) {
    return "purchase_invoice";
  }
  return "review_only";
}

export function groupTransactions(txs: Transaction[]): Map<string, Transaction[]> {
  const map = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const key = counterpartyKey(tx);
    const list = map.get(key) ?? [];
    list.push(tx);
    map.set(key, list);
  }
  return map;
}

export function defaultBankFeeSuggestion(
  counterparty: string,
  clientsId: number | null,
): BookingSuggestion | null {
  if (clientsId == null) {
    return null;
  }
  return {
    clients_id: clientsId,
    client_name: counterparty,
    purchase_article_id: 39,
    vat_rate: 0,
    vat_amount: 0,
  };
}
