/**
 * Round to 2 decimal places (cents). Use for all monetary arithmetic.
 * Uses the string-exponent technique to avoid IEEE 754 intermediate errors
 * (e.g. 1.005 * 100 ≠ 100.5 in binary float, but parseFloat('1.005e2') does).
 */
export function roundMoney(v: number): number {
  if (v === 0) {
    return 0;
  }
  if (Number.isNaN(v)) {
    throw new Error("roundMoney received NaN — indicates a bug in the caller");
  }
  if (!Number.isFinite(v)) {
    throw new Error("roundMoney received a non-finite value — indicates a bug in the caller");
  }
  const abs = Math.abs(v);
  // Beyond ~1e19 the IEEE spacing exceeds 0.01; string-exponent also breaks.
  if (abs >= 1e19) {
    return v;
  }
  const rounded = Number(`${Math.round(parseFloat(`${abs}e2`))}e-2`);
  return (v < 0 ? -rounded : rounded) || 0;
}

/**
 * Round to N decimals (exchange rates, ratios).
 */
export function roundTo(value: number, decimals: number): number {
  if (value === 0) {
    return 0;
  }
  if (Number.isNaN(value)) {
    throw new Error("roundTo received NaN");
  }
  if (!Number.isFinite(value)) {
    throw new Error("roundTo received a non-finite value");
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Parse a RIK `vat_rate_dropdown` string to a numeric rate.
 * `"-"` (no VAT) and empty/null → 0. Never invents a rate from missing data.
 */
export function parseVatRateDropdown(value: string | number | null | undefined): number {
  if (value == null) {
    return 0;
  }
  const str = String(value).trim();
  if (!str || str === "-") {
    return 0;
  }
  const parsed = Number(str.replace(",", ".").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Format a numeric VAT rate for RIK line fields.
 * Zero / no-VAT must be the string `"-"`, never `"0"`.
 */
export function formatVatRateDropdown(rate: number | null | undefined): string {
  if (rate == null || rate === 0 || Number.isNaN(rate)) {
    return "-";
  }
  return String(rate);
}
