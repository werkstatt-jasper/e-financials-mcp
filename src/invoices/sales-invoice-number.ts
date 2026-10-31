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

function startValue(series: Partial<InvoiceSeries> | undefined): number {
  return typeof series?.number_start_value === "number" &&
    Number.isFinite(series.number_start_value)
    ? series.number_start_value
    : 1;
}

function maxUsableSuffix(invoices: InvoiceNumberFields[]): number | undefined {
  let max: number | undefined;
  for (const inv of invoices) {
    const n = parseUsableSuffix(inv.number_suffix);
    if (n !== undefined && (max === undefined || n > max)) {
      max = n;
    }
  }
  return max;
}

/**
 * `number_prefix` of the series flagged `is_default`, or undefined when no
 * series is flagged default or its prefix is empty.
 */
export function defaultSalesInvoicePrefix(
  seriesList: Array<Partial<InvoiceSeries>>,
): string | undefined {
  const prefix = seriesList.find((s) => s.is_default === true)?.number_prefix;
  return typeof prefix === "string" && prefix !== "" ? prefix : undefined;
}

/**
 * Next `number_suffix` for one non-empty `number_prefix`. Only invoices with
 * exactly that prefix count, so prefix-less or other-series invoices never
 * advance it. Falls back to the matching series' `number_start_value` (else 1).
 */
export function nextSalesInvoiceSuffixForPrefix(
  seriesList: Array<Partial<InvoiceSeries>>,
  invoices: InvoiceNumberFields[],
  prefix: string,
): string {
  const matching = seriesList.filter((s) => s.number_prefix === prefix);
  const series = matching.find((s) => s.is_default === true) ?? matching[0];
  const max = maxUsableSuffix(invoices.filter((inv) => inv.number_prefix === prefix));
  return String(max === undefined ? startValue(series) : max + 1);
}

/**
 * Next sales-invoice `number_suffix` for the default (else first) series.
 * Never uses Date.now(); leftover 13-digit timestamp suffixes are ignored.
 * Used only when no prefix is attached to the new invoice; with a prefix, use
 * {@link nextSalesInvoiceSuffixForPrefix}.
 */
export function nextSalesInvoiceSuffix(
  seriesList: Array<Partial<InvoiceSeries>>,
  invoices: InvoiceNumberFields[],
): string {
  const series = seriesList.find((s) => s.is_default === true) ?? seriesList[0];
  const prefix = series?.number_prefix;
  const start = startValue(series);

  const candidates =
    prefix == null || prefix === ""
      ? invoices
      : invoices.filter((inv) => {
          const invPrefix = inv.number_prefix ?? "";
          return invPrefix === "" || invPrefix === prefix;
        });

  const max = maxUsableSuffix(candidates);
  return String(max === undefined ? start : max + 1);
}
