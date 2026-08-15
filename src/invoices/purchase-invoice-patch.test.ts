import { describe, expect, it } from "vitest";
import { buildPurchaseInvoiceTotalsPatch } from "./purchase-invoice-patch.js";

describe("buildPurchaseInvoiceTotalsPatch", () => {
  it("always includes items even when the line list is empty", () => {
    const body = buildPurchaseInvoiceTotalsPatch({
      vat_price: 0,
      gross_price: 10,
      items: [],
    });
    expect(body).toEqual({ vat_price: 0, gross_price: 10, items: [] });
    expect(Object.hasOwn(body, "items")).toBe(true);
  });

  it("forwards fetched line items on a totals repair", () => {
    const items = [{ total_net_price: 100, vat_amount: 24 }];
    const body = buildPurchaseInvoiceTotalsPatch({
      vat_price: 24,
      gross_price: 124,
      items,
    });
    expect(body.items).toBe(items);
    expect(body).toEqual({
      vat_price: 24,
      gross_price: 124,
      items,
    });
  });
});
