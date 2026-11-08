import { roundMoney } from "../money.js";
import type { AccountDimension } from "../types/accounts.js";

/**
 * OpenAPI `Currencies` has no minor-unit field. Posted amounts use `roundMoney`
 * (2 decimal places), the same rounding already applied to `base_amount`.
 */
export function roundedPaymentAmount(amount: number): number {
  return roundMoney(amount);
}

export function currencyCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function sameMoney(value: unknown, amount: number): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  return roundMoney(value) === roundMoney(amount);
}

/** YYYY-MM-DD prefix, or "" when the value is not a calendar date. */
export function paymentDay(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

export interface PaymentAccount {
  id: number;
  transaction_out_bindable?: boolean;
  transaction_out_user_bindable?: boolean;
}

export interface PaymentBankAccount {
  accounts_dimensions_id?: unknown;
}

/**
 * Cash/bank means the chart account is selectable for an outgoing payment
 * (`transaction_out_bindable` or `transaction_out_user_bindable`), or a bank
 * account row lists this dimension (`accounts_dimensions_id` in the OpenAPI
 * bank-account example). The dimension currency must be the invoice currency.
 * Returns an error message, or null when the dimension can be used.
 */
export function paymentDimensionError(input: {
  dimensionId: number;
  invoiceCurrency: string;
  dimensions: readonly Pick<AccountDimension, "id" | "accounts_id" | "cl_currencies_id">[];
  accounts: readonly PaymentAccount[];
  bankAccounts: readonly PaymentBankAccount[];
}): string | null {
  const dimension = input.dimensions.find((row) => row.id === input.dimensionId);
  if (!dimension) {
    return `accounts_dimensions_id ${input.dimensionId} was not found.`;
  }
  const invoiceCurrency = currencyCode(input.invoiceCurrency);
  const dimensionCurrency = currencyCode(dimension.cl_currencies_id);
  if (!dimensionCurrency) {
    return `Account dimension ${input.dimensionId} has no currency, so it cannot be checked against the invoice currency ${invoiceCurrency || "unknown"}.`;
  }
  if (dimensionCurrency !== invoiceCurrency) {
    return `Account dimension ${input.dimensionId} is in ${dimensionCurrency}, but the purchase invoice is in ${invoiceCurrency || "unknown"}.`;
  }
  const bankLinked = input.bankAccounts.some(
    (account) => account.accounts_dimensions_id === input.dimensionId,
  );
  if (bankLinked) {
    return null;
  }
  const account = input.accounts.find((row) => row.id === dimension.accounts_id);
  if (!account) {
    return `Account dimension ${input.dimensionId} belongs to account ${dimension.accounts_id}, which was not found, so it cannot be verified as a cash or bank account.`;
  }
  if (account.transaction_out_bindable === true || account.transaction_out_user_bindable === true) {
    return null;
  }
  return `Account dimension ${input.dimensionId} is not a cash or bank account in ${invoiceCurrency}. Chart account ${account.id} is not selectable for outgoing payments, and no bank account lists this dimension.`;
}

export interface InvoiceLinkRef {
  id: number;
  number?: string | null;
  invoice_no?: string | null;
  bank_ref_number?: string | null;
  transactions?: readonly number[] | null;
}

function invoiceTokens(invoice: InvoiceLinkRef): string[] {
  const tokens: string[] = [];
  for (const value of [invoice.number, invoice.invoice_no, String(invoice.id)]) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || tokens.includes(trimmed)) {
      continue;
    }
    tokens.push(trimmed);
  }
  return tokens;
}

function containsToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(text);
}

/** Description, reference, or the invoice's own transaction list. */
export function invoiceLink(
  tx: { id?: number; description?: unknown; ref_number?: unknown },
  invoice: InvoiceLinkRef,
): string | null {
  const tokens = invoiceTokens(invoice);
  if (typeof tx.description === "string") {
    const hit = tokens.find((token) => containsToken(tx.description as string, token));
    if (hit) {
      return `description contains invoice ${hit}`;
    }
  }
  if (typeof tx.ref_number === "string") {
    const ref = tx.ref_number.trim();
    const bankRef =
      typeof invoice.bank_ref_number === "string" ? invoice.bank_ref_number.trim() : "";
    if (ref && tokens.includes(ref)) {
      return "reference number equals the invoice number";
    }
    if (ref && bankRef && ref === bankRef) {
      return "reference number equals the invoice bank reference";
    }
  }
  if (
    typeof tx.id === "number" &&
    Array.isArray(invoice.transactions) &&
    invoice.transactions.includes(tx.id)
  ) {
    return "listed on the purchase invoice";
  }
  return null;
}

export type DistributionLink = "linked" | "absent" | "unrelated" | "invalid";

export function distributionLink(items: unknown, invoiceId: number): DistributionLink {
  if (items == null) {
    return "absent";
  }
  if (!Array.isArray(items)) {
    return "invalid";
  }
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const table = row.relation_table ?? row.related_table;
    const relatedId = row.relation_id ?? row.related_id;
    if (table === "purchase_invoices" && relatedId === invoiceId) {
      return "linked";
    }
  }
  return "unrelated";
}

export interface DuplicateMatch {
  id: number;
  status: string;
  date: string;
  amount: number;
  kind: "outgoing_supplier_draft" | "outgoing_invoice_payment";
  link: string;
}

export function matchSupplierDraft(
  tx: {
    id: number;
    type?: string;
    status?: string;
    clients_id?: number | null;
    amount?: unknown;
    cl_currencies_id?: unknown;
    date?: unknown;
    description?: unknown;
    ref_number?: unknown;
  },
  input: {
    supplierId: number;
    amount: number;
    currency: string;
    date: string;
    invoice: InvoiceLinkRef;
  },
): DuplicateMatch | null {
  if (tx.type !== "D" || tx.status !== "PROJECT" || tx.clients_id !== input.supplierId) {
    return null;
  }
  if (!sameMoney(tx.amount, input.amount)) {
    return null;
  }
  if (currencyCode(tx.cl_currencies_id) !== currencyCode(input.currency)) {
    return null;
  }
  if (paymentDay(tx.date) !== input.date) {
    return null;
  }
  const link = invoiceLink(tx, input.invoice);
  if (!link) {
    return null;
  }
  return {
    id: tx.id,
    status: tx.status,
    date: input.date,
    amount: input.amount,
    kind: "outgoing_supplier_draft",
    link,
  };
}

/** Link text for a confirmed row, before its stored direction is known. */
export function confirmedPaymentLink(
  tx: {
    id?: number;
    status?: string;
    is_deleted?: boolean;
    amount?: unknown;
    cl_currencies_id?: unknown;
    date?: unknown;
    description?: unknown;
    ref_number?: unknown;
    items?: unknown;
  },
  input: { amount: number; currency: string; date: string; invoice: InvoiceLinkRef },
): string | null {
  if (tx.is_deleted === true || tx.status !== "CONFIRMED") {
    return null;
  }
  if (!sameMoney(tx.amount, input.amount)) {
    return null;
  }
  if (currencyCode(tx.cl_currencies_id) !== currencyCode(input.currency)) {
    return null;
  }
  if (paymentDay(tx.date) !== input.date) {
    return null;
  }
  const rows = distributionLink(tx.items, input.invoice.id);
  if (rows === "invalid" || rows === "unrelated") {
    return null;
  }
  if (rows === "linked") {
    return "distribution row for this purchase invoice";
  }
  return invoiceLink(tx, input.invoice) ?? "listed on the purchase invoice";
}

export function duplicatePaymentMessage(
  invoiceId: number,
  matches: readonly DuplicateMatch[],
): string {
  const list = matches
    .map((match) => {
      const kind =
        match.kind === "outgoing_supplier_draft"
          ? "an outgoing PROJECT draft"
          : "an outgoing CONFIRMED payment";
      return `transaction ${match.id} matched as ${kind} (${match.status}, ${match.date}, ${match.amount}; ${match.link})`;
    })
    .join("; ");
  return `Possible duplicate payment for purchase invoice ${invoiceId}: ${list}. Register an existing draft with register_transaction, delete it with delete_transaction, or pass allow_duplicate=true to create another payment.`;
}

export interface RelatedPayment {
  id: number;
  status?: string;
  is_deleted?: boolean;
  direction: "incoming" | "outgoing" | "unknown";
  items?: unknown;
}

export type Remainder =
  | { ok: true; paid: number; remaining: number }
  | { ok: false; reason: string };

interface AppliedAmount {
  ok: true;
  amount: number | null;
}

/**
 * Unpaid remainder of a partly paid invoice.
 * Counts confirmed outgoing distribution rows in the invoice currency.
 * Refuses when settlements, cash-on-invoice, or an unexplained related
 * transaction mean the remainder is not actually known. OpenAPI has no
 * remaining-balance field.
 */
export function unpaidRemainder(input: {
  invoiceId: number;
  gross: unknown;
  currency: string;
  settlements: unknown;
  paidInCash: unknown;
  transactionIds: unknown;
  related: readonly RelatedPayment[];
}): Remainder {
  if (!Array.isArray(input.settlements)) {
    return { ok: false, reason: "related settlements were not on the purchase invoice" };
  }
  if (input.settlements.length > 0) {
    return { ok: false, reason: "related settlements have no amounts in the API" };
  }
  if (input.paidInCash === true) {
    return {
      ok: false,
      reason: "paid_in_cash is set, and that cash portion is not a remaining balance",
    };
  }
  if (!Array.isArray(input.transactionIds)) {
    return { ok: false, reason: "related transactions were not on the purchase invoice" };
  }
  if (typeof input.gross !== "number" || !Number.isFinite(input.gross) || !(input.gross > 0)) {
    return { ok: false, reason: "the invoice has no positive gross price" };
  }
  const currency = currencyCode(input.currency);
  if (!currency) {
    return { ok: false, reason: "the invoice currency is missing" };
  }

  let paid = 0;
  let applied = false;
  for (const id of input.transactionIds) {
    if (typeof id !== "number") {
      return { ok: false, reason: "a related transaction id was not a number" };
    }
    const tx = input.related.find((row) => row.id === id);
    if (!tx) {
      return { ok: false, reason: `transaction ${id} could not be read` };
    }
    if (tx.is_deleted === true || tx.status === "VOID" || tx.status === "PROJECT") {
      continue;
    }
    if (tx.status !== "CONFIRMED") {
      return {
        ok: false,
        reason: `transaction ${id} has status ${tx.status ?? "unknown"}`,
      };
    }
    if (tx.direction !== "outgoing") {
      return {
        ok: false,
        reason: `transaction ${id} is ${tx.direction}, not an outgoing payment`,
      };
    }
    const portion = appliedAmount(tx.items, input.invoiceId, currency, id);
    if (!portion.ok) {
      return portion;
    }
    if (portion.amount == null) {
      return {
        ok: false,
        reason: `transaction ${id} has no distribution for this purchase invoice`,
      };
    }
    paid = roundMoney(paid + portion.amount);
    applied = true;
  }
  if (!applied) {
    return {
      ok: false,
      reason: "no confirmed outgoing payment applied to this purchase invoice was found",
    };
  }
  const gross = roundMoney(input.gross);
  if (paid > gross) {
    return { ok: false, reason: `applied payments ${paid} exceed the gross price ${gross}` };
  }
  return { ok: true, paid, remaining: roundMoney(gross - paid) };
}

function appliedAmount(
  items: unknown,
  invoiceId: number,
  currency: string,
  transactionId: number,
): AppliedAmount | { ok: false; reason: string } {
  if (!Array.isArray(items)) {
    return {
      ok: false,
      reason: `transaction ${transactionId} has no distribution rows`,
    };
  }
  let sum = 0;
  let linked = false;
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const table = row.relation_table ?? row.related_table;
    const relatedId = row.relation_id ?? row.related_id;
    if (table !== "purchase_invoices" || relatedId !== invoiceId) {
      continue;
    }
    const itemCurrency = currencyCode(row.cl_currencies_id);
    if (itemCurrency && itemCurrency !== currency) {
      return {
        ok: false,
        reason: `transaction ${transactionId} has a distribution in ${itemCurrency}, not ${currency}`,
      };
    }
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) {
      return {
        ok: false,
        reason: `transaction ${transactionId} has a distribution without a numeric amount`,
      };
    }
    sum = roundMoney(sum + roundMoney(row.amount));
    linked = true;
  }
  return { ok: true, amount: linked ? sum : null };
}
