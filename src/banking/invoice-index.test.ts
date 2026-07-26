import { describe, expect, it } from "vitest";
import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import {
  buildInvoiceIndexes,
  buildOpenInvoicePool,
  candidateInvoicesForTransaction,
  invoiceConsumptionKey,
  isOpenInvoice,
  rankInvoiceMatches,
  toMatchablePurchase,
  toMatchableSale,
} from "./invoice-index.js";

const saleConfirmed: SalesInvoice = {
  id: 1,
  clients_id: 9,
  client_name: "Buyer",
  gross_price: 50,
  cl_currencies_id: "EUR",
  status: "CONFIRMED",
  payment_status: "NOT_PAID",
};

const salePaid: SalesInvoice = {
  ...saleConfirmed,
  id: 2,
  payment_status: "PAID",
};

const saleDraft: SalesInvoice = {
  ...saleConfirmed,
  id: 3,
  status: "PROJECT",
};

const purchase: PurchaseInvoice = {
  id: 20,
  clients_id: 8,
  client_name: "Supplier",
  gross_price: 77,
  cl_currencies_id: "EUR",
  status: "CONFIRMED",
  payment_status: "NOT_PAID",
  bank_ref_number: "P-REF",
} as PurchaseInvoice & { bank_ref_number: string };

describe("invoice-index", () => {
  it("isOpenInvoice filters paid and non-confirmed", () => {
    expect(isOpenInvoice(saleConfirmed)).toBe(true);
    expect(isOpenInvoice(salePaid)).toBe(false);
    expect(isOpenInvoice(saleDraft)).toBe(false);
    expect(isOpenInvoice({ payment_status: "PARTIALLY_PAID" })).toBe(true);
  });

  it("builds open pool and matchable shapes", () => {
    const pool = buildOpenInvoicePool([saleConfirmed, salePaid, saleDraft], [purchase]);
    expect(pool.map((p) => p.id).sort()).toEqual([1, 20]);
    expect(toMatchableSale(saleConfirmed).kind).toBe("sale");
    expect(
      toMatchablePurchase({ ...purchase, supplier_name: "S", client_name: undefined }).client_name,
    ).toBe("S");
  });

  it("indexes by ref and amount and ranks matches", () => {
    const pool = buildOpenInvoicePool(
      [{ ...saleConfirmed, bank_ref_number: "R1" } as SalesInvoice & { bank_ref_number: string }],
      [purchase],
    );
    const indexes = buildInvoiceIndexes(pool);

    const saleCandidates = candidateInvoicesForTransaction(
      { amount: 50, ref_number: "R1", type: "C" },
      indexes,
    );
    expect(saleCandidates.some((c) => c.kind === "sale")).toBe(true);
    expect(saleCandidates.every((c) => c.kind === "sale")).toBe(true);

    const purchaseCandidates = candidateInvoicesForTransaction(
      { amount: 77, ref_number: "P-REF", type: "D" },
      indexes,
    );
    expect(purchaseCandidates[0]?.kind).toBe("purchase");

    const ranked = rankInvoiceMatches(
      {
        amount: 50,
        base_amount: 50,
        ref_number: "R1",
        clients_id: 9,
        bank_account_name: "Buyer",
        type: "C",
      },
      saleCandidates,
      50,
    );
    expect(ranked.best?.invoice.id).toBe(1);
    expect(ranked.otherCandidateCount).toBe(0);
    expect(ranked.best).toBeTruthy();
    if (!ranked.best) {
      throw new Error("expected best match");
    }
    expect(invoiceConsumptionKey(ranked.best.invoice)).toBe("sale:1");
  });

  it("falls back to scanning all when amount/ref miss", () => {
    const pool = buildOpenInvoicePool([saleConfirmed], []);
    const indexes = buildInvoiceIndexes(pool);
    const candidates = candidateInvoicesForTransaction(
      { amount: 9999, ref_number: null, type: "C" },
      indexes,
    );
    expect(candidates).toHaveLength(1);

    const missingRef = candidateInvoicesForTransaction(
      { amount: 9999, ref_number: "NO-SUCH-REF", type: "C" },
      indexes,
    );
    expect(missingRef).toHaveLength(1);
  });
});
