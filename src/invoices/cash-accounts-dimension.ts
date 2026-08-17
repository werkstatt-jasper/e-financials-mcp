/**
 * RIK OpenAPI types `cash_accounts_dimensions_id` as an integer, and GET
 * returns an integer. POST/PATCH with that integer still raises
 * "Invalid accounts_id missing for dimension" (v1_purchase_invoices.py).
 * Nested objects are rejected as non-integers. Omitting the field on a
 * full-header PATCH clears a stored dimension. There is no API write shape
 * that sets or preserves the field (demo 2026-08-17).
 */

export const CASH_ACCOUNTS_DIMENSION_WRITE_ERROR =
  "RIK e-Financials rejects cash_accounts_dimensions_id on purchase-invoice create/update " +
  "(Invalid accounts_id missing for dimension). OpenAPI types it as an integer; nested objects " +
  "are also rejected. Set the cash dimension in the e-Financials web UI. " +
  "paid_in_cash, cash_accounts_id, and cash_payment_date still work via the API.";

export const CASH_ACCOUNTS_DIMENSION_PRESERVE_ERROR =
  "This purchase invoice already has cash_accounts_dimensions_id set. RIK rejects PATCH when " +
  "that field is sent, and omitting it clears the dimension. Change this invoice in the " +
  "e-Financials web UI.";

export function assertCashAccountsDimensionWritable(input: {
  requested?: unknown;
  current?: unknown;
}): void {
  if (input.requested != null) {
    throw new Error(CASH_ACCOUNTS_DIMENSION_WRITE_ERROR);
  }
  if (input.current != null) {
    throw new Error(CASH_ACCOUNTS_DIMENSION_PRESERVE_ERROR);
  }
}
