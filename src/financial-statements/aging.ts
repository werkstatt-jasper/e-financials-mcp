import { roundMoney } from "../money.js";

/** Invoice fields needed for receivables/payables aging. */
export interface AgingInvoice {
  id: number;
  number?: string | null;
  clients_id?: number | null;
  client_name?: string | null;
  create_date?: string | null;
  term_days?: number | null;
  status?: string | null;
  payment_status?: string | null;
  gross_price?: number | null;
  base_gross_price?: number | null;
}

export type AgingBucketLabel = "current" | "1-30" | "31-60" | "61-90" | "90+";

const BUCKET_ORDER: AgingBucketLabel[] = ["current", "1-30", "31-60", "61-90", "90+"];

export interface AgingInvoiceRow {
  id: number;
  number: string | null;
  client: string | null;
  amount: number;
  payment_status: string | null;
  days_overdue: number;
}

export interface AgingBucket {
  label: AgingBucketLabel;
  count: number;
  total: number;
  invoices: AgingInvoiceRow[];
}

export interface AgingCounterparty {
  clients_id: number;
  name: string | null;
  total: number;
  oldest_days: number;
}

export interface UnmatchedInvoices {
  count: number;
  total: number;
  oldest_days: number;
}

export interface AgingResult {
  as_of_date: string;
  total_unpaid_face_value: number;
  total_invoices: number;
  partially_paid_count: number;
  aging_buckets: AgingBucket[];
  top_counterparties: AgingCounterparty[];
  unmatched_invoices?: UnmatchedInvoices;
  warnings: string[];
}

const PARTIAL_PAY_WARNING =
  "PARTIALLY_PAID invoices are included at full face value — the API does not expose remaining balance, so outstanding amounts may be overstated.";

const MISSING_CREATE_DATE_WARNING =
  "One or more invoices lack create_date; due date could not be computed and they were placed in the current bucket.";

/**
 * Prefer base-currency gross, fall back to document currency gross.
 * Both missing → 0 and a warning string (caller may collect).
 */
export function effectiveGross(inv: AgingInvoice): { amount: number; warning?: string } {
  const value = inv.base_gross_price ?? inv.gross_price;
  if (value == null) {
    return {
      amount: 0,
      warning: `Invoice ${inv.id} has no gross_price or base_gross_price — treating as 0`,
    };
  }
  return { amount: value };
}

/** Calendar days between two YYYY-MM-DD strings (UTC noon to avoid DST). */
export function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const to = Date.parse(`${toYmd}T12:00:00Z`);
  return Math.floor((to - from) / 86_400_000);
}

/** Add calendar days to a YYYY-MM-DD string (UTC noon). */
export function addCalendarDays(ymd: string, days: number): string {
  const dt = new Date(`${ymd}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Due date = create_date + term_days. Returns null when create_date is missing.
 */
export function invoiceDueDate(inv: AgingInvoice): string | null {
  if (inv.create_date == null || inv.create_date === "") {
    return null;
  }
  const term =
    typeof inv.term_days === "number" && Number.isFinite(inv.term_days) ? inv.term_days : 0;
  return addCalendarDays(inv.create_date, term);
}

export function bucketLabel(daysOverdue: number): AgingBucketLabel {
  if (daysOverdue <= 0) {
    return "current";
  }
  if (daysOverdue <= 30) {
    return "1-30";
  }
  if (daysOverdue <= 60) {
    return "31-60";
  }
  if (daysOverdue <= 90) {
    return "61-90";
  }
  return "90+";
}

function todayUtcYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build receivables/payables aging from unpaid confirmed invoices.
 * Caller supplies already-fetched invoices; filtering is client-side.
 */
export function computeAging(
  invoices: AgingInvoice[],
  asOfDate: string = todayUtcYmd(),
): AgingResult {
  const warnings: string[] = [];
  const warningSet = new Set<string>();
  const pushWarning = (w: string) => {
    if (!warningSet.has(w)) {
      warningSet.add(w);
      warnings.push(w);
    }
  };

  type WorkRow = AgingInvoiceRow & {
    clients_id: number | null;
    raw_days: number;
    bucket: AgingBucketLabel;
  };

  const rows: WorkRow[] = [];
  let partiallyPaidCount = 0;
  let missingCreateDate = false;

  for (const inv of invoices) {
    if (inv.status !== "CONFIRMED") {
      continue;
    }
    if (inv.payment_status === "PAID") {
      continue;
    }

    if (inv.payment_status === "PARTIALLY_PAID") {
      partiallyPaidCount += 1;
    }

    const { amount, warning } = effectiveGross(inv);
    if (warning) {
      pushWarning(warning);
    }

    const due = invoiceDueDate(inv);
    let rawDays: number;
    if (due == null) {
      missingCreateDate = true;
      rawDays = 0;
    } else {
      rawDays = calendarDaysBetween(due, asOfDate);
    }

    const clientsId = inv.clients_id == null ? null : inv.clients_id;
    rows.push({
      id: inv.id,
      number: inv.number ?? null,
      client: inv.client_name ?? null,
      amount: roundMoney(amount),
      payment_status: inv.payment_status ?? null,
      days_overdue: Math.max(0, rawDays),
      clients_id: clientsId,
      raw_days: rawDays,
      bucket: bucketLabel(rawDays),
    });
  }

  if (partiallyPaidCount > 0) {
    pushWarning(PARTIAL_PAY_WARNING);
  }
  if (missingCreateDate) {
    pushWarning(MISSING_CREATE_DATE_WARNING);
  }

  const bucketMap = new Map<AgingBucketLabel, WorkRow[]>();
  for (const label of BUCKET_ORDER) {
    bucketMap.set(label, []);
  }
  for (const row of rows) {
    bucketMap.get(row.bucket)?.push(row);
  }

  const aging_buckets: AgingBucket[] = [];
  for (const label of BUCKET_ORDER) {
    // Every label is pre-seeded in bucketMap above.
    const list = bucketMap.get(label) as WorkRow[];
    if (list.length === 0) {
      continue;
    }
    const sorted = [...list].sort((a, b) => b.amount - a.amount);
    aging_buckets.push({
      label,
      count: sorted.length,
      total: roundMoney(sorted.reduce((s, r) => s + r.amount, 0)),
      invoices: sorted
        .slice(0, 10)
        .map(({ id, number, client, amount, payment_status, days_overdue }) => ({
          id,
          number,
          client,
          amount,
          payment_status,
          days_overdue,
        })),
    });
  }

  const byClient = new Map<number, { name: string | null; total: number; oldest_days: number }>();
  let unmatchedCount = 0;
  let unmatchedTotal = 0;
  let unmatchedOldest = 0;

  for (const row of rows) {
    if (row.clients_id == null) {
      unmatchedCount += 1;
      unmatchedTotal += row.amount;
      unmatchedOldest = Math.max(unmatchedOldest, row.days_overdue);
      continue;
    }
    const existing = byClient.get(row.clients_id);
    if (existing == null) {
      byClient.set(row.clients_id, {
        name: row.client,
        total: row.amount,
        oldest_days: row.days_overdue,
      });
    } else {
      existing.total = roundMoney(existing.total + row.amount);
      existing.oldest_days = Math.max(existing.oldest_days, row.days_overdue);
      if (existing.name == null && row.client != null) {
        existing.name = row.client;
      }
    }
  }

  const top_counterparties = [...byClient.entries()]
    .map(([clients_id, v]) => ({
      clients_id,
      name: v.name,
      total: roundMoney(v.total),
      oldest_days: v.oldest_days,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  let unmatched_invoices: UnmatchedInvoices | undefined;
  if (unmatchedCount > 0) {
    unmatched_invoices = {
      count: unmatchedCount,
      total: roundMoney(unmatchedTotal),
      oldest_days: unmatchedOldest,
    };
    pushWarning(
      `${unmatchedCount} invoice(s) have no clients_id and were excluded from top counterparties.`,
    );
  }

  return {
    as_of_date: asOfDate,
    total_unpaid_face_value: roundMoney(rows.reduce((s, r) => s + r.amount, 0)),
    total_invoices: rows.length,
    partially_paid_count: partiallyPaidCount,
    aging_buckets,
    top_counterparties,
    unmatched_invoices,
    warnings,
  };
}
