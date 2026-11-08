import { describe, expect, it } from "vitest";
import {
  confirmedPaymentLink,
  currencyCode,
  type DuplicateMatch,
  distributionLink,
  duplicatePaymentMessage,
  type InvoiceLinkRef,
  invoiceLink,
  matchSupplierDraft,
  paymentDay,
  paymentDimensionError,
  type RelatedPayment,
  roundedPaymentAmount,
  sameMoney,
  unpaidRemainder,
} from "./purchase-payment.js";

const invoice: InvoiceLinkRef = {
  id: 10,
  number: "1245",
  invoice_no: "F-9",
  bank_ref_number: "RF-1",
  transactions: [70],
};

const draftInput = {
  supplierId: 19,
  amount: 37.2,
  currency: "EUR",
  date: "2026-10-01",
  invoice,
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 70,
    type: "D",
    status: "PROJECT",
    clients_id: 19,
    amount: 37.2,
    cl_currencies_id: "EUR",
    date: "2026-10-01",
    description: "Ostuarve nr 1245 tasumine",
    ...overrides,
  };
}

describe("purchase payment amount and currency", () => {
  it("rounds with the same 2 decimal path as roundMoney", () => {
    expect(roundedPaymentAmount(10.005)).toBe(10.01);
    expect(roundedPaymentAmount(10.004)).toBe(10);
    expect(roundedPaymentAmount(37.2)).toBe(37.2);
  });

  it("normalizes currency codes and compares rounded amounts", () => {
    expect(currencyCode(" eur ")).toBe("EUR");
    expect(currencyCode(1)).toBe("");
    expect(sameMoney(10.004, 10)).toBe(true);
    expect(sameMoney(10.2, 10)).toBe(false);
    expect(sameMoney("10", 10)).toBe(false);
    expect(sameMoney(Number.NaN, 10)).toBe(false);
    expect(sameMoney(Number.POSITIVE_INFINITY, 10)).toBe(false);
  });

  it("accepts only a calendar-date prefix", () => {
    expect(paymentDay("2026-10-01T00:00:00")).toBe("2026-10-01");
    expect(paymentDay("yesterday")).toBe("");
    expect(paymentDay(20261001)).toBe("");
  });
});

describe("payment dimension", () => {
  const dimension = {
    id: 7,
    accounts_id: 1360,
    cl_currencies_id: "EUR",
  };

  it("accepts an outgoing-selectable chart account in the invoice currency", () => {
    expect(
      paymentDimensionError({
        dimensionId: 7,
        invoiceCurrency: "eur",
        dimensions: [dimension],
        accounts: [{ id: 1360, transaction_out_bindable: true }],
        bankAccounts: [],
      }),
    ).toBeNull();
    expect(
      paymentDimensionError({
        dimensionId: 7,
        invoiceCurrency: "EUR",
        dimensions: [dimension],
        accounts: [{ id: 1360, transaction_out_user_bindable: true }],
        bankAccounts: [{ accounts_dimensions_id: "7" }],
      }),
    ).toBeNull();
  });

  it("accepts a dimension listed on a bank account", () => {
    expect(
      paymentDimensionError({
        dimensionId: 7,
        invoiceCurrency: "EUR",
        dimensions: [dimension],
        accounts: [],
        bankAccounts: [{ accounts_dimensions_id: 7 }],
      }),
    ).toBeNull();
  });

  it("refuses a missing dimension, a missing currency, a mismatch, or a non-payment account", () => {
    expect(
      paymentDimensionError({
        dimensionId: 8,
        invoiceCurrency: "EUR",
        dimensions: [dimension],
        accounts: [],
        bankAccounts: [],
      }),
    ).toMatch(/was not found/);
    expect(
      paymentDimensionError({
        dimensionId: 7,
        invoiceCurrency: "",
        dimensions: [{ ...dimension, cl_currencies_id: "" }],
        accounts: [],
        bankAccounts: [],
      }),
    ).toMatch(/no currency/);
    expect(
      paymentDimensionError({
        dimensionId: 7,
        invoiceCurrency: "",
        dimensions: [dimension],
        accounts: [],
        bankAccounts: [],
      }),
    ).toMatch(/unknown/);
    expect(
      paymentDimensionError({
        dimensionId: 7,
        invoiceCurrency: "USD",
        dimensions: [dimension],
        accounts: [],
        bankAccounts: [],
      }),
    ).toMatch(/is in EUR/);
    expect(
      paymentDimensionError({
        dimensionId: 7,
        invoiceCurrency: "EUR",
        dimensions: [dimension],
        accounts: [],
        bankAccounts: [],
      }),
    ).toMatch(/belongs to account 1360/);
    expect(
      paymentDimensionError({
        dimensionId: 7,
        invoiceCurrency: "EUR",
        dimensions: [dimension],
        accounts: [{ id: 1360 }],
        bankAccounts: [],
      }),
    ).toMatch(/not a cash or bank account/);
  });
});

describe("invoice linkage", () => {
  it("matches a bounded invoice token, a reference, or the invoice transaction list", () => {
    expect(invoiceLink({ description: "Ostuarve nr 1245 tasumine" }, invoice)).toMatch(/1245/);
    expect(invoiceLink({ description: "see 12450" }, invoice)).toBeNull();
    expect(invoiceLink({ description: "Invoice A.1", id: 3 }, { id: 3, number: "A.1" })).toMatch(
      /A\.1/,
    );
    expect(invoiceLink({ description: "other", ref_number: "F-9" }, invoice)).toMatch(
      /invoice number/,
    );
    expect(invoiceLink({ description: "other", ref_number: " RF-1 " }, invoice)).toMatch(
      /bank reference/,
    );
    expect(invoiceLink({ id: 70, description: "other", ref_number: "nope" }, invoice)).toMatch(
      /listed/,
    );
    expect(
      invoiceLink(
        { description: "other", ref_number: "  " },
        { id: 10, number: "  ", invoice_no: null },
      ),
    ).toBeNull();
    expect(invoiceLink({ description: "nr 10 done" }, { id: 10, number: "   " })).toMatch(
      /invoice 10/,
    );
    expect(
      invoiceLink({ id: 4, description: 1, ref_number: 2 }, { id: 4, transactions: null }),
    ).toBeNull();
    expect(invoiceLink({ id: 4 }, { id: 10, number: "10", transactions: [4] })).toMatch(/listed/);
  });

  it("classifies distribution rows", () => {
    expect(distributionLink(undefined, 10)).toBe("absent");
    expect(distributionLink("rows", 10)).toBe("invalid");
    expect(
      distributionLink(
        [
          null,
          "x",
          { relation_table: "sale_invoices", relation_id: 10 },
          { related_table: "purchase_invoices", related_id: 10 },
        ],
        10,
      ),
    ).toBe("linked");
    expect(distributionLink([{ relation_table: "sale_invoices", relation_id: 10 }], 10)).toBe(
      "unrelated",
    );
  });
});

describe("duplicate matches", () => {
  it("matches only an outgoing same-day supplier draft linked to the invoice", () => {
    expect(matchSupplierDraft(draft(), draftInput)).toMatchObject({
      id: 70,
      kind: "outgoing_supplier_draft",
      link: "description contains invoice 1245",
    });
    expect(matchSupplierDraft(draft({ type: "C" }), draftInput)).toBeNull();
    expect(matchSupplierDraft(draft({ status: "CONFIRMED" }), draftInput)).toBeNull();
    expect(matchSupplierDraft(draft({ clients_id: 20 }), draftInput)).toBeNull();
    expect(matchSupplierDraft(draft({ amount: 5 }), draftInput)).toBeNull();
    expect(matchSupplierDraft(draft({ cl_currencies_id: "usd" }), draftInput)).toBeNull();
    expect(matchSupplierDraft(draft({ date: "2026-09-30" }), draftInput)).toBeNull();
    expect(
      matchSupplierDraft(draft({ description: "rent", ref_number: null }), draftInput),
    ).toMatchObject({ link: "listed on the purchase invoice" });
    expect(
      matchSupplierDraft(draft({ description: "rent", ref_number: null, id: 80 }), {
        ...draftInput,
        invoice: { ...invoice, transactions: [] },
      }),
    ).toBeNull();
  });

  it("matches a confirmed outgoing payment by distribution, text, or invoice list", () => {
    const input = { amount: 5, currency: "EUR", date: "2026-10-02", invoice };
    const base = {
      id: 60,
      status: "CONFIRMED",
      amount: 5,
      cl_currencies_id: "EUR",
      date: "2026-10-02T12:00:00",
      description: "Ostuarve nr 1245 tasumine",
    };
    expect(
      confirmedPaymentLink(
        {
          ...base,
          items: [{ relation_table: "purchase_invoices", relation_id: 10, amount: 5 }],
        },
        input,
      ),
    ).toMatch(/distribution row/);
    expect(confirmedPaymentLink(base, input)).toMatch(/description contains/);
    expect(
      confirmedPaymentLink(
        { ...base, description: "wire", id: 60 },
        { ...input, invoice: { id: 10, transactions: [60] } },
      ),
    ).toMatch(/listed/);
    expect(
      confirmedPaymentLink(
        { ...base, description: undefined, ref_number: undefined, id: undefined, items: undefined },
        { ...input, invoice: { id: 10 } },
      ),
    ).toBe("listed on the purchase invoice");
    expect(confirmedPaymentLink({ ...base, is_deleted: true }, input)).toBeNull();
    expect(confirmedPaymentLink({ ...base, status: "VOID" }, input)).toBeNull();
    expect(confirmedPaymentLink({ ...base, amount: 1 }, input)).toBeNull();
    expect(confirmedPaymentLink({ ...base, cl_currencies_id: "USD" }, input)).toBeNull();
    expect(confirmedPaymentLink({ ...base, date: "nope" }, input)).toBeNull();
    expect(confirmedPaymentLink({ ...base, items: { rows: true } }, input)).toBeNull();
    expect(
      confirmedPaymentLink(
        { ...base, items: [{ relation_table: "accounts", relation_id: 1360 }] },
        input,
      ),
    ).toBeNull();
  });

  it("names each matched row and the link that selected it", () => {
    const matches: DuplicateMatch[] = [
      {
        id: 70,
        status: "PROJECT",
        date: "2026-10-01",
        amount: 37.2,
        kind: "outgoing_supplier_draft",
        link: "description contains invoice 1245",
      },
      {
        id: 60,
        status: "CONFIRMED",
        date: "2026-10-01",
        amount: 5,
        kind: "outgoing_invoice_payment",
        link: "distribution row for this purchase invoice",
      },
    ];
    expect(duplicatePaymentMessage(10, matches)).toBe(
      "Possible duplicate payment for purchase invoice 10: transaction 70 matched as an outgoing PROJECT draft (PROJECT, 2026-10-01, 37.2; description contains invoice 1245); transaction 60 matched as an outgoing CONFIRMED payment (CONFIRMED, 2026-10-01, 5; distribution row for this purchase invoice). Register an existing draft with register_transaction, delete it with delete_transaction, or pass allow_duplicate=true to create another payment.",
    );
  });
});

describe("unpaid remainder", () => {
  const currency = "EUR";
  const base = {
    invoiceId: 10,
    gross: 10,
    currency,
    settlements: [] as unknown,
    paidInCash: false as unknown,
    transactionIds: [60] as unknown,
  };

  function payment(overrides: Partial<RelatedPayment> = {}): RelatedPayment {
    return {
      id: 60,
      status: "CONFIRMED",
      direction: "outgoing",
      items: [
        {
          relation_table: "purchase_invoices",
          relation_id: 10,
          amount: 4,
          cl_currencies_id: "eur",
        },
      ],
      ...overrides,
    };
  }

  it("subtracts confirmed outgoing distributions in the invoice currency", () => {
    expect(unpaidRemainder({ ...base, related: [payment()] })).toEqual({
      ok: true,
      paid: 4,
      remaining: 6,
    });
    expect(
      unpaidRemainder({
        ...base,
        gross: 10.005,
        related: [
          payment({
            items: [
              null,
              { relation_table: "accounts", relation_id: 1, amount: 99 },
              { related_table: "purchase_invoices", related_id: 10, amount: 1.004 },
              { relation_table: "purchase_invoices", relation_id: 10, amount: 2.001 },
            ],
          }),
        ],
      }),
    ).toEqual({ ok: true, paid: 3, remaining: 7.01 });
    expect(
      unpaidRemainder({
        ...base,
        related: [
          payment({
            items: [{ relation_table: "purchase_invoices", relation_id: 10, amount: 10 }],
          }),
        ],
      }),
    ).toEqual({
      ok: true,
      paid: 10,
      remaining: 0,
    });
  });

  it("refuses when the remainder cannot be established", () => {
    expect(unpaidRemainder({ ...base, settlements: undefined, related: [] }).ok).toBe(false);
    expect(unpaidRemainder({ ...base, settlements: null, related: [] })).toMatchObject({
      reason: expect.stringMatching(/settlements were not/),
    });
    expect(unpaidRemainder({ ...base, settlements: { id: 1 }, related: [] })).toMatchObject({
      reason: expect.stringMatching(/settlements were not/),
    });
    expect(unpaidRemainder({ ...base, settlements: [1], related: [] })).toMatchObject({
      reason: expect.stringMatching(/no amounts/),
    });
    expect(unpaidRemainder({ ...base, paidInCash: true, related: [] })).toMatchObject({
      reason: expect.stringMatching(/paid_in_cash/),
    });
    expect(unpaidRemainder({ ...base, transactionIds: undefined, related: [] })).toMatchObject({
      reason: expect.stringMatching(/transactions were not/),
    });
    expect(unpaidRemainder({ ...base, gross: null, related: [] })).toMatchObject({
      reason: expect.stringMatching(/gross price/),
    });
    expect(unpaidRemainder({ ...base, gross: 0, related: [] })).toMatchObject({
      reason: expect.stringMatching(/gross price/),
    });
    expect(unpaidRemainder({ ...base, gross: Number.NaN, related: [] })).toMatchObject({
      reason: expect.stringMatching(/gross price/),
    });
    expect(unpaidRemainder({ ...base, currency: " ", related: [payment()] })).toMatchObject({
      reason: expect.stringMatching(/currency is missing/),
    });
    expect(unpaidRemainder({ ...base, transactionIds: ["x"], related: [] })).toMatchObject({
      reason: expect.stringMatching(/not a number/),
    });
    expect(unpaidRemainder({ ...base, related: [] })).toMatchObject({
      reason: expect.stringMatching(/could not be read/),
    });
    expect(
      unpaidRemainder({
        ...base,
        transactionIds: [1, 60],
        related: [payment({ id: 1, is_deleted: true }), payment()],
      }),
    ).toEqual({ ok: true, paid: 4, remaining: 6 });
    expect(
      unpaidRemainder({
        ...base,
        transactionIds: [1],
        related: [payment({ id: 1, status: "VOID" })],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/no confirmed outgoing/) });
    expect(
      unpaidRemainder({
        ...base,
        transactionIds: [1],
        related: [payment({ id: 1, status: "PROJECT" })],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/no confirmed outgoing/) });
    expect(
      unpaidRemainder({
        ...base,
        related: [payment({ status: undefined })],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/status unknown/) });
    expect(
      unpaidRemainder({
        ...base,
        related: [payment({ status: "HOLD" })],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/HOLD/) });
    expect(
      unpaidRemainder({
        ...base,
        related: [payment({ direction: "incoming" })],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/incoming/) });
    expect(
      unpaidRemainder({
        ...base,
        related: [payment({ direction: "unknown" })],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/unknown/) });
    expect(unpaidRemainder({ ...base, related: [payment({ items: undefined })] })).toMatchObject({
      reason: expect.stringMatching(/no distribution rows/),
    });
    expect(unpaidRemainder({ ...base, related: [payment({ items: {} })] })).toMatchObject({
      reason: expect.stringMatching(/no distribution rows/),
    });
    expect(unpaidRemainder({ ...base, related: [payment({ items: [] })] })).toMatchObject({
      reason: expect.stringMatching(/no distribution for this purchase invoice/),
    });
    expect(
      unpaidRemainder({
        ...base,
        related: [
          payment({
            items: [
              {
                relation_table: "purchase_invoices",
                relation_id: 10,
                cl_currencies_id: "USD",
                amount: 4,
              },
            ],
          }),
        ],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/USD/) });
    expect(
      unpaidRemainder({
        ...base,
        related: [
          payment({
            items: [{ relation_table: "purchase_invoices", relation_id: 10, amount: Number.NaN }],
          }),
        ],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/numeric amount/) });
    expect(
      unpaidRemainder({
        ...base,
        related: [
          payment({
            items: [{ relation_table: "purchase_invoices", relation_id: 10, amount: "4" }],
          }),
        ],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/numeric amount/) });
    expect(
      unpaidRemainder({
        ...base,
        related: [
          payment({
            items: [{ relation_table: "purchase_invoices", relation_id: 10, amount: 11 }],
          }),
        ],
      }),
    ).toMatchObject({ reason: expect.stringMatching(/exceed the gross price/) });
  });
});
