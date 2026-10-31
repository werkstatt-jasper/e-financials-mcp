/**
 * Sales invoice due dates.
 *
 * The RIK API stores a payment term (`term_days`) on the invoice, not a due
 * date. The due date is `create_date + term_days` (calendar days, UTC).
 */

const DAY_MS = 86_400_000;

function ymdToUtcMs(ymd: string): number {
  return Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
}

/**
 * Whole calendar days from `invoiceDate` to `dueDate`. Returns a negative
 * number when the due date is before the invoice date, or null when either
 * date cannot be parsed.
 */
export function daysBetweenYmd(invoiceDate: string, dueDate: string): number | null {
  const from = ymdToUtcMs(invoiceDate);
  const to = ymdToUtcMs(dueDate);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return null;
  }
  return Math.round((to - from) / DAY_MS);
}

/** Due date (YYYY-MM-DD) from `create_date` + `term_days`, or undefined when unknown. */
export function salesInvoiceDueDate(inv: {
  create_date?: unknown;
  term_days?: unknown;
}): string | undefined {
  if (typeof inv.create_date !== "string" || inv.create_date === "") {
    return undefined;
  }
  if (typeof inv.term_days !== "number" || !Number.isFinite(inv.term_days)) {
    return undefined;
  }
  const start = ymdToUtcMs(inv.create_date);
  if (Number.isNaN(start)) {
    return undefined;
  }
  return new Date(start + Math.round(inv.term_days) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Add a derived `due_date` to a sales invoice read from the API. An existing
 * non-empty `due_date` is kept as-is; nothing is added when it can't be derived.
 */
export function withSalesInvoiceDueDate<T>(invoice: T): T {
  if (invoice === null || typeof invoice !== "object" || Array.isArray(invoice)) {
    return invoice;
  }
  const record = invoice as Record<string, unknown>;
  if (typeof record.due_date === "string" && record.due_date !== "") {
    return invoice;
  }
  const dueDate = salesInvoiceDueDate(record);
  if (dueDate === undefined) {
    return invoice;
  }
  return { ...record, due_date: dueDate } as T;
}
