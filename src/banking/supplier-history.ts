import type { PurchaseInvoice } from "../types/invoice.js";
import { normalizeName } from "./match-score.js";

export interface BookingSuggestion {
  clients_id: number;
  client_name: string;
  purchase_article_id: number;
  purchase_accounts_dimensions_id?: number;
  vat_rate: number;
  vat_amount: number;
  vat_accounts_id?: number;
}

type PurchaseWithItems = PurchaseInvoice & {
  items?: Array<{
    cl_purchase_articles_id?: number | null;
    purchase_accounts_dimensions_id?: number | null;
    vat_rate_dropdown?: string | null;
    vat_accounts_id?: number | null;
  }>;
};

function invoiceSortKey(inv: PurchaseInvoice): string {
  return inv.create_date ?? inv.invoice_date ?? "";
}

function resolveVatAmount(inv: PurchaseInvoice, vatRate: number, gross: number): number {
  if (inv.vat_price != null) {
    return inv.vat_price;
  }
  if (inv.vat_amount != null) {
    return inv.vat_amount;
  }
  if (vatRate > 0) {
    return gross - gross / (1 + vatRate / 100);
  }
  return 0;
}

function resolveClientName(inv: PurchaseInvoice, fallback: string): string {
  return inv.client_name ?? inv.supplier_name ?? fallback;
}

/**
 * Suggest booking fields from the most recent confirmed purchase invoice
 * for the same supplier (by clients_id or normalized name).
 */
export function suggestBookingFromHistory(
  counterpartyName: string,
  clientsId: number | null | undefined,
  purchases: PurchaseInvoice[],
): BookingSuggestion | null {
  const name = normalizeName(counterpartyName);
  const confirmed = purchases
    .filter((p) => p.status === "CONFIRMED")
    .sort((a, b) => invoiceSortKey(b).localeCompare(invoiceSortKey(a)));

  for (const inv of confirmed) {
    const invName = normalizeName(inv.client_name ?? inv.supplier_name);
    const idMatch = clientsId != null && inv.clients_id === clientsId;
    const nameMatch =
      name.length >= 4 && invName.length >= 4 && (name.includes(invName) || invName.includes(name));
    if (!idMatch && !nameMatch) {
      continue;
    }
    const withItems = inv as PurchaseWithItems;
    const item = withItems.items?.[0];
    const articleId = item?.cl_purchase_articles_id;
    if (articleId == null) {
      continue;
    }
    const vatRate = Number(item?.vat_rate_dropdown ?? 0) || 0;
    const gross = inv.gross_price ?? inv.total_amount ?? 0;
    const vatAmount = resolveVatAmount(inv, vatRate, gross);
    return {
      clients_id: inv.clients_id,
      client_name: resolveClientName(inv, counterpartyName),
      purchase_article_id: articleId,
      purchase_accounts_dimensions_id: item?.purchase_accounts_dimensions_id ?? undefined,
      vat_rate: vatRate,
      vat_amount: Math.round(vatAmount * 100) / 100,
      vat_accounts_id: item?.vat_accounts_id ?? undefined,
    };
  }
  return null;
}
