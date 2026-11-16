/**
 * Merge partial line patches onto an existing purchase-invoice `items` array.
 * Lines with `id` update in place; lines without `id` are appended.
 * Deletion is separate: upstream PATCH replaces `items`, so a line is removed
 * by omitting it. Callers opt in with ids passed to `omitPurchaseInvoiceItems`.
 */

export type PurchaseInvoiceItemPatch = {
  id?: number;
} & Record<string, unknown>;

/**
 * New lines (no `id`) must supply the same core fields create uses: title,
 * amount, a price, and a purchase article. Incomplete lines are rejected
 * before any PATCH.
 */
export function assertNewPurchaseInvoiceLineComplete(line: PurchaseInvoiceItemPatch): void {
  const missing: string[] = [];
  if (typeof line.custom_title !== "string" || line.custom_title.trim() === "") {
    missing.push("custom_title");
  }
  if (typeof line.amount !== "number") {
    missing.push("amount");
  }
  if (typeof line.unit_net_price !== "number" && typeof line.total_net_price !== "number") {
    missing.push("unit_net_price or total_net_price");
  }
  if (typeof line.cl_purchase_articles_id !== "number") {
    missing.push("cl_purchase_articles_id");
  }
  if (missing.length > 0) {
    throw new Error(
      `New purchase invoice lines require custom_title, amount, a price (unit_net_price or total_net_price), and cl_purchase_articles_id. Missing: ${missing.join(", ")}.`,
    );
  }
}

export function mergePurchaseInvoiceItems(
  currentItems: Array<Record<string, unknown>>,
  patches: PurchaseInvoiceItemPatch[],
  buildAppended: (fields: Record<string, unknown>) => Record<string, unknown> = (fields) => fields,
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
      appended.push(buildAppended(defined));
    }
  }

  const merged = currentItems.map((item) =>
    typeof item.id === "number" ? (byId.get(item.id) as Record<string, unknown>) : item,
  );
  return [...merged, ...appended];
}

/**
 * Reject a request that both patches and deletes the same line. Deletion wins
 * only when that id is absent from `items[]`.
 */
export function assertPurchaseLineDeletesAreNotPatched(
  patches: readonly PurchaseInvoiceItemPatch[],
  deleteIds: readonly number[],
): void {
  if (deleteIds.length === 0) return;
  const drop = new Set(deleteIds);
  const overlap = new Set<number>();
  for (const patch of patches) {
    if (typeof patch.id === "number" && drop.has(patch.id)) {
      overlap.add(patch.id);
    }
  }
  if (overlap.size > 0) {
    const ids = [...overlap].join(", ");
    throw new Error(
      `Cannot patch and delete the same purchase invoice line (${ids}). Omit that id from items[] and pass it in delete_item_ids.`,
    );
  }
}

/**
 * Return the lines to send on PATCH, which is how upstream removes a line:
 * the `items` array contains only retained lines. There is no DELETE item
 * endpoint. Lines without a numeric id cannot be selected and are kept.
 */
export function omitPurchaseInvoiceItems(
  currentItems: Array<Record<string, unknown>>,
  deleteIds: readonly number[],
): Array<Record<string, unknown>> {
  const drop = new Set(deleteIds);
  const present = new Set<number>();
  for (const item of currentItems) {
    if (typeof item.id === "number") present.add(item.id);
  }
  const missing: number[] = [];
  for (const id of drop) {
    if (!present.has(id)) missing.push(id);
  }
  if (missing.length > 0) {
    throw new Error(`Unknown purchase invoice line id: ${missing.join(", ")}`);
  }
  return currentItems.filter((item) => typeof item.id !== "number" || !drop.has(item.id));
}
