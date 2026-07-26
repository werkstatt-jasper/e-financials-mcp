import { standardVatRateOn } from "../estonian-vat.js";
import { parseVatRateDropdown, roundMoney } from "../money.js";

export interface ValidateInvoiceItemInput {
  total_net_price?: number;
  vat_rate_dropdown?: string | number | null;
  vat_rate?: number;
}

export interface ValidateInvoiceDataInput {
  total_net: number;
  total_vat: number;
  total_gross: number;
  items?: ValidateInvoiceItemInput[];
  invoice_date?: string;
  due_date?: string;
  cl_currencies_id?: string;
  currency_rate?: number;
  base_net_price?: number;
  /** Override "today" for deterministic tests (YYYY-MM-DD). */
  today?: string;
}

export interface ValidateInvoiceDataResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    total_net: number;
    total_vat: number;
    total_gross: number;
    computed_gross: number;
    item_count: number;
  };
}

const KNOWN_REDUCED_RATES = [0, 5, 9, 13];
const KNOWN_STANDARD_RATES = [20, 22, 24];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) {
    return false;
  }
  const parts = s.split("-").map(Number);
  const y = parts[0] as number;
  const m = parts[1] as number;
  const d = parts[2] as number;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toISOString().slice(0, 10) === s;
}

function itemRate(item: ValidateInvoiceItemInput): number | undefined {
  if (item.vat_rate_dropdown != null && String(item.vat_rate_dropdown).trim() !== "") {
    return parseVatRateDropdown(item.vat_rate_dropdown);
  }
  if (item.vat_rate != null && Number.isFinite(item.vat_rate)) {
    return item.vat_rate;
  }
  return undefined;
}

/**
 * Pure pre-booking consistency checks for invoice totals, dates, VAT rates, and FX.
 */
export function validateInvoiceData(input: ValidateInvoiceDataInput): ValidateInvoiceDataResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const items = input.items ?? [];
  const { total_net, total_vat, total_gross } = input;

  const computedGross = roundMoney(total_net + total_vat);
  const grossDiff = Math.abs(computedGross - total_gross);
  if (grossDiff > 0.02) {
    errors.push(
      `net (${total_net}) + VAT (${total_vat}) = ${computedGross}, but gross is ${total_gross} (diff: ${grossDiff.toFixed(2)})`,
    );
  } else if (grossDiff > 0) {
    warnings.push(
      `Minor rounding: net + VAT = ${computedGross}, gross = ${total_gross} (diff: ${grossDiff.toFixed(2)})`,
    );
  }

  if (items.length > 0) {
    const itemNetSum = roundMoney(
      items.reduce(
        (s, i) => s + (typeof i.total_net_price === "number" ? i.total_net_price : 0),
        0,
      ),
    );
    const netDiff = Math.abs(itemNetSum - total_net);
    if (netDiff > 0.02) {
      errors.push(
        `Item net sum (${itemNetSum}) does not match invoice net (${total_net}) (diff: ${netDiff.toFixed(2)})`,
      );
    } else if (netDiff > 0) {
      warnings.push(
        `Minor item rounding: sum ${itemNetSum} vs net ${total_net} (diff: ${netDiff.toFixed(2)})`,
      );
    }
  }

  const expectedStandardRate = standardVatRateOn(input.invoice_date);
  let computedItemVat = 0;
  let itemVatInputs = 0;

  items.forEach((item, idx) => {
    const rate = itemRate(item);
    if (rate !== undefined) {
      const isKnown = KNOWN_REDUCED_RATES.includes(rate) || KNOWN_STANDARD_RATES.includes(rate);
      if (!isKnown) {
        warnings.push(`Item ${idx + 1}: unusual VAT rate ${rate}%`);
      } else if (
        expectedStandardRate !== null &&
        KNOWN_STANDARD_RATES.includes(rate) &&
        rate !== expectedStandardRate
      ) {
        warnings.push(
          `Item ${idx + 1}: ${rate}% does not match the standard VAT rate in force on ${String(input.invoice_date).slice(0, 10)} (${expectedStandardRate}%). A reduced rate (0/5/9/13%) would be fine; confirm this is not an OCR misread or a wrong booking period.`,
        );
      }
    }
    if (typeof item.total_net_price === "number" && item.total_net_price < 0) {
      warnings.push(`Item ${idx + 1}: negative net price ${item.total_net_price}`);
    }
    if (typeof item.total_net_price === "number" && rate !== undefined) {
      computedItemVat += item.total_net_price * (rate / 100);
      itemVatInputs++;
    }
  });

  if (itemVatInputs > 0) {
    computedItemVat = roundMoney(computedItemVat);
    const itemVatDiff = Math.abs(computedItemVat - total_vat);
    if (itemVatDiff > 0.05) {
      warnings.push(
        `Summed per-item VAT (${computedItemVat}) does not match total VAT (${total_vat}) (diff: ${itemVatDiff.toFixed(2)})`,
      );
    }
  }

  const validInvoiceDate =
    input.invoice_date && isValidCalendarDate(input.invoice_date) ? input.invoice_date : undefined;

  if (input.invoice_date) {
    if (!isValidCalendarDate(input.invoice_date)) {
      errors.push(
        `Invalid invoice_date (expected valid YYYY-MM-DD). Received: ${JSON.stringify(input.invoice_date)}`,
      );
    } else {
      const todayIso = input.today ?? new Date().toISOString().slice(0, 10);
      const today = new Date(`${todayIso}T00:00:00Z`);
      const fiveYearsAgo = new Date(today.getTime());
      fiveYearsAgo.setUTCFullYear(today.getUTCFullYear() - 5);
      const fiveYearsAgoIso = fiveYearsAgo.toISOString().slice(0, 10);
      const cutoffFuture = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      if (input.invoice_date > cutoffFuture) {
        warnings.push(
          `invoice_date (${input.invoice_date}) is more than 30 days in the future — possible OCR misread, verify before booking`,
        );
      } else if (input.invoice_date < fiveYearsAgoIso) {
        warnings.push(
          `invoice_date (${input.invoice_date}) is more than 5 years before today (${todayIso}) — possible OCR misread, verify before booking`,
        );
      }
    }
  }

  if (input.due_date) {
    if (!isValidCalendarDate(input.due_date)) {
      errors.push(
        `Invalid due_date (expected valid YYYY-MM-DD). Received: ${JSON.stringify(input.due_date)}`,
      );
    } else if (validInvoiceDate && input.due_date < validInvoiceDate) {
      warnings.push(`due_date (${input.due_date}) is before invoice_date (${validInvoiceDate})`);
    }
  }

  if (total_gross <= 0) {
    warnings.push(`Gross amount is ${total_gross} (zero or negative)`);
  }
  if (total_net <= 0) {
    warnings.push(`Net amount is ${total_net} (zero or negative)`);
  }

  const rawCurrency = (input.cl_currencies_id ?? "EUR").toUpperCase();
  const currencyCode = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : "non-EUR";
  if (
    currencyCode !== "EUR" &&
    input.currency_rate === undefined &&
    input.base_net_price === undefined
  ) {
    warnings.push(
      `Foreign-currency invoice (${currencyCode}): no currency_rate or base_net_price provided. Pass currency_rate and/or base_net_price to lock the EUR settlement.`,
    );
  }

  if (
    currencyCode !== "EUR" &&
    typeof input.currency_rate === "number" &&
    input.currency_rate > 0 &&
    typeof input.base_net_price === "number" &&
    total_net > 0
  ) {
    const implied = input.base_net_price / total_net;
    const rel = Math.abs(implied - input.currency_rate) / input.currency_rate;
    if (rel > 0.2 || input.currency_rate < 0.01 || input.currency_rate > 100) {
      warnings.push(
        `Implausible FX: currency_rate=${input.currency_rate}, implied from base_net_price/net≈${roundMoney(implied)}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      total_net,
      total_vat,
      total_gross,
      computed_gross: computedGross,
      item_count: items.length,
    },
  };
}
