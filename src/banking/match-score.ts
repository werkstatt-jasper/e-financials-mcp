import type { Transaction, TransactionDistributionRow } from "../types/transaction.js";

/** Invoice shape used for bank reconciliation matching. */
export interface MatchableInvoice {
  id: number;
  kind: "sale" | "purchase";
  clients_id: number | null;
  client_name?: string | null;
  gross_price?: number | null;
  total_amount?: number | null;
  base_amount?: number | null;
  bank_ref_number?: string | null;
  payment_status?: "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | null;
  status?: "PROJECT" | "CONFIRMED" | "VOID";
  cl_currencies_id?: string | null;
}

export interface InvoiceMatchResult {
  invoice: MatchableInvoice;
  confidence: number;
  reasons: string[];
  /** True when match is only via base currency (FX) without nominal amount match. */
  baseOnlyMatch: boolean;
  partiallyPaid: boolean;
}

export function invoiceGross(invoice: MatchableInvoice): number {
  return invoice.gross_price ?? invoice.total_amount ?? 0;
}

export function amountsClose(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

export function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Score a transaction against an open invoice.
 * Our convention: C = money in → sale invoices; D = money out → purchase invoices.
 */
export function scoreTransactionToInvoice(
  tx: Pick<
    Transaction,
    "amount" | "base_amount" | "ref_number" | "clients_id" | "bank_account_name" | "type"
  >,
  invoice: MatchableInvoice,
): InvoiceMatchResult {
  const reasons: string[] = [];
  let confidence = 0;
  let baseOnlyMatch = false;

  const invAmount = invoiceGross(invoice);
  const txAmount = Math.abs(tx.amount);
  const txBase = Math.abs(tx.base_amount ?? tx.amount);
  const invBase = Math.abs(invoice.base_amount ?? invAmount);

  const exactNominal = amountsClose(txAmount, invAmount);
  const exactBase = amountsClose(txBase, invBase);
  const closeNominal = amountsClose(txAmount, invAmount, 1);

  if (exactNominal) {
    confidence += 40;
    reasons.push("exact_amount");
  } else if (exactBase && !exactNominal) {
    confidence += 40;
    reasons.push("exact_base_amount");
    baseOnlyMatch = true;
  } else if (closeNominal) {
    confidence += 20;
    reasons.push("close_amount");
  }

  const txRef = (tx.ref_number ?? "").trim();
  const invRef = (invoice.bank_ref_number ?? "").trim();
  if (txRef && invRef && txRef === invRef) {
    confidence += 40;
    reasons.push("ref_number");
  }

  if (tx.clients_id != null && invoice.clients_id != null && tx.clients_id === invoice.clients_id) {
    confidence += 15;
    reasons.push("client_id");
  }

  const txName = normalizeName(tx.bank_account_name);
  const invName = normalizeName(invoice.client_name);
  if (
    txName.length >= 4 &&
    invName.length >= 4 &&
    (txName.includes(invName) || invName.includes(txName))
  ) {
    confidence += 10;
    reasons.push("client_name_partial");
  }

  const partiallyPaid = invoice.payment_status === "PARTIALLY_PAID";
  if (partiallyPaid) {
    confidence -= 15;
    reasons.push("partially_paid_warning");
  }

  confidence = Math.max(0, Math.min(100, confidence));

  return { invoice, confidence, reasons, baseOnlyMatch, partiallyPaid };
}

/** Whether this invoice kind is eligible for the transaction direction. */
export function invoiceEligibleForTransaction(
  txType: "C" | "D",
  invoiceKind: "sale" | "purchase",
): boolean {
  if (txType === "C") {
    return invoiceKind === "sale";
  }
  return invoiceKind === "purchase";
}

export function buildInvoiceDistribution(
  tx: Pick<Transaction, "amount">,
  invoice: MatchableInvoice,
): TransactionDistributionRow {
  return {
    related_table: invoice.kind === "sale" ? "sale_invoices" : "purchase_invoices",
    related_id: invoice.id,
    amount: Math.abs(tx.amount),
  };
}

/** Distribution is safe for auto-confirm when not partially paid and not FX-only. */
export function canAutoDistribute(match: InvoiceMatchResult): boolean {
  return !match.partiallyPaid && !match.baseOnlyMatch && match.confidence > 0;
}
