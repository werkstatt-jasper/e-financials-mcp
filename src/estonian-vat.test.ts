import { describe, expect, it } from "vitest";
import {
  DEDUCTION_AND_LIMIT_RULES,
  REDUCED_VAT_RATES,
  STANDARD_VAT_RATE_TIMELINE,
  standardVatRateOn,
} from "./estonian-vat.js";

describe("standardVatRateOn", () => {
  it("returns boundary rates for timeline transitions", () => {
    expect(standardVatRateOn("2023-12-31")).toBe(20);
    expect(standardVatRateOn("2024-01-01")).toBe(22);
    expect(standardVatRateOn("2025-06-30")).toBe(22);
    expect(standardVatRateOn("2025-07-01")).toBe(24);
    expect(standardVatRateOn("2026-01-15")).toBe(24);
  });

  it("rejects invalid calendar dates", () => {
    expect(standardVatRateOn(null)).toBeNull();
    expect(standardVatRateOn(undefined)).toBeNull();
    expect(standardVatRateOn("")).toBeNull();
    expect(standardVatRateOn("2025-13-01")).toBeNull();
    expect(standardVatRateOn("2025-02-31")).toBeNull();
    expect(standardVatRateOn("not-a-date")).toBeNull();
  });

  it("accepts datetime strings by using the date prefix", () => {
    expect(standardVatRateOn("2025-07-01T12:00:00Z")).toBe(24);
  });

  it("returns null for dates before the earliest timeline entry", () => {
    expect(standardVatRateOn("2000-01-01")).toBeNull();
  });
});

describe("reference data", () => {
  it("exposes timeline, reduced rates, and deduction rules", () => {
    expect(STANDARD_VAT_RATE_TIMELINE.length).toBeGreaterThanOrEqual(3);
    expect(REDUCED_VAT_RATES.some((r) => r.rate === 13)).toBe(true);
    expect(REDUCED_VAT_RATES.some((r) => r.rate === 9)).toBe(true);
    expect(REDUCED_VAT_RATES.some((r) => r.rate === 0)).toBe(true);
    expect(DEDUCTION_AND_LIMIT_RULES.some((r) => r.code.includes("KMS § 30"))).toBe(true);
    expect(DEDUCTION_AND_LIMIT_RULES.some((r) => r.code.includes("TuMS"))).toBe(true);
  });
});
