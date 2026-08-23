import type { InvoiceRow } from "../types/invoice.js";

export type ProductUnitFields = {
  id?: number;
  unit?: string | null;
};

export type SalesInvoiceItemContext = {
  defaultProductId: number;
  unitById: Map<number, string>;
};

/** Normalize GET /v1/products (raw array or `{ items }`). */
export function extractProductsList(response: unknown): ProductUnitFields[] {
  if (Array.isArray(response)) {
    return response as ProductUnitFields[];
  }
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return obj.items as ProductUnitFields[];
    }
  }
  return [];
}

export function nonEmptyUnit(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function buildProductUnitById(products: ProductUnitFields[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const product of products) {
    const unit = nonEmptyUnit(product.unit);
    if (typeof product.id === "number" && unit !== undefined) {
      map.set(product.id, unit);
    }
  }
  return map;
}

export function defaultProductIdFromList(products: ProductUnitFields[]): number {
  return typeof products[0]?.id === "number" ? products[0].id : 1;
}

/** Merge a list or single-product GET into `unitById`. */
export function mergeProductUnit(
  unitById: Map<number, string>,
  response: unknown,
  fallbackId?: number,
): void {
  const listed = extractProductsList(response);
  if (listed.length > 0) {
    for (const [id, unit] of buildProductUnitById(listed)) {
      unitById.set(id, unit);
    }
    return;
  }
  if (response && typeof response === "object") {
    const obj = response as ProductUnitFields;
    const unit = nonEmptyUnit(obj.unit);
    const id = typeof obj.id === "number" ? obj.id : fallbackId;
    if (id !== undefined && unit !== undefined) {
      unitById.set(id, unit);
    }
  }
}

export function rowsNeedProductLookup(
  rows: Array<{ products_id?: number; unit?: string }>,
): boolean {
  return rows.some((row) => row.products_id == null || nonEmptyUnit(row.unit) === undefined);
}

export function missingProductIdsForUnit(
  rows: Array<{ products_id?: number; unit?: string }>,
  unitById: Map<number, string>,
): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (
      row.products_id != null &&
      nonEmptyUnit(row.unit) === undefined &&
      !unitById.has(row.products_id)
    ) {
      ids.add(row.products_id);
    }
  }
  return [...ids];
}

/** Map friendly MCP rows to RIK `SaleInvoicesItems`. Includes `unit` only when known. */
export function mapSalesInvoiceItems(
  rows: InvoiceRow[],
  ctx: SalesInvoiceItemContext,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const products_id = row.products_id ?? ctx.defaultProductId;
    const unit = nonEmptyUnit(row.unit) ?? ctx.unitById.get(products_id);
    return {
      custom_title: row.description,
      products_id,
      amount: row.quantity,
      unit_net_price: row.unit_price,
      total_net_price: row.quantity * row.unit_price,
      vat_accounts_id: row.vat_rate_id,
      sale_accounts_dimensions_id: row.accounts_id,
      ...(unit !== undefined ? { unit } : {}),
    };
  });
}
