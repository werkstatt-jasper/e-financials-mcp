import { describe, expect, it } from "vitest";
import {
  buildProductUnitById,
  defaultProductIdFromList,
  extractProductsList,
  mapSalesInvoiceItems,
  mergeProductUnit,
  missingProductIdsForUnit,
  nonEmptyUnit,
  rowsNeedProductLookup,
} from "./sales-invoice-rows.js";

const products = [
  { id: 10, unit: "m3" },
  { id: 11, unit: "krt." },
];

describe("extractProductsList", () => {
  it("parses a raw array", () => {
    expect(extractProductsList(products)).toEqual(products);
  });

  it("parses { items }", () => {
    expect(extractProductsList({ items: products })).toEqual(products);
  });

  it("returns empty for missing or invalid items", () => {
    expect(extractProductsList({})).toEqual([]);
    expect(extractProductsList(null)).toEqual([]);
    expect(extractProductsList(undefined)).toEqual([]);
    expect(extractProductsList({ items: "nope" })).toEqual([]);
  });
});

describe("nonEmptyUnit / product unit map", () => {
  it("treats blank and non-string units as missing", () => {
    expect(nonEmptyUnit("m3")).toBe("m3");
    expect(nonEmptyUnit("  tk  ")).toBe("tk");
    expect(nonEmptyUnit("")).toBeUndefined();
    expect(nonEmptyUnit("   ")).toBeUndefined();
    expect(nonEmptyUnit(null)).toBeUndefined();
  });

  it("indexes products that have a unit", () => {
    const map = buildProductUnitById([
      { id: 10, unit: "m3" },
      { id: 11, unit: null },
      { id: 12, unit: "  " },
      { unit: "tk" },
    ]);
    expect([...map.entries()]).toEqual([[10, "m3"]]);
  });

  it("uses the first product id or 1", () => {
    expect(defaultProductIdFromList(products)).toBe(10);
    expect(defaultProductIdFromList([])).toBe(1);
  });

  it("merges a single-product GET using fallback id", () => {
    const map = new Map<number, string>();
    mergeProductUnit(map, { unit: "m2" }, 77);
    expect(map.get(77)).toBe("m2");
  });

  it("merges a listed product GET", () => {
    const map = new Map<number, string>();
    mergeProductUnit(map, { items: [{ id: 77, unit: "m3" }] }, 1);
    expect(map.get(77)).toBe("m3");
    expect(map.has(1)).toBe(false);
  });

  it("ignores a non-object or product without id/unit", () => {
    const map = new Map<number, string>();
    mergeProductUnit(map, null);
    mergeProductUnit(map, { id: 5 });
    mergeProductUnit(map, { unit: "m2" });
    expect(map.size).toBe(0);
  });
});

describe("rowsNeedProductLookup / missingProductIdsForUnit", () => {
  it("needs a lookup when products_id or unit is missing", () => {
    expect(rowsNeedProductLookup([{ products_id: 10, unit: "m3" }])).toBe(false);
    expect(rowsNeedProductLookup([{ products_id: 10 }])).toBe(true);
    expect(rowsNeedProductLookup([{ unit: "tk" }])).toBe(true);
  });

  it("lists products_id values that still need a unit", () => {
    const known = new Map([[10, "m3"]]);
    expect(
      missingProductIdsForUnit(
        [
          { products_id: 10 },
          { products_id: 77 },
          { products_id: 77 },
          { description: "x", unit: "tk" } as { products_id?: number; unit?: string },
        ],
        known,
      ),
    ).toEqual([77]);
  });
});

describe("mapSalesInvoiceItems", () => {
  const ctx = {
    defaultProductId: 1,
    unitById: new Map([
      [10, "m3"],
      [1, "tk"],
    ]),
  };

  it("remaps friendly keys to API item keys", () => {
    expect(
      mapSalesInvoiceItems(
        [{ description: "Water", quantity: 2, unit_price: 5, products_id: 10, vat_rate_id: 3 }],
        ctx,
      ),
    ).toEqual([
      {
        custom_title: "Water",
        products_id: 10,
        amount: 2,
        unit_net_price: 5,
        total_net_price: 10,
        vat_accounts_id: 3,
        sale_accounts_dimensions_id: undefined,
        unit: "m3",
      },
    ]);
  });

  it("lets an explicit unit win over the product", () => {
    expect(
      mapSalesInvoiceItems(
        [{ description: "Water", quantity: 1, unit_price: 1, products_id: 10, unit: "m2" }],
        ctx,
      )[0],
    ).toMatchObject({ unit: "m2" });
  });

  it("omits unit when the product is unknown", () => {
    expect(
      mapSalesInvoiceItems([{ description: "X", quantity: 1, unit_price: 1, products_id: 99 }], {
        defaultProductId: 1,
        unitById: new Map(),
      })[0],
    ).not.toHaveProperty("unit");
  });

  it("uses the default product id and its unit", () => {
    expect(
      mapSalesInvoiceItems([{ description: "X", quantity: 1, unit_price: 1 }], ctx)[0],
    ).toMatchObject({ products_id: 1, unit: "tk" });
  });
});
