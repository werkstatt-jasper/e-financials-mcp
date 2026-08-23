/**
 * Merge partial line patches onto an existing purchase-invoice `items` array.
 * Lines with `id` update in place; lines without `id` are appended.
 */

export type PurchaseInvoiceItemPatch = {
  id?: number;
} & Record<string, unknown>;

export function mergePurchaseInvoiceItems(
  currentItems: Array<Record<string, unknown>>,
  patches: PurchaseInvoiceItemPatch[],
): Array<Record<string, unknown>> {
  const byId = new Map<number, Record<string, unknown>>();
  for (const item of currentItems) {
    if (typeof item.id === "number") {
      byId.set(item.id, item);
    }
  }

  const appended: Array<Record<string, unknown>> = [];
  for (const patch of patches) {
    const { id, ...fields } = patch;
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as Record<string, unknown>;
    if (id !== undefined) {
      const existing = byId.get(id);
      if (!existing) {
        throw new Error(`Unknown purchase invoice line id: ${id}`);
      }
      byId.set(id, { ...existing, ...defined, id });
    } else {
      appended.push(defined);
    }
  }

  const merged = currentItems.map((item) =>
    typeof item.id === "number" ? (byId.get(item.id) as Record<string, unknown>) : item,
  );
  return [...merged, ...appended];
}
