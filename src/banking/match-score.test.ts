import { describe, expect, it } from "vitest";
import {
  amountsClose,
  buildInvoiceDistribution,
  canAutoDistribute,
  invoiceEligibleForTransaction,
  invoiceGross,
  type MatchableInvoice,
  normalizeName,
  scoreTransactionToInvoice,
} from "./match-score.js";

const sale: MatchableInvoice = {
  id: 10,
  kind: "sale",
  clients_id: 5,
  client_name: "Acme Office Supplies",
  gross_price: 100,
  bank_ref_number: "REF-1",
  payment_status: "NOT_PAID",
  status: "CONFIRMED",
};

describe("match-score", () => {
  it("invoiceGross prefers gross_price then total_amount", () => {
    expect(invoiceGross({ id: 1, kind: "sale", clients_id: 1, gross_price: 9 })).toBe(9);
    expect(invoiceGross({ id: 1, kind: "sale", clients_id: 1, total_amount: 8 })).toBe(8);
    expect(invoiceGross({ id: 1, kind: "sale", clients_id: 1 })).toBe(0);
  });

  it("amountsClose and normalizeName helpers", () => {
    expect(amountsClose(1, 1.005)).toBe(true);
    expect(amountsClose(1, 1.02)).toBe(false);
    expect(normalizeName("  Foo   Bar ")).toBe("foo bar");
    expect(normalizeName(null)).toBe("");
  });

  it("scores exact amount, ref, client, and name", () => {
    const result = scoreTransactionToInvoice(
      {
        amount: 100,
        base_amount: 100,
        ref_number: "REF-1",
        clients_id: 5,
        bank_account_name: "Acme Office",
        type: "C",
      },
      sale,
    );
    expect(result.reasons).toContain("exact_amount");
    expect(result.reasons).toContain("ref_number");
    expect(result.reasons).toContain("client_id");
    expect(result.reasons).toContain("client_name_partial");
    expect(result.confidence).toBe(100);
    expect(result.baseOnlyMatch).toBe(false);
  });

  it("scores base-only and close amount and partially paid penalty", () => {
    const baseOnly = scoreTransactionToInvoice(
      {
        amount: 110,
        base_amount: 100,
        ref_number: null,
        clients_id: null,
        bank_account_name: null,
        type: "C",
      },
      { ...sale, bank_ref_number: null, clients_id: null, client_name: "X", base_amount: 100 },
    );
    expect(baseOnly.reasons).toContain("exact_base_amount");
    expect(baseOnly.baseOnlyMatch).toBe(true);

    const noSignal = scoreTransactionToInvoice(
      {
        amount: 999,
        base_amount: 999,
        ref_number: null,
        clients_id: null,
        bank_account_name: "ab",
        type: "C",
      },
      { ...sale, bank_ref_number: null, clients_id: null, client_name: "cd", gross_price: 1 },
    );
    expect(noSignal.confidence).toBe(0);

    const zeroBase = scoreTransactionToInvoice(
      {
        amount: 5,
        base_amount: 0,
        ref_number: null,
        clients_id: null,
        bank_account_name: null,
        type: "C",
      },
      {
        ...sale,
        gross_price: 5,
        base_amount: 0,
        bank_ref_number: null,
        clients_id: null,
        client_name: "X",
      },
    );
    expect(zeroBase.reasons).toContain("exact_amount");

    const missingTxBase = scoreTransactionToInvoice(
      {
        amount: 100,
        base_amount: undefined as unknown as number,
        ref_number: null,
        clients_id: null,
        bank_account_name: null,
        type: "C",
      },
      { ...sale, bank_ref_number: null, clients_id: null, client_name: "X" },
    );
    expect(missingTxBase.reasons).toContain("exact_amount");

    const close = scoreTransactionToInvoice(
      {
        amount: 100.5,
        base_amount: 100.5,
        ref_number: null,
        clients_id: null,
        bank_account_name: null,
        type: "C",
      },
      { ...sale, bank_ref_number: null, clients_id: null, client_name: "X", gross_price: 100 },
    );
    expect(close.reasons).toContain("close_amount");

    const partial = scoreTransactionToInvoice(
      {
        amount: 100,
        base_amount: 100,
        ref_number: null,
        clients_id: null,
        bank_account_name: null,
        type: "C",
      },
      {
        ...sale,
        payment_status: "PARTIALLY_PAID",
        bank_ref_number: null,
        clients_id: null,
        client_name: "X",
      },
    );
    expect(partial.partiallyPaid).toBe(true);
    expect(partial.reasons).toContain("partially_paid_warning");
    expect(partial.confidence).toBe(25);
  });

  it("invoice eligibility follows C=sale D=purchase", () => {
    expect(invoiceEligibleForTransaction("C", "sale")).toBe(true);
    expect(invoiceEligibleForTransaction("C", "purchase")).toBe(false);
    expect(invoiceEligibleForTransaction("D", "purchase")).toBe(true);
    expect(invoiceEligibleForTransaction("D", "sale")).toBe(false);
  });

  it("buildInvoiceDistribution and canAutoDistribute", () => {
    expect(buildInvoiceDistribution({ amount: -50 }, sale)).toEqual({
      related_table: "sale_invoices",
      related_id: 10,
      amount: 50,
    });
    expect(buildInvoiceDistribution({ amount: 20 }, { ...sale, kind: "purchase", id: 3 })).toEqual({
      related_table: "purchase_invoices",
      related_id: 3,
      amount: 20,
    });

    const good = scoreTransactionToInvoice(
      {
        amount: 100,
        base_amount: 100,
        ref_number: null,
        clients_id: null,
        bank_account_name: null,
        type: "C",
      },
      { ...sale, bank_ref_number: null, clients_id: null, client_name: "X" },
    );
    expect(canAutoDistribute(good)).toBe(true);

    const fx = scoreTransactionToInvoice(
      {
        amount: 110,
        base_amount: 100,
        ref_number: null,
        clients_id: null,
        bank_account_name: null,
        type: "C",
      },
      { ...sale, bank_ref_number: null, clients_id: null, client_name: "X" },
    );
    expect(canAutoDistribute(fx)).toBe(false);

    const partial = scoreTransactionToInvoice(
      {
        amount: 100,
        base_amount: 100,
        ref_number: null,
        clients_id: null,
        bank_account_name: null,
        type: "C",
      },
      {
        ...sale,
        payment_status: "PARTIALLY_PAID",
        bank_ref_number: null,
        clients_id: null,
        client_name: "X",
      },
    );
    expect(canAutoDistribute(partial)).toBe(false);
  });
});
