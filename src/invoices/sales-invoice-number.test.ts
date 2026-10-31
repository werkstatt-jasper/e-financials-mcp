import { describe, expect, it } from "vitest";
import {
  defaultSalesInvoicePrefix,
  extractSeriesList,
  nextSalesInvoiceSuffix,
  nextSalesInvoiceSuffixForPrefix,
} from "./sales-invoice-number.js";

describe("extractSeriesList", () => {
  it("parses a raw array", () => {
    const series = [
      {
        is_active: true,
        is_default: true,
        number_prefix: "A",
        number_start_value: 1,
        term_days: 14,
      },
    ];
    expect(extractSeriesList(series)).toEqual(series);
  });

  it("parses { items }", () => {
    const series = [
      {
        is_active: true,
        is_default: false,
        number_prefix: "B",
        number_start_value: 10,
        term_days: 7,
      },
    ];
    expect(extractSeriesList({ items: series })).toEqual(series);
  });

  it("returns empty for missing or invalid items", () => {
    expect(extractSeriesList({})).toEqual([]);
    expect(extractSeriesList(null)).toEqual([]);
    expect(extractSeriesList(undefined)).toEqual([]);
    expect(extractSeriesList({ items: "nope" })).toEqual([]);
  });
});

describe("nextSalesInvoiceSuffix", () => {
  it("counts null-prefix invoices toward the default series", () => {
    expect(
      nextSalesInvoiceSuffix(
        [{ is_default: true, number_prefix: "34", number_start_value: 12345 }],
        [
          { number_prefix: "34", number_suffix: "12366" },
          { number_prefix: null, number_suffix: "12367" },
          { number_prefix: "OTH", number_suffix: "99" },
        ],
      ),
    ).toBe("12368");
  });

  it("increments the last suffix for the default series prefix", () => {
    expect(
      nextSalesInvoiceSuffix(
        [
          { is_default: false, number_prefix: "OTH", number_start_value: 1 },
          { is_default: true, number_prefix: "INV", number_start_value: 1 },
        ],
        [
          { number_prefix: "INV", number_suffix: "5" },
          { number_prefix: "OTH", number_suffix: "99" },
          { number_prefix: "INV", number_suffix: 8 },
        ],
      ),
    ).toBe("9");
  });

  it("uses the first series when none is default", () => {
    expect(
      nextSalesInvoiceSuffix(
        [{ is_default: false, number_prefix: "A", number_start_value: 500 }],
        [{ number_prefix: "A", number_suffix: "502" }],
      ),
    ).toBe("503");
  });

  it("uses max usable suffix + 1 when series is empty", () => {
    expect(nextSalesInvoiceSuffix([], [{ number_prefix: "X", number_suffix: "1443" }])).toBe(
      "1444",
    );
  });

  it("falls back to number_start_value when no invoices match", () => {
    expect(
      nextSalesInvoiceSuffix(
        [{ is_default: true, number_prefix: "INV", number_start_value: 1001 }],
        [{ number_prefix: "OTH", number_suffix: "9" }],
      ),
    ).toBe("1001");
  });

  it("falls back to 1 when series and invoices are empty", () => {
    expect(nextSalesInvoiceSuffix([], [])).toBe("1");
  });

  it("skips 13-digit timestamp suffixes", () => {
    expect(
      nextSalesInvoiceSuffix(
        [{ is_default: true, number_prefix: "INV", number_start_value: 1 }],
        [
          { number_prefix: "INV", number_suffix: "1787240058573" },
          { number_prefix: "INV", number_suffix: "12" },
        ],
      ),
    ).toBe("13");
  });

  it("skips a null suffix on a null-prefix invoice when matching a series", () => {
    expect(
      nextSalesInvoiceSuffix(
        [{ is_default: true, number_prefix: "INV", number_start_value: 1 }],
        [
          { number_prefix: null, number_suffix: null },
          { number_prefix: "INV", number_suffix: "2" },
        ],
      ),
    ).toBe("3");
  });

  it("treats an empty series prefix as all invoices and ignores junk suffixes", () => {
    expect(
      nextSalesInvoiceSuffix(
        [{ is_default: true, number_prefix: "", number_start_value: Number.NaN }],
        [
          { number_prefix: "A", number_suffix: "20" },
          { number_prefix: "B", number_suffix: "3" },
          { number_prefix: "A", number_suffix: "nope" },
        ],
      ),
    ).toBe("21");
  });
});

describe("defaultSalesInvoicePrefix", () => {
  it("returns the prefix of the default series", () => {
    expect(
      defaultSalesInvoicePrefix([
        { is_default: false, number_prefix: "NX" },
        { is_default: true, number_prefix: "2026" },
      ]),
    ).toBe("2026");
  });

  it("returns undefined without a default series or with an empty prefix", () => {
    expect(defaultSalesInvoicePrefix([])).toBeUndefined();
    expect(defaultSalesInvoicePrefix([{ is_default: false, number_prefix: "NX" }])).toBeUndefined();
    expect(defaultSalesInvoicePrefix([{ is_default: true, number_prefix: "" }])).toBeUndefined();
    expect(defaultSalesInvoicePrefix([{ is_default: true }])).toBeUndefined();
  });
});

describe("nextSalesInvoiceSuffixForPrefix", () => {
  it("continues the prefixed series and ignores prefix-less invoices (GitLab #240)", () => {
    expect(
      nextSalesInvoiceSuffixForPrefix(
        [{ is_default: true, number_prefix: "2026", number_start_value: 1 }],
        [
          { number_prefix: "2026", number_suffix: "41" },
          { number_prefix: null, number_suffix: "7012" },
          { number_prefix: "", number_suffix: "7013" },
          { number_suffix: "7014" },
          { number_prefix: "NX", number_suffix: "900" },
          { number_prefix: "2026", number_suffix: "1787240058573" },
        ],
        "2026",
      ),
    ).toBe("42");
  });

  it("starts at the matching series number_start_value, preferring the default one", () => {
    expect(
      nextSalesInvoiceSuffixForPrefix(
        [
          { is_default: false, number_prefix: "NX", number_start_value: 10 },
          { is_default: true, number_prefix: "NX", number_start_value: 20 },
          { is_default: false, number_prefix: "2026", number_start_value: 99 },
        ],
        [{ number_prefix: null, number_suffix: "7012" }],
        "NX",
      ),
    ).toBe("20");
    expect(
      nextSalesInvoiceSuffixForPrefix(
        [{ is_default: false, number_prefix: "NX", number_start_value: 10 }],
        [],
        "NX",
      ),
    ).toBe("10");
  });

  it("starts at 1 when no series has the prefix", () => {
    expect(
      nextSalesInvoiceSuffixForPrefix(
        [{ is_default: true, number_prefix: "2026", number_start_value: 99 }],
        [{ number_prefix: "2026", number_suffix: "5" }],
        "ZZ",
      ),
    ).toBe("1");
  });
});
