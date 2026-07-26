import { describe, expect, it } from "vitest";
import type { PurchaseInvoice } from "../types/invoice.js";
import { suggestBookingFromHistory } from "./supplier-history.js";

function purchase(overrides: Record<string, unknown> = {}): PurchaseInvoice {
  return {
    id: 1,
    clients_id: 10,
    client_name: "Acme SaaS OÜ",
    create_date: "2025-05-01",
    status: "CONFIRMED",
    payment_status: "PAID",
    cl_currencies_id: "EUR",
    gross_price: 29,
    vat_price: 0,
    ...overrides,
  } as PurchaseInvoice;
}

describe("suggestBookingFromHistory", () => {
  it("returns null when no confirmed match", () => {
    expect(suggestBookingFromHistory("Nobody", null, [])).toBeNull();
    expect(
      suggestBookingFromHistory("Acme", 10, [
        purchase({ status: "PROJECT", items: [{ cl_purchase_articles_id: 23 }] }),
      ]),
    ).toBeNull();
  });

  it("matches by clients_id and prefers newest confirmed with article", () => {
    const result = suggestBookingFromHistory("Other Name", 10, [
      purchase({
        id: 1,
        create_date: "2025-01-01",
        items: [{ cl_purchase_articles_id: 39, vat_rate_dropdown: "0" }],
      }),
      purchase({
        id: 2,
        create_date: "2025-06-01",
        items: [
          {
            cl_purchase_articles_id: 23,
            purchase_accounts_dimensions_id: 99,
            vat_rate_dropdown: "24",
            vat_accounts_id: 5,
          },
        ],
        gross_price: 124,
        vat_price: 24,
      }),
      purchase({
        id: 3,
        create_date: "2025-07-01",
        items: [{ cl_purchase_articles_id: null }],
      }),
    ]);
    expect(result).toMatchObject({
      clients_id: 10,
      purchase_article_id: 23,
      purchase_accounts_dimensions_id: 99,
      vat_rate: 24,
      vat_amount: 24,
      vat_accounts_id: 5,
    });
  });

  it("matches by normalized name when id missing", () => {
    const result = suggestBookingFromHistory("acme saas", null, [
      purchase({
        client_name: "Acme SaaS OÜ",
        items: [{ cl_purchase_articles_id: 23 }],
      }),
    ]);
    expect(result?.purchase_article_id).toBe(23);
  });

  it("computes vat from rate when vat_price absent", () => {
    const result = suggestBookingFromHistory("Acme", 10, [
      purchase({
        vat_price: undefined,
        vat_amount: undefined,
        gross_price: 124,
        items: [{ cl_purchase_articles_id: 23, vat_rate_dropdown: "24" }],
      }),
    ]);
    expect(result?.vat_amount).toBeGreaterThan(0);
  });

  it("uses invoice_date, supplier_name, total_amount, and vat_amount fallbacks", () => {
    const result = suggestBookingFromHistory("Supplier Co", null, [
      {
        id: 9,
        clients_id: 3,
        client_name: undefined,
        supplier_name: "Supplier Co",
        create_date: undefined,
        invoice_date: "2025-03-01",
        status: "CONFIRMED",
        payment_status: "PAID",
        cl_currencies_id: "EUR",
        gross_price: undefined,
        total_amount: 50,
        vat_price: undefined,
        vat_amount: 0,
        items: [{ cl_purchase_articles_id: 39 }],
      } as PurchaseInvoice,
      {
        id: 8,
        clients_id: 3,
        supplier_name: "Supplier Co",
        create_date: undefined,
        invoice_date: undefined,
        status: "CONFIRMED",
        payment_status: "PAID",
        cl_currencies_id: "EUR",
        items: [{ cl_purchase_articles_id: 39 }],
      } as PurchaseInvoice,
    ]);
    expect(result).toMatchObject({
      client_name: "Supplier Co",
      purchase_article_id: 39,
      vat_amount: 0,
    });
  });

  it("falls back to counterparty name and zero vat when amounts missing", () => {
    const result = suggestBookingFromHistory("Fallback Name", 44, [
      {
        id: 1,
        clients_id: 44,
        status: "CONFIRMED",
        payment_status: "PAID",
        cl_currencies_id: "EUR",
        items: [{ cl_purchase_articles_id: 39, vat_rate_dropdown: "0" }],
      } as PurchaseInvoice,
    ]);
    expect(result?.client_name).toBe("Fallback Name");
    expect(result?.vat_amount).toBe(0);
  });
});
