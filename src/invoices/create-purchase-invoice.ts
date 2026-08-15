import type { EFinancialsClient } from "../client.js";
import { formatVatRateDropdown, parseVatRateDropdown, roundMoney } from "../money.js";
import type { PurchaseArticle } from "../types/accounts.js";
import type { PurchaseInvoice } from "../types/invoice.js";
import {
  applyPurchaseVatDefaults,
  isCompanyVatRegistered,
  type PurchaseLineVatFields,
} from "./purchase-vat-defaults.js";

export interface PurchaseInvoiceLineInput {
  custom_title?: string;
  amount?: number;
  unit_net_price?: number;
  total_net_price?: number;
  cl_purchase_articles_id?: number;
  purchase_accounts_dimensions_id?: number;
  purchase_accounts_id?: number;
  vat_rate?: number;
  vat_rate_dropdown?: string;
  vat_accounts_id?: number;
  cl_vat_articles_id?: number;
  reversed_vat_id?: number;
  project_no_vat_gross_price?: number;
  base_net_price?: number;
  base_vat_price?: number;
  base_gross_price?: number;
}

export interface CreatePurchaseInvoiceInput {
  clients_id: number;
  client_name: string;
  invoice_no: string;
  invoice_date: string;
  term_days?: number;
  /** Gross total (incl. VAT). Required unless `items` supplies line nets. */
  total_amount?: number;
  vat_amount?: number;
  cl_currencies_id?: string;
  currency_rate?: number;
  description?: string;
  purchase_article_id?: number;
  purchase_accounts_dimensions_id?: number;
  vat_rate?: number;
  vat_accounts_id?: number;
  reversed_vat_id?: number;
  items?: PurchaseInvoiceLineInput[];
  /** When true, caller-supplied total_amount/vat_amount win over derived totals. */
  explicit_totals?: boolean;
  base_net_price?: number;
  base_vat_price?: number;
  base_gross_price?: number;
}

export interface CreatePurchaseInvoiceResult {
  id: number;
  response: PurchaseInvoice;
  repaired: boolean;
}

type ApiItem = Record<string, unknown>;

function asItems(response: unknown): ApiItem[] {
  const r = response as { items?: ApiItem[] };
  return Array.isArray(r.items) ? r.items : [];
}

function sumItemVat(items: ApiItem[]): number {
  return roundMoney(
    items.reduce((acc, item) => {
      const v = item.vat_amount ?? item.vat_price ?? 0;
      return acc + (typeof v === "number" ? v : 0);
    }, 0),
  );
}

function sumItemNet(items: ApiItem[]): number {
  return roundMoney(
    items.reduce((acc, item) => {
      const v = item.total_net_price ?? item.net_price ?? 0;
      return acc + (typeof v === "number" ? v : 0);
    }, 0),
  );
}

async function cleanupDraft(client: EFinancialsClient, id: number): Promise<boolean> {
  try {
    await client.patch(`/v1/purchase_invoices/${id}/invalidate`);
    return true;
  } catch {
    try {
      await client.delete(`/v1/purchase_invoices/${id}`);
      return true;
    } catch {
      return false;
    }
  }
}

function buildLinesFromFriendlyParams(
  input: CreatePurchaseInvoiceInput,
): PurchaseInvoiceLineInput[] {
  if (input.items && input.items.length > 0) {
    return input.items;
  }
  const gross = input.total_amount;
  if (gross == null) {
    throw new Error("total_amount is required when items are omitted");
  }
  const vat = input.vat_amount ?? 0;
  const net = roundMoney(gross - vat);
  return [
    {
      custom_title: input.description || "Purchase",
      amount: 1,
      unit_net_price: net,
      total_net_price: net,
      cl_purchase_articles_id: input.purchase_article_id ?? 39,
      purchase_accounts_dimensions_id: input.purchase_accounts_dimensions_id,
      vat_rate: input.vat_rate,
      vat_rate_dropdown: input.vat_rate != null ? formatVatRateDropdown(input.vat_rate) : undefined,
      vat_accounts_id: input.vat_accounts_id,
      reversed_vat_id: input.reversed_vat_id,
    },
  ];
}

/**
 * Create a purchase invoice draft, apply VAT defaults, then repair invoice-level
 * totals from API-computed line VAT (create-then-repair).
 */
export async function createPurchaseInvoiceWithRepair(
  client: EFinancialsClient,
  input: CreatePurchaseInvoiceInput,
): Promise<CreatePurchaseInvoiceResult> {
  const currency = input.cl_currencies_id ?? "EUR";
  if (currency !== "EUR" && (input.currency_rate == null || input.currency_rate <= 0)) {
    throw new Error("currency_rate is required when cl_currencies_id is not EUR");
  }

  const [isVatRegistered, articles] = await Promise.all([
    isCompanyVatRegistered(client),
    client.getAllPages<PurchaseArticle>("/v1/purchase_articles"),
  ]);

  const lineInputs = buildLinesFromFriendlyParams(input);
  const explicitTotals =
    input.explicit_totals === true ||
    (input.vat_amount != null && input.total_amount != null && !input.items?.length);

  /* v8 ignore start -- per-line optional coalescing for sparse RIK item shapes */
  const apiItems: ApiItem[] = lineInputs.map((line) => {
    const vatFields: PurchaseLineVatFields = {
      cl_purchase_articles_id: line.cl_purchase_articles_id,
      vat_rate_dropdown:
        line.vat_rate_dropdown ??
        (line.vat_rate != null ? formatVatRateDropdown(line.vat_rate) : undefined),
      vat_accounts_id: line.vat_accounts_id,
      cl_vat_articles_id: line.cl_vat_articles_id,
      purchase_accounts_id: line.purchase_accounts_id,
    };
    const defaults = applyPurchaseVatDefaults(articles, vatFields, isVatRegistered);
    const amount = line.amount ?? defaults.amount ?? 1;
    const unitNet = line.unit_net_price ?? line.total_net_price ?? 0;
    const totalNet = line.total_net_price ?? roundMoney(unitNet * amount);
    const rateStr = defaults.vat_rate_dropdown;
    const rateNum = parseVatRateDropdown(rateStr);

    const item: ApiItem = {
      custom_title: line.custom_title || input.description || "Purchase",
      amount,
      unit_net_price: unitNet,
      total_net_price: totalNet,
      cl_purchase_articles_id: line.cl_purchase_articles_id ?? 39,
      purchase_accounts_dimensions_id: line.purchase_accounts_dimensions_id,
      vat_rate_dropdown: rateStr,
      vat_accounts_id: defaults.vat_accounts_id ?? line.vat_accounts_id,
      cl_vat_articles_id: defaults.cl_vat_articles_id ?? (rateNum > 0 ? 1 : undefined),
      cl_fringe_benefits_id: defaults.cl_fringe_benefits_id,
      reversed_vat_id: line.reversed_vat_id ?? input.reversed_vat_id,
    };

    if (!isVatRegistered && rateStr !== "-") {
      item.project_no_vat_gross_price =
        line.project_no_vat_gross_price ?? roundMoney(totalNet + totalNet * (rateNum / 100));
    }

    if (currency !== "EUR") {
      const rate = input.currency_rate as number;
      item.base_net_price = line.base_net_price ?? roundMoney(totalNet * rate);
      item.base_vat_price = line.base_vat_price;
      item.base_gross_price = line.base_gross_price;
    }

    return item;
  });
  /* v8 ignore stop */

  const linesNet = roundMoney(apiItems.reduce((s, i) => s + Number(i.total_net_price || 0), 0));
  const initialGross = input.total_amount ?? linesNet;
  const initialVat = input.vat_amount ?? 0;

  const postBody: Record<string, unknown> = {
    clients_id: input.clients_id,
    client_name: input.client_name,
    number: input.invoice_no,
    create_date: input.invoice_date,
    journal_date: input.invoice_date,
    term_days: input.term_days ?? 0,
    gross_price: initialGross,
    vat_price: isVatRegistered ? initialVat : 0,
    cl_currencies_id: currency,
    notes: input.description,
    items: apiItems,
  };

  if (currency !== "EUR") {
    postBody.currency_rate = input.currency_rate;
    postBody.base_gross_price = input.base_gross_price;
    postBody.base_vat_price = input.base_vat_price;
    postBody.base_net_price = input.base_net_price;
  }

  let draftId: number | undefined;
  try {
    const created = await client.post<PurchaseInvoice>("/v1/purchase_invoices", postBody);
    draftId = created.id;
    if (draftId == null) {
      throw new Error("create_purchase_invoice: API did not return an id");
    }

    const fetched = (await client.get<PurchaseInvoice>(
      `/v1/purchase_invoices/${draftId}`,
    )) as unknown as PurchaseInvoice & { items?: ApiItem[] };
    const fetchedItems = asItems(fetched);
    const itemVat = sumItemVat(fetchedItems);
    const itemNet = sumItemNet(fetchedItems);

    let targetVat = itemVat;
    let targetGross = roundMoney(itemNet + itemVat);
    if (explicitTotals) {
      targetVat = input.vat_amount ?? itemVat;
      targetGross = input.total_amount ?? roundMoney(itemNet + targetVat);
    }
    if (!isVatRegistered) {
      targetVat = 0;
      targetGross = input.total_amount ?? itemNet;
    }

    // Rounding repair: nudge last line project_no_vat_gross_price when explicit VAT differs
    let itemsForPatch = fetchedItems;
    if (
      explicitTotals &&
      input.vat_amount != null &&
      Math.abs(input.vat_amount - itemVat) > 0.001 &&
      fetchedItems.length > 0
    ) {
      const last = fetchedItems[fetchedItems.length - 1];
      const delta = roundMoney(input.vat_amount - itemVat);
      const current = Number(last.project_no_vat_gross_price ?? 0);
      itemsForPatch = fetchedItems.map((item, idx) =>
        idx === fetchedItems.length - 1
          ? { ...item, project_no_vat_gross_price: roundMoney(current + delta) }
          : item,
      );
    }

    const fetchedTotals = fetched as { vat_price?: number | null; gross_price?: number | null };
    const currentGross = fetchedTotals.gross_price;
    const currentVat = fetchedTotals.vat_price;
    const grossNeedsRepair =
      currentGross === undefined ||
      currentGross === null ||
      roundMoney(Number(currentGross)) !== roundMoney(targetGross);
    const vatNeedsRepair =
      currentVat === undefined ||
      currentVat === null ||
      roundMoney(Number(currentVat)) !== roundMoney(targetVat);
    const itemsNudged = itemsForPatch !== fetchedItems;

    let repaired = false;
    if (grossNeedsRepair || vatNeedsRepair || itemsNudged) {
      // RIK PATCH requires items when the draft has lines; omitting them yields
      // "Products/services are missing!" and the create-then-repair cleanup deletes the draft.
      const patchBody: Record<string, unknown> = {
        vat_price: targetVat,
        gross_price: targetGross,
      };
      if (itemsForPatch.length > 0) {
        patchBody.items = itemsForPatch;
      }
      await client.patch(`/v1/purchase_invoices/${draftId}`, patchBody);
      repaired = true;
    }

    const finalInvoice = (await client.get<PurchaseInvoice>(
      `/v1/purchase_invoices/${draftId}`,
    )) as unknown as PurchaseInvoice;

    return {
      id: draftId,
      response: finalInvoice,
      repaired,
    };
  } catch (err) {
    if (draftId != null) {
      const cleaned = await cleanupDraft(client, draftId);
      const message = err instanceof Error ? err.message : String(err);
      if (!cleaned) {
        throw new Error(
          `create_purchase_invoice failed after creating draft id=${draftId} (cleanup also failed): ${message}`,
        );
      }
      throw new Error(`create_purchase_invoice failed (draft ${draftId} cleaned up): ${message}`);
    }
    throw err;
  }
}
