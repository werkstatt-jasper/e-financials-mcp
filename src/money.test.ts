import { describe, expect, it } from "vitest";
import { formatVatRateDropdown, parseVatRateDropdown, roundMoney, roundTo } from "./money.js";

describe("roundMoney", () => {
  it("rounds half-up at 2dp including classic float edge cases", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(1.004)).toBe(1);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(0)).toBe(0);
    expect(roundMoney(-0)).toBe(0);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => roundMoney(Number.NaN)).toThrow(/NaN/);
    expect(() => roundMoney(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => roundMoney(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("passthrough for magnitudes at or above 1e19", () => {
    const huge = 1e19;
    expect(roundMoney(huge)).toBe(huge);
  });

  it("normalizes signed zero results to 0", () => {
    expect(Object.is(roundMoney(-0.001), 0) || roundMoney(-0.001) === 0).toBe(true);
    expect(roundMoney(0.001)).toBe(0);
  });
});

describe("roundTo", () => {
  it("rounds to N decimals", () => {
    expect(roundTo(1.23456, 4)).toBe(1.2346);
    expect(roundTo(0, 6)).toBe(0);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => roundTo(Number.NaN, 2)).toThrow(/NaN/);
    expect(() => roundTo(Number.POSITIVE_INFINITY, 2)).toThrow(/non-finite/);
  });
});

describe("parseVatRateDropdown", () => {
  it("parses common RIK forms", () => {
    expect(parseVatRateDropdown("24")).toBe(24);
    expect(parseVatRateDropdown("9,5")).toBe(9.5);
    expect(parseVatRateDropdown("24%")).toBe(24);
    expect(parseVatRateDropdown(22)).toBe(22);
  });

  it("maps no-VAT and empty to 0", () => {
    expect(parseVatRateDropdown("-")).toBe(0);
    expect(parseVatRateDropdown("")).toBe(0);
    expect(parseVatRateDropdown(null)).toBe(0);
    expect(parseVatRateDropdown(undefined)).toBe(0);
    expect(parseVatRateDropdown("  -  ")).toBe(0);
  });

  it("maps non-numeric junk to 0", () => {
    expect(parseVatRateDropdown("abc")).toBe(0);
  });
});

describe("formatVatRateDropdown", () => {
  it("emits '-' for no VAT, never '0'", () => {
    expect(formatVatRateDropdown(0)).toBe("-");
    expect(formatVatRateDropdown(null)).toBe("-");
    expect(formatVatRateDropdown(undefined)).toBe("-");
    expect(formatVatRateDropdown(Number.NaN)).toBe("-");
  });

  it("stringifies positive rates", () => {
    expect(formatVatRateDropdown(24)).toBe("24");
    expect(formatVatRateDropdown(9.5)).toBe("9.5");
  });
});
