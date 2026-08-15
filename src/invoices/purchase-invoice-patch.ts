/**
 * RIK `PATCH /v1/purchase_invoices/{id}` is not a partial update.
 * A body with only `vat_price` / `gross_price` is rejected as
 * "Products/services are missing!" (GitLab #202). Always send `items`.
 */

export type PurchaseInvoicePatchItem = Record<string, unknown>;

export type PurchaseInvoiceTotalsPatch = {
  vat_price: number;
  gross_price: number;
  items: PurchaseInvoicePatchItem[];
};

/**
 * Build a totals-repair PATCH body. `items` is always present so callers
 * cannot accidentally omit line items.
 */
export function buildPurchaseInvoiceTotalsPatch(input: {
  vat_price: number;
  gross_price: number;
  items: PurchaseInvoicePatchItem[];
}): PurchaseInvoiceTotalsPatch {
  return {
    vat_price: input.vat_price,
    gross_price: input.gross_price,
    items: input.items,
  };
}
