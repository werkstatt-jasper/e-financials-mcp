import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bookedAmount,
  bookedCurrency,
  bookedFeeAmount,
  bookedFeeCurrency,
  counterpartyName,
  hasBookedValue,
  humanWiseDescription,
  isCompletedWiseRow,
  isJarTransfer,
  normalizeMatchText,
  normalizeWiseDirection,
  oppositeSide,
  parseWiseCsv,
  toolTypeForWiseDirection,
  wiseFxQuote,
  wiseTransactionDate,
} from "./wise-csv.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/wise");

function firstRow(csvText: string) {
  const row = parseWiseCsv(csvText)[0];
  if (row == null) {
    throw new Error("expected a parsed Wise row");
  }
  return row;
}

const HEADER = [
  "ID",
  "Status",
  "Direction",
  "Created on",
  "Finished on",
  "Source fee amount",
  "Source fee currency",
  "Target fee amount",
  "Target fee currency",
  "Source name",
  "Source amount (after fees)",
  "Source currency",
  "Target name",
  "Target amount (after fees)",
  "Target currency",
  "Exchange rate",
  "Reference",
  "Batch",
  "Created by",
  "Category",
  "Note",
].join(",");

function csv(rows: string[]): string {
  return `${HEADER}\n${rows.join("\n")}\n`;
}

function cells(values: Record<string, string>): string {
  const map: Record<string, string> = {
    ID: "id-1",
    Status: "COMPLETED",
    Direction: "OUT",
    "Created on": "2026-03-01 10:00:00",
    "Finished on": "2026-03-01 10:05:00",
    "Source fee amount": "0",
    "Source fee currency": "EUR",
    "Target fee amount": "0",
    "Target fee currency": "EUR",
    "Source name": "Example Holder OÜ",
    "Source amount (after fees)": "10.00",
    "Source currency": "EUR",
    "Target name": "Example Payee OÜ",
    "Target amount (after fees)": "10.00",
    "Target currency": "EUR",
    "Exchange rate": "1",
    Reference: "REF-1",
    Batch: "",
    "Created by": "",
    Category: "General",
    Note: "",
    ...values,
  };
  return [
    "ID",
    "Status",
    "Direction",
    "Created on",
    "Finished on",
    "Source fee amount",
    "Source fee currency",
    "Target fee amount",
    "Target fee currency",
    "Source name",
    "Source amount (after fees)",
    "Source currency",
    "Target name",
    "Target amount (after fees)",
    "Target currency",
    "Exchange rate",
    "Reference",
    "Batch",
    "Created by",
    "Category",
    "Note",
  ]
    .map((key) => map[key] ?? "")
    .join(",");
}

describe("parseWiseCsv", () => {
  it("parses the EUR incoming fixture and strips a UTF-8 BOM", () => {
    const raw = readFileSync(join(fixtures, "eur-incoming.csv"), "utf8");
    const withBom = `\uFEFF${raw}`;
    const [row] = parseWiseCsv(withBom);
    expect(row).toMatchObject({
      id: "TRF-1001",
      status: "COMPLETED",
      direction: "IN",
      sourceAmount: 150,
      targetAmount: 150,
      reference: "INV-1001",
    });
  });

  it("rejects a document with no data rows or a missing required header", () => {
    expect(() => parseWiseCsv("ID,Status\n")).toThrow(/no data rows/);
    expect(() => parseWiseCsv("ID,Status,Direction\nrow\n")).toThrow(
      /Missing expected header "Source amount \(after fees\)"/,
    );
  });

  it("skips short rows and rejects non-numeric amounts", () => {
    const shortAndGood = `${HEADER}\nonly-one-field\n${cells({ ID: "ok-1" })}\n`;
    expect(parseWiseCsv(shortAndGood)).toHaveLength(1);
    expect(() => parseWiseCsv(csv([cells({ "Source amount (after fees)": "n/a" })]))).toThrow(
      /Source amount \(after fees\)/,
    );
  });

  it("defaults trailing columns when a row is only slightly shorter than the header", () => {
    const required = [
      "cut-1",
      "COMPLETED",
      "OUT",
      "2026-03-01 10:00:00",
      "2026-03-01 10:00:00",
      "0",
      "EUR",
      "0",
      "EUR",
      "Src",
      "10",
      "EUR",
      "Tgt",
      "10",
      "EUR",
      "1",
      "REF-CUT",
      "",
      "",
    ];
    const parsed = parseWiseCsv(`${HEADER}\n${required.join(",")}\n`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "cut-1", reference: "REF-CUT", category: "", note: "" });
  });

  it("defaults missing optional currencies and empty numbers", () => {
    const header =
      "ID,Status,Direction,Source amount (after fees),Target amount (after fees),Exchange rate";
    const parsed = parseWiseCsv(`${header}\nid-2,COMPLETED,IN,5,,\n`);
    expect(parsed[0]).toMatchObject({
      id: "id-2",
      sourceAmount: 5,
      targetAmount: 0,
      exchangeRate: 1,
      sourceCurrency: "EUR",
      targetCurrency: "EUR",
    });
  });
});

describe("row helpers", () => {
  it("maps direction to the tool C/D contract and picks the booked side", () => {
    const incoming = firstRow(
      csv([
        cells({
          ID: "in-1",
          Direction: "IN",
          "Source name": "Customer Inc",
          "Source amount (after fees)": "100",
          "Source currency": "USD",
          "Target name": "Example Holder OÜ",
          "Target amount (after fees)": "92",
          "Target currency": "EUR",
          "Target fee amount": "2",
          "Target fee currency": "EUR",
          "Exchange rate": "0.92",
        }),
      ]),
    );
    expect(normalizeWiseDirection(" in ")).toBe("IN");
    expect(normalizeWiseDirection("SIDEWAYS")).toBeUndefined();
    expect(toolTypeForWiseDirection("IN")).toBe("C");
    expect(toolTypeForWiseDirection("OUT")).toBe("D");
    expect(toolTypeForWiseDirection("NEUTRAL")).toBeUndefined();
    expect(bookedAmount(incoming)).toBe(92);
    expect(bookedCurrency(incoming)).toBe("EUR");
    expect(bookedFeeAmount(incoming)).toBe(2);
    expect(bookedFeeCurrency(incoming, "EUR")).toBe("EUR");
    expect(oppositeSide(incoming)).toEqual({ amount: 100, currency: "USD" });
    expect(counterpartyName(incoming)).toBe("Customer Inc");
    expect(wiseTransactionDate(incoming)).toBe("2026-03-01");
    expect(isCompletedWiseRow(incoming)).toBe(true);
    expect(hasBookedValue(incoming)).toBe(true);
  });

  it("uses the source side for outgoing rows and created-on when finished-on is empty", () => {
    const outgoing = firstRow(
      csv([
        cells({
          ID: "out-1",
          Direction: "OUT",
          "Finished on": "",
          "Created on": "2026-04-02 08:00:00",
          "Source fee amount": "1.5",
          "Source fee currency": "USD",
          "Source amount (after fees)": "42",
          "Source currency": "USD",
          "Target amount (after fees)": "38.64",
          "Target currency": "EUR",
          "Target name": "",
          "Source name": "Example Holder OÜ",
        }),
      ]),
    );
    expect(bookedAmount(outgoing)).toBe(42);
    expect(bookedCurrency(outgoing)).toBe("USD");
    expect(bookedFeeAmount(outgoing)).toBe(1.5);
    expect(bookedFeeCurrency(outgoing, "USD")).toBe("USD");
    expect(counterpartyName(outgoing)).toBe("Example Holder OÜ");
    expect(wiseTransactionDate(outgoing)).toBe("2026-04-02");
  });

  it("falls back to the other name when the usual counterparty column is empty", () => {
    const incoming = firstRow(
      csv([cells({ Direction: "IN", "Source name": "", "Target name": "Only Target" })]),
    );
    const unknown = firstRow(
      csv([
        cells({
          Direction: "OTHER",
          "Source name": "",
          "Target name": "T",
          "Source amount (after fees)": "0",
        }),
      ]),
    );
    expect(counterpartyName(incoming)).toBe("Only Target");
    expect(counterpartyName(unknown)).toBe("T");
    expect(hasBookedValue(unknown)).toBe(false);
    const emptyIn = firstRow(
      csv([cells({ Direction: "IN", "Source name": "", "Target name": "" })]),
    );
    const emptyOut = firstRow(
      csv([cells({ Direction: "OUT", "Source name": "", "Target name": "" })]),
    );
    const emptyUnknown = firstRow(
      csv([
        cells({
          Direction: "OTHER",
          "Source name": "",
          "Target name": "",
          "Source amount (after fees)": "0",
        }),
      ]),
    );
    expect(counterpartyName(emptyIn)).toBeUndefined();
    expect(counterpartyName(emptyOut)).toBeUndefined();
    expect(counterpartyName(emptyUnknown)).toBeUndefined();
    expect(humanWiseDescription(emptyIn, "main")).toBe("");
  });
});

describe("isJarTransfer", () => {
  it("detects jar text and same-name zero-fee self-transfers", () => {
    const byCategory = firstRow(csv([cells({ Category: "Jar" })]));
    const byNote = firstRow(csv([cells({ Note: "Moving to a jar" })]));
    const byRef = firstRow(csv([cells({ Reference: "JAR-1" })]));
    const self = firstRow(
      csv([cells({ "Source name": "Example Holder OÜ", "Target name": "Example Holder OÜ" })]),
    );
    const paidSelf = firstRow(
      csv([
        cells({
          "Source name": "Example Holder OÜ",
          "Target name": "Example Holder OÜ",
          "Source fee amount": "0.3",
        }),
      ]),
    );
    const different = firstRow(
      csv([cells({ "Source name": "Example Holder OÜ", "Target name": "Example Payee OÜ" })]),
    );
    expect(isJarTransfer(byCategory)).toBe(true);
    expect(isJarTransfer(byNote)).toBe(true);
    expect(isJarTransfer(byRef)).toBe(true);
    expect(isJarTransfer(self)).toBe(true);
    expect(isJarTransfer(paidSelf)).toBe(false);
    expect(isJarTransfer(different)).toBe(false);
    const fxSelf = firstRow(
      csv([
        cells({
          "Source name": "Example Holder OÜ",
          "Target name": "Example Holder OÜ",
          "Source currency": "EUR",
          "Target currency": "USD",
        }),
      ]),
    );
    expect(isJarTransfer(fxSelf)).toBe(false);
    expect(normalizeMatchText("  Foo   Bar ")).toBe("foo bar");
    expect(normalizeMatchText(null)).toBe("");
    expect(normalizeMatchText(undefined)).toBe("");
  });
});

describe("wiseFxQuote and descriptions", () => {
  it("derives the EUR rate from source and target amounts for a USD card payment", () => {
    const row = firstRow(readFileSync(join(fixtures, "usd-card-payment.csv"), "utf8"));
    const fx = wiseFxQuote(row);
    expect(fx).toMatchObject({
      oppositeAmount: 38.64,
      oppositeCurrency: "EUR",
      eurRate: 0.92,
      currencyRate: 0.92,
      baseAmount: 38.64,
    });
    expect(humanWiseDescription(row, "main")).toBe(
      "Fictional Merchant Inc (Shopping) [38.64 EUR @ 0.92]",
    );
    expect(humanWiseDescription(row, "fee")).toBe("Wise fee");
  });

  it("books incoming FX in EUR and still records the foreign side", () => {
    const row = firstRow(
      csv([
        cells({
          Direction: "IN",
          "Source amount (after fees)": "100",
          "Source currency": "USD",
          "Target amount (after fees)": "92",
          "Target currency": "EUR",
          Category: "General",
          "Source name": "Customer Inc",
        }),
      ]),
    );
    expect(wiseFxQuote(row)).toMatchObject({
      oppositeAmount: 100,
      oppositeCurrency: "USD",
      eurRate: 0.92,
      currencyRate: 1,
      baseAmount: 92,
    });
    expect(humanWiseDescription(row, "main")).toBe("Customer Inc [100.00 USD @ 0.92]");
  });

  it("sets a unit rate for same-currency EUR rows and omits a quote for same-currency USD", () => {
    const eur = firstRow(csv([cells({})]));
    const usd = firstRow(
      csv([
        cells({
          "Source currency": "USD",
          "Target currency": "USD",
          "Source amount (after fees)": "10",
          "Target amount (after fees)": "10",
        }),
      ]),
    );
    expect(wiseFxQuote(eur)).toMatchObject({ currencyRate: 1, baseAmount: 10 });
    expect(wiseFxQuote(usd)).toBeUndefined();
    expect(humanWiseDescription(eur, "main")).toBe("Example Payee OÜ");
  });

  it("falls back to the CSV exchange rate when the foreign amount is missing, and omits a rate when neither side is EUR", () => {
    const missingForeign = firstRow(
      csv([
        cells({
          Direction: "IN",
          "Source amount (after fees)": "0",
          "Source currency": "USD",
          "Target amount (after fees)": "50",
          "Target currency": "EUR",
          "Exchange rate": "0.91",
          "Source name": "Payer",
        }),
      ]),
    );
    expect(wiseFxQuote(missingForeign)?.eurRate).toBe(0.91);
    expect(humanWiseDescription(missingForeign, "main")).toContain("@ 0.91");

    const gbpUsd = firstRow(
      csv([
        cells({
          "Source amount (after fees)": "10",
          "Source currency": "GBP",
          "Target amount (after fees)": "12",
          "Target currency": "USD",
          "Exchange rate": "1.2",
          Category: "",
        }),
      ]),
    );
    expect(wiseFxQuote(gbpUsd)).toMatchObject({
      oppositeAmount: 12,
      oppositeCurrency: "USD",
      eurRate: undefined,
      currencyRate: undefined,
    });
    expect(humanWiseDescription(gbpUsd, "main")).toBe("Example Payee OÜ [12.00 USD]");
  });

  it("formats a whole-number EUR rate without trailing decimals", () => {
    const row = firstRow(
      csv([
        cells({
          Direction: "IN",
          "Source amount (after fees)": "80",
          "Source currency": "USD",
          "Target amount (after fees)": "80",
          "Target currency": "EUR",
          "Source name": "Payer Inc",
          Category: "General",
        }),
      ]),
    );
    expect(wiseFxQuote(row)?.eurRate).toBe(1);
    expect(humanWiseDescription(row, "main")).toBe("Payer Inc [80.00 USD @ 1]");
  });

  it("still records the foreign side when the EUR booking has no opposite amount or rate", () => {
    const row = firstRow(
      csv([
        cells({
          Direction: "IN",
          "Source amount (after fees)": "0",
          "Source currency": "USD",
          "Target amount (after fees)": "50",
          "Target currency": "EUR",
          "Exchange rate": "0",
          "Source name": "Payer",
        }),
      ]),
    );
    expect(wiseFxQuote(row)).toMatchObject({ currencyRate: 1, eurRate: undefined, baseAmount: 50 });
    expect(humanWiseDescription(row, "main")).toBe("Payer [0.00 USD @ 1]");
  });
});
