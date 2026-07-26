/**
 * Date-gated Estonian standard VAT rates and related reference data (KMS / TuMS).
 * Figures for later advisory resources (#120); consumers read from this module.
 */

export interface VatRatePeriod {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD), or null while still in force. */
  to: string | null;
  /** Rate in percent. */
  rate: number;
}

/** Standard VAT rate timeline (KMS § 15 lg 1): 20% → 22% (2024-01-01) → 24% (2025-07-01). */
export const STANDARD_VAT_RATE_TIMELINE: readonly VatRatePeriod[] = [
  { from: "2009-07-01", to: "2023-12-31", rate: 20 },
  { from: "2024-01-01", to: "2025-06-30", rate: 22 },
  { from: "2025-07-01", to: null, rate: 24 },
];

export interface ReducedVatRate {
  rate: number;
  applies: string;
  from: string | null;
  basis: string;
}

export const REDUCED_VAT_RATES: readonly ReducedVatRate[] = [
  {
    rate: 13,
    applies: "accommodation (majutus)",
    from: "2025-01-01",
    basis: "KMS § 15",
  },
  {
    rate: 9,
    applies: "books, press, medicine / medical devices",
    from: "2025-01-01",
    basis: "KMS § 15",
  },
  {
    rate: 0,
    applies: "export / intra-community supply",
    from: null,
    basis: "KMS § 15 lg 3–4",
  },
];

export interface TaxRuleReference {
  code: string;
  title: string;
  summary: string;
  basis: string;
}

/** Deduction-restriction references for later tax-rules MCP resource (#120). */
export const DEDUCTION_AND_LIMIT_RULES: readonly TaxRuleReference[] = [
  {
    code: "KMS § 30",
    title: "Representation / guest entertainment — input VAT generally non-deductible",
    summary:
      "Input VAT on guest/partner entertainment (meals, entertainment) is generally not deductible.",
    basis: "KMS § 30",
  },
  {
    code: "KMS § 30 lg 4",
    title: "Passenger car (M1) input VAT 50% restriction",
    summary:
      "Input VAT on M1 passenger car purchase/use is generally 50% deductible unless an exception applies.",
    basis: "KMS § 30 lg 4; KMS § 29 lg 1",
  },
  {
    code: "TuMS § 49 lg 4",
    title: "Tax-free representation expense limit",
    summary:
      "Representation expenses are income-tax-free up to €50/month + 2% of social-taxable payments YTD.",
    basis: "TuMS § 49 lg 4",
  },
  {
    code: "TuMS § 49 lg 2",
    title: "Tax-free gifts and donations limit",
    summary:
      "Gifts/donations to listed NGOs are tax-free up to 3% of social-taxable payments or 10% of prior-year profit.",
    basis: "TuMS § 49 lg 2",
  },
];

function isStrictIsoDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return false;
  }
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
}

/** Standard VAT rate (%) on the given ISO date, or null if the date is invalid. */
export function standardVatRateOn(dateISO: string | undefined | null): number | null {
  const d = dateISO?.slice(0, 10);
  if (!d || !isStrictIsoDate(d)) {
    return null;
  }
  const period = STANDARD_VAT_RATE_TIMELINE.find(
    (p) => d >= p.from && (p.to === null || d <= p.to),
  );
  return period ? period.rate : null;
}
