import { parseCsv } from "../csv.js";
import { roundMoney, roundTo } from "../money.js";
import type { ToolTransactionType } from "./transaction-direction.js";

/** Estonian chart account commonly used for Wise / card fees (Muud finantskulud). */
export const WISE_FEE_CHART_ACCOUNT_ID = 8610;

const REQUIRED_HEADERS = [
  "ID",
  "Status",
  "Direction",
  "Source amount (after fees)",
  "Target amount (after fees)",
  "Exchange rate",
] as const;

export interface WiseCsvRow {
  id: string;
  status: string;
  direction: string;
  createdOn: string;
  finishedOn: string;
  sourceFeeAmount: number;
  sourceFeeCurrency: string;
  targetFeeAmount: number;
  targetFeeCurrency: string;
  sourceName: string;
  sourceAmount: number;
  sourceCurrency: string;
  targetName: string;
  targetAmount: number;
  targetCurrency: string;
  exchangeRate: number;
  reference: string;
  category: string;
  note: string;
}

export type WiseDirection = "IN" | "OUT" | "NEUTRAL";

export interface WiseFxQuote {
  oppositeAmount: number;
  oppositeCurrency: string;
  /** EUR per 1 foreign-currency unit, when one side of the row is EUR. */
  eurRate?: number;
  /** `currency_rate` to store on the booked row (EUR per 1 booked unit, or 1 when booked in EUR). */
  currencyRate?: number;
  baseAmount?: number;
}

function headerIndex(headers: string[], name: string): number {
  return headers.indexOf(name);
}

function field(fields: string[], index: number): string {
  if (index < 0) {
    return "";
  }
  return fields[index] ?? "";
}

function parseNumber(raw: string, column: string, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fallback;
  }
  const parsed = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value in Wise CSV column "${column}": "${raw}"`);
  }
  return parsed;
}

function normalizeCurrency(value: string, fallback = "EUR"): string {
  const normalized = value.trim().toUpperCase();
  return normalized === "" ? fallback : normalized;
}

/**
 * Parse a Wise Transactions CSV export (not a statement export).
 * The first row must include the standard header names; a UTF-8 BOM is ignored.
 */
export function parseWiseCsv(csv: string): WiseCsvRow[] {
  const records = parseCsv(csv).filter((record) => record.some((value) => value.trim() !== ""));
  const [headerRow, ...dataRows] = records;
  if (headerRow == null || dataRows.length === 0) {
    throw new Error("CSV has no data rows");
  }

  const headers = headerRow.map((header, index) => {
    const trimmed = header.trim();
    return index === 0 ? trimmed.replace(/^\uFEFF/, "") : trimmed;
  });
  for (const expected of REQUIRED_HEADERS) {
    if (!headers.includes(expected)) {
      throw new Error(
        `Missing expected header "${expected}". Found: ${headers.slice(0, 10).join(", ")}`,
      );
    }
  }

  const idx = (name: string) => headerIndex(headers, name);
  const rows: WiseCsvRow[] = [];
  for (const fields of dataRows) {
    if (fields.length < headers.length - 2) {
      continue;
    }
    rows.push({
      id: field(fields, idx("ID")).trim(),
      status: field(fields, idx("Status")).trim(),
      direction: field(fields, idx("Direction")).trim(),
      createdOn: field(fields, idx("Created on")).trim(),
      finishedOn: field(fields, idx("Finished on")).trim(),
      sourceFeeAmount: parseNumber(field(fields, idx("Source fee amount")), "Source fee amount", 0),
      sourceFeeCurrency: normalizeCurrency(field(fields, idx("Source fee currency"))),
      targetFeeAmount: parseNumber(field(fields, idx("Target fee amount")), "Target fee amount", 0),
      targetFeeCurrency: normalizeCurrency(field(fields, idx("Target fee currency"))),
      sourceName: field(fields, idx("Source name")).trim(),
      sourceAmount: parseNumber(
        field(fields, idx("Source amount (after fees)")),
        "Source amount (after fees)",
        0,
      ),
      sourceCurrency: normalizeCurrency(field(fields, idx("Source currency"))),
      targetName: field(fields, idx("Target name")).trim(),
      targetAmount: parseNumber(
        field(fields, idx("Target amount (after fees)")),
        "Target amount (after fees)",
        0,
      ),
      targetCurrency: normalizeCurrency(field(fields, idx("Target currency"))),
      exchangeRate: parseNumber(field(fields, idx("Exchange rate")), "Exchange rate", 1),
      reference: field(fields, idx("Reference")).trim(),
      category: field(fields, idx("Category")).trim(),
      note: field(fields, idx("Note")).trim(),
    });
  }
  return rows;
}

/** `2026-01-19 17:59:56` → `2026-01-19`. Falls back to created-on when finished-on is empty. */
export function wiseTransactionDate(row: WiseCsvRow): string {
  const raw = row.finishedOn || row.createdOn;
  return raw.slice(0, 10);
}

export function normalizeWiseDirection(direction: string): WiseDirection | undefined {
  const normalized = direction.trim().toUpperCase();
  if (normalized === "IN" || normalized === "OUT" || normalized === "NEUTRAL") {
    return normalized;
  }
  return undefined;
}

/**
 * Tool contract used by this package: C = money in, D = money out.
 * Wise `IN` credits the Wise account; `OUT` debits it. `createVerifiedTransaction`
 * translates the letter to the RIK wire value.
 */
export function toolTypeForWiseDirection(direction: string): ToolTransactionType | undefined {
  const normalized = normalizeWiseDirection(direction);
  if (normalized === "IN") {
    return "C";
  }
  if (normalized === "OUT") {
    return "D";
  }
  return undefined;
}

function ownSide(row: WiseCsvRow): "source" | "target" | undefined {
  const type = toolTypeForWiseDirection(row.direction);
  if (type === "D") {
    return "source";
  }
  if (type === "C") {
    return "target";
  }
  return undefined;
}

export function bookedAmount(row: WiseCsvRow): number {
  return ownSide(row) === "target" ? row.targetAmount : row.sourceAmount;
}

export function bookedCurrency(row: WiseCsvRow): string {
  return ownSide(row) === "target"
    ? normalizeCurrency(row.targetCurrency)
    : normalizeCurrency(row.sourceCurrency);
}

export function bookedFeeAmount(row: WiseCsvRow): number {
  return ownSide(row) === "target" ? row.targetFeeAmount : row.sourceFeeAmount;
}

export function bookedFeeCurrency(row: WiseCsvRow, fallbackCurrency: string): string {
  return ownSide(row) === "target"
    ? normalizeCurrency(row.targetFeeCurrency, fallbackCurrency)
    : normalizeCurrency(row.sourceFeeCurrency, fallbackCurrency);
}

export function oppositeSide(row: WiseCsvRow): { amount: number; currency: string } {
  return ownSide(row) === "target"
    ? { amount: row.sourceAmount, currency: normalizeCurrency(row.sourceCurrency) }
    : { amount: row.targetAmount, currency: normalizeCurrency(row.targetCurrency) };
}

export function counterpartyName(row: WiseCsvRow): string | undefined {
  const type = toolTypeForWiseDirection(row.direction);
  if (type === "C") {
    return row.sourceName || row.targetName || undefined;
  }
  if (type === "D") {
    return row.targetName || row.sourceName || undefined;
  }
  return row.targetName || row.sourceName || undefined;
}

/**
 * Jar (savings pot) movements are internal to Wise, not real payments.
 * Detected from explicit "jar" text, or a same-name / same-currency / zero-fee
 * self-transfer. Pass `skip_jar_transfers=false` to import them anyway.
 */
export function isJarTransfer(row: WiseCsvRow): boolean {
  const haystack = `${row.category} ${row.note} ${row.reference}`.toLowerCase();
  if (haystack.includes("jar")) {
    return true;
  }
  const source = normalizeMatchText(row.sourceName);
  const target = normalizeMatchText(row.targetName);
  return (
    source !== "" &&
    target !== "" &&
    source === target &&
    normalizeCurrency(row.sourceCurrency) === normalizeCurrency(row.targetCurrency) &&
    row.sourceFeeAmount === 0
  );
}

export function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function formatRate(rate: number): string {
  return Number(roundTo(rate, 6).toFixed(6)).toString();
}

function formatAmount(amount: number): string {
  return roundMoney(amount).toFixed(2);
}

/**
 * Derive the EUR rate from the source and target amounts when the two sides
 * use different currencies and one of them is EUR. The CSV exchange-rate
 * column is only a fallback when an amount is missing.
 */
export function wiseFxQuote(row: WiseCsvRow): WiseFxQuote | undefined {
  const booked = bookedCurrency(row);
  const bookedAmt = bookedAmount(row);
  const opposite = oppositeSide(row);
  if (opposite.currency === booked) {
    if (booked === "EUR") {
      return {
        oppositeAmount: opposite.amount,
        oppositeCurrency: opposite.currency,
        currencyRate: 1,
        baseAmount: roundMoney(bookedAmt),
      };
    }
    return undefined;
  }

  const bookedIsEur = booked === "EUR";
  const oppositeIsEur = opposite.currency === "EUR";
  const eurAmount = bookedIsEur ? bookedAmt : oppositeIsEur ? opposite.amount : undefined;
  const foreignAmount = bookedIsEur ? opposite.amount : bookedAmt;
  let eurRate: number | undefined;
  if (eurAmount != null && foreignAmount > 0) {
    eurRate = roundTo(eurAmount / foreignAmount, 6);
  } else if (eurAmount != null && row.exchangeRate > 0) {
    // One side is EUR but the foreign amount was missing; use the CSV rate.
    eurRate = roundTo(row.exchangeRate, 6);
  }

  const currencyRate = bookedIsEur ? 1 : eurRate;
  const baseAmount = bookedIsEur
    ? roundMoney(bookedAmt)
    : eurAmount != null
      ? roundMoney(eurAmount)
      : undefined;

  return {
    oppositeAmount: opposite.amount,
    oppositeCurrency: opposite.currency,
    eurRate,
    currencyRate,
    baseAmount,
  };
}

/** Operator-facing description, without the stored reference marker. */
export function humanWiseDescription(row: WiseCsvRow, kind: "main" | "fee"): string {
  if (kind === "fee") {
    return "Wise fee";
  }
  const parts: string[] = [];
  const name = counterpartyName(row);
  if (name) {
    parts.push(name);
  }
  if (row.category !== "" && row.category.toLowerCase() !== "general") {
    parts.push(`(${row.category})`);
  }
  const fx = wiseFxQuote(row);
  const booked = bookedCurrency(row);
  if (fx && fx.oppositeCurrency !== booked) {
    const rate = fx.eurRate ?? fx.currencyRate;
    const rateText = rate != null ? formatRate(rate) : undefined;
    if (rateText) {
      parts.push(`[${formatAmount(fx.oppositeAmount)} ${fx.oppositeCurrency} @ ${rateText}]`);
    } else {
      parts.push(`[${formatAmount(fx.oppositeAmount)} ${fx.oppositeCurrency}]`);
    }
  }
  return parts.join(" ");
}

export function isCompletedWiseRow(row: WiseCsvRow): boolean {
  return row.status.trim().toUpperCase() === "COMPLETED";
}

export function hasBookedValue(row: WiseCsvRow): boolean {
  return bookedAmount(row) !== 0 || bookedFeeAmount(row) !== 0;
}
