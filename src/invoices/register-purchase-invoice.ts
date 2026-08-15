import type { EFinancialsClient } from "../client.js";
import { roundMoney } from "../money.js";
import type { PurchaseInvoice } from "../types/invoice.js";
import { buildPurchaseInvoiceTotalsPatch } from "./purchase-invoice-patch.js";
import { isCompanyVatRegistered } from "./purchase-vat-defaults.js";

export interface RegisterPurchaseInvoiceInput {
  id: number;
  /** When true, skip totals repair if invoice already has gross (and vat when registered). */
  preserve_existing_totals?: boolean;
}

export interface RegisterPurchaseInvoiceResult {
  id: number;
  repaired: boolean;
  response: unknown;
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

/**
 * GET purchase invoice, optionally repair invoice-level vat/gross from item
 * sums, then PATCH .../register.
 */
export async function registerPurchaseInvoiceWithRepair(
  client: EFinancialsClient,
  input: RegisterPurchaseInvoiceInput,
): Promise<RegisterPurchaseInvoiceResult> {
  const invoice = (await client.get<PurchaseInvoice>(
    `/v1/purchase_invoices/${input.id}`,
  )) as unknown as PurchaseInvoice & {
    vat_price?: number | null;
    gross_price?: number | null;
    items?: ApiItem[];
  };

  const isVatRegistered = await isCompanyVatRegistered(client);
  const hasInvoiceGross = invoice.gross_price !== undefined && invoice.gross_price !== null;
  const hasInvoiceVat = invoice.vat_price !== undefined && invoice.vat_price !== null;

  if (
    input.preserve_existing_totals === true &&
    hasInvoiceGross &&
    (hasInvoiceVat || !isVatRegistered)
  ) {
    const response = await client.patch(`/v1/purchase_invoices/${input.id}/register`);
    return { id: input.id, repaired: false, response };
  }

  let repaired = false;
  const items = asItems(invoice);
  if (items.length > 0) {
    const itemVat = sumItemVat(items);
    const net = sumItemNet(items);
    const vat = isVatRegistered ? itemVat : 0;
    const gross = roundMoney(net + itemVat);
    const currentGross = invoice.gross_price;
    const currentVat = invoice.vat_price;
    const grossNeedsRepair =
      currentGross === undefined ||
      currentGross === null ||
      roundMoney(Number(currentGross)) !== roundMoney(gross);
    const vatNeedsRepair =
      isVatRegistered &&
      (currentVat === undefined ||
        currentVat === null ||
        roundMoney(Number(currentVat)) !== roundMoney(vat));

    if (grossNeedsRepair || vatNeedsRepair) {
      await client.patch(
        `/v1/purchase_invoices/${input.id}`,
        buildPurchaseInvoiceTotalsPatch({
          vat_price: vat,
          gross_price: gross,
          items,
        }),
      );
      repaired = true;
    }
  }

  const response = await client.patch(`/v1/purchase_invoices/${input.id}/register`);
  return { id: input.id, repaired, response };
}
