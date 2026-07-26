import { describe, expect, it } from "vitest";
import { validateInvoiceData } from "./validate-invoice-data.js";

describe("validateInvoiceData", () => {
  it("accepts consistent totals", () => {
    const result = validateInvoiceData({
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      items: [{ total_net_price: 100, vat_rate_dropdown: "24" }],
      invoice_date: "2025-08-01",
      today: "2025-08-15",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("errors when net+vat differs from gross by more than 0.02", () => {
    const result = validateInvoiceData({
      total_net: 100,
      total_vat: 24,
      total_gross: 130,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/gross is 130/);
  });

  it("warns on sub-cent / minor gross rounding", () => {
    const result = validateInvoiceData({
      total_net: 100,
      total_vat: 24,
      total_gross: 124.01,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Minor rounding"))).toBe(true);
  });

  it("errors when item net sum drifts > 0.02", () => {
    const result = validateInvoiceData({
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      items: [
        { total_net_price: 40, vat_rate_dropdown: "24" },
        { total_net_price: 50, vat_rate_dropdown: "24" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Item net sum/);
  });

  it("warns when item VAT sum differs by more than 0.05", () => {
    const result = validateInvoiceData({
      total_net: 100,
      total_vat: 10,
      total_gross: 110,
      items: [{ total_net_price: 100, vat_rate_dropdown: "24" }],
      invoice_date: "2025-08-01",
    });
    expect(result.warnings.some((w) => w.includes("Summed per-item VAT"))).toBe(true);
  });

  it("rejects invalid calendar invoice_date", () => {
    const result = validateInvoiceData({
      total_net: 10,
      total_vat: 0,
      total_gross: 10,
      invoice_date: "2025-02-31",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid invoice_date/);

    const badFormat = validateInvoiceData({
      total_net: 10,
      total_vat: 0,
      total_gross: 10,
      invoice_date: "01/08/2025",
    });
    expect(badFormat.errors[0]).toMatch(/Invalid invoice_date/);
  });

  it("rejects invalid due_date and warns when due before invoice", () => {
    const bad = validateInvoiceData({
      total_net: 10,
      total_vat: 0,
      total_gross: 10,
      due_date: "2025-13-01",
    });
    expect(bad.errors[0]).toMatch(/Invalid due_date/);

    const early = validateInvoiceData({
      total_net: 10,
      total_vat: 0,
      total_gross: 10,
      invoice_date: "2025-06-15",
      due_date: "2025-06-01",
      today: "2025-06-20",
    });
    expect(early.warnings.some((w) => w.includes("before invoice_date"))).toBe(true);
  });

  it("warns far-future and far-past invoice dates", () => {
    const future = validateInvoiceData({
      total_net: 10,
      total_vat: 0,
      total_gross: 10,
      invoice_date: "2025-10-01",
      today: "2025-08-01",
    });
    expect(future.warnings.some((w) => w.includes("30 days in the future"))).toBe(true);

    const past = validateInvoiceData({
      total_net: 10,
      total_vat: 0,
      total_gross: 10,
      invoice_date: "2019-01-01",
      today: "2025-08-01",
    });
    expect(past.warnings.some((w) => w.includes("5 years before"))).toBe(true);
  });

  it("warns mismatched standard rate for invoice date; accepts reduced rates", () => {
    const mismatch = validateInvoiceData({
      total_net: 100,
      total_vat: 20,
      total_gross: 120,
      items: [{ total_net_price: 100, vat_rate_dropdown: "20" }],
      invoice_date: "2025-08-01",
      today: "2025-08-15",
    });
    expect(mismatch.warnings.some((w) => w.includes("does not match the standard VAT"))).toBe(true);

    const reduced = validateInvoiceData({
      total_net: 100,
      total_vat: 9,
      total_gross: 109,
      items: [{ total_net_price: 100, vat_rate_dropdown: "9" }],
      invoice_date: "2025-08-01",
      today: "2025-08-15",
    });
    expect(reduced.warnings.some((w) => w.includes("does not match the standard VAT"))).toBe(false);
  });

  it("warns unusual rates and negative nets / non-positive totals", () => {
    const result = validateInvoiceData({
      total_net: 0,
      total_vat: 0,
      total_gross: 0,
      items: [{ total_net_price: -5, vat_rate_dropdown: "17" }],
    });
    expect(result.warnings.some((w) => w.includes("unusual VAT rate"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("negative net"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Gross amount"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Net amount"))).toBe(true);
  });

  it("warns FX missing rate/base and implausible implied rate", () => {
    const missing = validateInvoiceData({
      total_net: 100,
      total_vat: 0,
      total_gross: 100,
      cl_currencies_id: "USD",
    });
    expect(missing.warnings.some((w) => w.includes("no currency_rate"))).toBe(true);

    const badRate = validateInvoiceData({
      total_net: 100,
      total_vat: 0,
      total_gross: 100,
      cl_currencies_id: "USD",
      currency_rate: 1.1,
      base_net_price: 50,
    });
    expect(badRate.warnings.some((w) => w.includes("Implausible FX"))).toBe(true);
  });

  it("uses vat_rate numeric and sanitizes non-ISO currency labels", () => {
    const result = validateInvoiceData({
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      items: [{ total_net_price: 100, vat_rate: 24 }],
      cl_currencies_id: "usd\ninject",
    });
    expect(result.warnings.some((w) => w.includes("non-EUR"))).toBe(true);
  });

  it("ignores blank dropdown and non-finite vat_rate; covers no-rate items", () => {
    const result = validateInvoiceData({
      total_net: 100,
      total_vat: 0,
      total_gross: 100,
      items: [
        { total_net_price: 50, vat_rate_dropdown: "  " },
        { total_net_price: 50, vat_rate: Number.NaN },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Summed per-item VAT"))).toBe(false);
  });

  it("treats extreme currency_rate as implausible FX", () => {
    const high = validateInvoiceData({
      total_net: 100,
      total_vat: 0,
      total_gross: 100,
      cl_currencies_id: "JPY",
      currency_rate: 150,
      base_net_price: 100,
    });
    expect(high.warnings.some((w) => w.includes("Implausible FX"))).toBe(true);

    const tiny = validateInvoiceData({
      total_net: 100,
      total_vat: 0,
      total_gross: 100,
      cl_currencies_id: "USD",
      currency_rate: 0.005,
      base_net_price: 0.5,
    });
    expect(tiny.warnings.some((w) => w.includes("Implausible FX"))).toBe(true);

    const ok = validateInvoiceData({
      total_net: 100,
      total_vat: 0,
      total_gross: 100,
      cl_currencies_id: "USD",
      currency_rate: 0.92,
      base_net_price: 92,
    });
    expect(ok.warnings.some((w) => w.includes("Implausible FX"))).toBe(false);
  });

  it("covers items without net and due_date without invoice_date", () => {
    const result = validateInvoiceData({
      total_net: 0,
      total_vat: 0,
      total_gross: 0,
      items: [{ vat_rate_dropdown: "24" }],
      due_date: "2025-08-01",
      today: "2025-08-15",
    });
    expect(result.valid).toBe(true);
  });

  it("warns minor item net rounding", () => {
    const result = validateInvoiceData({
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      items: [{ total_net_price: 100.01, vat_rate_dropdown: "24" }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Minor item rounding"))).toBe(true);
  });

  it("covers rate timeline boundary 2024 vs 2025-07", () => {
    const early2024 = validateInvoiceData({
      total_net: 100,
      total_vat: 22,
      total_gross: 122,
      items: [{ total_net_price: 100, vat_rate_dropdown: "22" }],
      invoice_date: "2024-01-01",
      today: "2024-06-01",
    });
    expect(early2024.valid).toBe(true);
    expect(early2024.warnings.filter((w) => w.includes("does not match"))).toEqual([]);

    const after24 = validateInvoiceData({
      total_net: 100,
      total_vat: 22,
      total_gross: 122,
      items: [{ total_net_price: 100, vat_rate_dropdown: "22" }],
      invoice_date: "2025-07-01",
      today: "2025-08-01",
    });
    expect(after24.warnings.some((w) => w.includes("24%"))).toBe(true);
  });
});
