import type { InvoiceSeries } from "../types/invoiceSettings.js";

export type InvoiceNumberFields = {
  number_prefix?: string | null;
  number_suffix?: string | number | null;
};

/** Normalize GET /v1/invoice_series (raw array or `{ items }`). */
export function extractSeriesList(response: unknown): InvoiceSeries[] {
  if (Array.isArray(response)) {
    return response as InvoiceSeries[];
  }
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return obj.items as InvoiceSeries[];
    }
  }
  return [];
}

function parseUsableSuffix(value: unknown): number | undefined {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw) || raw.length >= 13) {
    return undefined;
  }
  return Number(raw);
}

/**
 * Next sales-invoice `number_suffix` for the default (else first) series.
 * Never uses Date.now(); leftover 13-digit timestamp suffixes are ignored.
 */
export function nextSalesInvoiceSuffix(
  seriesList: Array<Partial<InvoiceSeries>>,
  invoices: InvoiceNumberFields[],
): string {
  const series = seriesList.find((s) => s.is_default === true) ?? seriesList[0];
  const prefix = series?.number_prefix;
  const start =
    typeof series?.number_start_value === "number" && Number.isFinite(series.number_start_value)
      ? series.number_start_value
      : 1;

  const candidates =
    prefix == null || prefix === ""
      ? invoices
      : invoices.filter((inv) => {
          const invPrefix = inv.number_prefix ?? "";
          return invPrefix === "" || invPrefix === prefix;
        });

  let max: number | undefined;
  for (const inv of candidates) {
    const n = parseUsableSuffix(inv.number_suffix);
    if (n !== undefined && (max === undefined || n > max)) {
      max = n;
    }
  }
  return String(max === undefined ? start : max + 1);
}
