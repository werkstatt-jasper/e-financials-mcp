import { describe, expect, it } from "vitest";
import { mergePurchaseInvoiceItems } from "./merge-purchase-invoice-items.js";

describe("mergePurchaseInvoiceItems", () => {
  it("drops undefined patch fields so they do not clobber current values", () => {
    const merged = mergePurchaseInvoiceItems(
      [{ id: 1, custom_title: "keep", amount: 2 }],
      [{ id: 1, custom_title: undefined, amount: 3 }],
    );
    expect(merged).toEqual([{ id: 1, custom_title: "keep", amount: 3 }]);
  });
});
