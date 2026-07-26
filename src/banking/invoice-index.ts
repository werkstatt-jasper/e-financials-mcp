import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import type { Transaction } from "../types/transaction.js";
import {
  canAutoDistribute,
  type InvoiceMatchResult,
  invoiceEligibleForTransaction,
  invoiceGross,
  type MatchableInvoice,
  scoreTransactionToInvoice,
} from "./match-score.js";

export function isOpenInvoice(invoice: {
  status?: string | null;
  payment_status?: string | null;
}): boolean {
  if (invoice.status != null && invoice.status !== "CONFIRMED") {
    return false;
  }
  return invoice.payment_status !== "PAID";
}

export function toMatchableSale(invoice: SalesInvoice): MatchableInvoice {
  return {
    id: invoice.id,
    kind: "sale",
    clients_id: invoice.clients_id,
    client_name: invoice.client_name,
    gross_price: invoice.gross_price,
    total_amount: invoice.total_amount,
    bank_ref_number: (invoice as { bank_ref_number?: string | null }).bank_ref_number,
    payment_status: invoice.payment_status,
    status: invoice.status,
    cl_currencies_id: invoice.cl_currencies_id,
  };
}

export function toMatchablePurchase(invoice: PurchaseInvoice): MatchableInvoice {
  return {
    id: invoice.id,
    kind: "purchase",
    clients_id: invoice.clients_id,
    client_name: invoice.client_name ?? invoice.supplier_name,
    gross_price: invoice.gross_price,
    total_amount: invoice.total_amount,
    bank_ref_number: (invoice as { bank_ref_number?: string | null }).bank_ref_number,
    payment_status: invoice.payment_status,
    status: invoice.status,
    cl_currencies_id: invoice.cl_currencies_id,
  };
}

export function buildOpenInvoicePool(
  sales: SalesInvoice[],
  purchases: PurchaseInvoice[],
): MatchableInvoice[] {
  return [
    ...sales.filter(isOpenInvoice).map(toMatchableSale),
    ...purchases.filter(isOpenInvoice).map(toMatchablePurchase),
  ];
}

function amountBucket(amount: number): number {
  return Math.round(amount);
}

export interface InvoiceIndexes {
  byRef: Map<string, MatchableInvoice[]>;
  byAmount: Map<number, MatchableInvoice[]>;
  all: MatchableInvoice[];
}

export function buildInvoiceIndexes(invoices: MatchableInvoice[]): InvoiceIndexes {
  const byRef = new Map<string, MatchableInvoice[]>();
  const byAmount = new Map<number, MatchableInvoice[]>();

  for (const inv of invoices) {
    const ref = (inv.bank_ref_number ?? "").trim();
    if (ref) {
      const list = byRef.get(ref) ?? [];
      list.push(inv);
      byRef.set(ref, list);
    }
    const bucket = amountBucket(invoiceGross(inv));
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const list = byAmount.get(b) ?? [];
      list.push(inv);
      byAmount.set(b, list);
    }
  }

  return { byRef, byAmount, all: invoices };
}

export function candidateInvoicesForTransaction(
  tx: Pick<Transaction, "amount" | "ref_number" | "type">,
  indexes: InvoiceIndexes,
): MatchableInvoice[] {
  const seen = new Set<string>();
  const out: MatchableInvoice[] = [];

  const push = (inv: MatchableInvoice) => {
    if (!invoiceEligibleForTransaction(tx.type, inv.kind)) {
      return;
    }
    const key = `${inv.kind}:${inv.id}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(inv);
  };

  const ref = (tx.ref_number ?? "").trim();
  if (ref) {
    for (const inv of indexes.byRef.get(ref) ?? []) {
      push(inv);
    }
  }

  const bucket = amountBucket(Math.abs(tx.amount));
  for (const b of [bucket - 1, bucket, bucket + 1]) {
    for (const inv of indexes.byAmount.get(b) ?? []) {
      push(inv);
    }
  }

  // Fallback: if indexes empty for this tx, scan all eligible
  if (out.length === 0) {
    for (const inv of indexes.all) {
      push(inv);
    }
  }

  return out;
}

export interface RankedInvoiceMatch {
  best: InvoiceMatchResult | null;
  otherCandidateCount: number;
  allAboveThreshold: InvoiceMatchResult[];
}

export function rankInvoiceMatches(
  tx: Pick<
    Transaction,
    "amount" | "base_amount" | "ref_number" | "clients_id" | "bank_account_name" | "type"
  >,
  candidates: MatchableInvoice[],
  minConfidence: number,
): RankedInvoiceMatch {
  const scored = candidates
    .map((inv) => scoreTransactionToInvoice(tx, inv))
    .filter((m) => m.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);

  return {
    best: scored[0] ?? null,
    otherCandidateCount: Math.max(0, scored.length - 1),
    allAboveThreshold: scored,
  };
}

export function invoiceConsumptionKey(invoice: MatchableInvoice): string {
  return `${invoice.kind}:${invoice.id}`;
}

export { canAutoDistribute };
