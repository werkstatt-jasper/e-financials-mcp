import { describe, expect, it } from "vitest";
import {
  assertNewPurchaseInvoiceLineComplete,
  assertPurchaseLineDeletesAreNotPatched,
  mergePurchaseInvoiceItems,
  omitPurchaseInvoiceItems,
} from "./merge-purchase-invoice-items.js";

describe("mergePurchaseInvoiceItems", () => {
  it("drops undefined patch fields so they do not clobber current values", () => {
    const merged = mergePurchaseInvoiceItems(
      [{ id: 1, custom_title: "keep", amount: 2 }],
      [{ id: 1, custom_title: undefined, amount: 3 }],
    );
    expect(merged).toEqual([{ id: 1, custom_title: "keep", amount: 3 }]);
  });

  it("appends a line unchanged when no buildAppended is given", () => {
    const merged = mergePurchaseInvoiceItems(
      [{ id: 1, custom_title: "keep" }],
      [{ custom_title: "FAKE-NEW", amount: 1, unit_net_price: 5, cl_purchase_articles_id: 39 }],
    );
    expect(merged).toEqual([
      { id: 1, custom_title: "keep" },
      { custom_title: "FAKE-NEW", amount: 1, unit_net_price: 5, cl_purchase_articles_id: 39 },
    ]);
  });

  it("runs buildAppended only for lines without an id", () => {
    const merged = mergePurchaseInvoiceItems(
      [{ id: 1, custom_title: "keep" }],
      [
        { id: 1, amount: 3 },
        { custom_title: "FAKE-NEW", amount: 1, unit_net_price: 5, cl_purchase_articles_id: 39 },
      ],
      (fields) => ({ ...fields, built: true }),
    );
    expect(merged).toEqual([
      { id: 1, custom_title: "keep", amount: 3 },
      {
        custom_title: "FAKE-NEW",
        amount: 1,
        unit_net_price: 5,
        cl_purchase_articles_id: 39,
        built: true,
      },
    ]);
  });
});

describe("assertNewPurchaseInvoiceLineComplete", () => {
  const complete = {
    custom_title: "FAKE-NEW",
    amount: 1,
    unit_net_price: 5,
    cl_purchase_articles_id: 39,
  };

  it("accepts a line with title, amount, price, and article", () => {
    expect(() => assertNewPurchaseInvoiceLineComplete(complete)).not.toThrow();
    expect(() =>
      assertNewPurchaseInvoiceLineComplete({
        custom_title: "FAKE-NEW",
        amount: 0,
        total_net_price: 0,
        cl_purchase_articles_id: 39,
      }),
    ).not.toThrow();
  });

  it("lists every missing field", () => {
    expect(() => assertNewPurchaseInvoiceLineComplete({ vat_rate_dropdown: "-" })).toThrow(
      "New purchase invoice lines require custom_title, amount, a price (unit_net_price or total_net_price), and cl_purchase_articles_id. Missing: custom_title, amount, unit_net_price or total_net_price, cl_purchase_articles_id.",
    );
  });

  it("rejects a blank title", () => {
    expect(() => assertNewPurchaseInvoiceLineComplete({ ...complete, custom_title: "  " })).toThrow(
      /Missing: custom_title/,
    );
  });
});

describe("assertPurchaseLineDeletesAreNotPatched", () => {
  it("allows an empty delete list", () => {
    expect(() => assertPurchaseLineDeletesAreNotPatched([{ id: 1, amount: 2 }], [])).not.toThrow();
  });

  it("allows a patch of a different line and an append", () => {
    expect(() =>
      assertPurchaseLineDeletesAreNotPatched(
        [{ id: 2, amount: 1 }, { custom_title: "FAKE-NEW" }],
        [1],
      ),
    ).not.toThrow();
  });

  it("rejects patching an id that is also deleted", () => {
    expect(() =>
      assertPurchaseLineDeletesAreNotPatched(
        [
          { id: 1, amount: 2 },
          { id: 2, custom_title: "FAKE" },
        ],
        [2, 1],
      ),
    ).toThrow(
      "Cannot patch and delete the same purchase invoice line (1, 2). Omit that id from items[] and pass it in delete_item_ids.",
    );
  });
});

describe("omitPurchaseInvoiceItems", () => {
  it("drops only the named lines and keeps relative order and non-numeric ids", () => {
    const orphan = { custom_title: "FAKE-ORPHAN" };
    const keep = { id: 1, custom_title: "FAKE-KEEP", vat_amount: 1.2 };
    const drop = { id: 2, custom_title: "FAKE-DROP" };
    expect(omitPurchaseInvoiceItems([orphan, keep, drop], [2, 2])).toEqual([orphan, keep]);
  });

  it("returns an empty list when every numeric line is deleted", () => {
    expect(omitPurchaseInvoiceItems([{ id: 4, custom_title: "FAKE-ONLY" }], [4])).toEqual([]);
  });

  it("returns the same lines when nothing is deleted", () => {
    const items = [{ id: 1 }, { custom_title: "FAKE-ORPHAN" }];
    expect(omitPurchaseInvoiceItems(items, [])).toEqual(items);
  });

  it("rejects every missing id before returning a partial list", () => {
    expect(() => omitPurchaseInvoiceItems([{ id: 1, custom_title: "FAKE" }], [9, 8])).toThrow(
      "Unknown purchase invoice line id: 9, 8",
    );
  });
});
