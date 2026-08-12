import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import { type AgingResult, computeAging } from "../financial-statements/aging.js";
import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import { optionalYmd, parseToolArgs } from "../validation/tool-args.js";

const agingSchema = z.object({
  as_of_date: optionalYmd,
});

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function todayUtcYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatAgingOutput(
  result: AgingResult,
  counterpartyKey: "top_debtors" | "top_creditors",
  unmatchedKey: "unmatched_client_invoices" | "unmatched_supplier_invoices",
) {
  const {
    as_of_date,
    total_unpaid_face_value,
    total_invoices,
    partially_paid_count,
    aging_buckets,
    top_counterparties,
    unmatched_invoices,
    warnings,
  } = result;

  const out: Record<string, unknown> = {
    as_of_date,
    total_unpaid_face_value,
    total_invoices,
    partially_paid_count,
    aging_buckets,
    [counterpartyKey]: top_counterparties,
    warnings,
  };
  if (unmatched_invoices != null) {
    out[unmatchedKey] = unmatched_invoices;
  }
  return out;
}

/**
 * Read-only receivables/payables aging from unpaid confirmed invoices.
 */
export function createAgingAnalysisTools(client: EFinancialsClient) {
  return {
    compute_receivables_aging: {
      description:
        "Compute receivables aging from unpaid confirmed sale invoices. Buckets by days past due (create_date + term_days): current / 1-30 / 31-60 / 61-90 / 90+. Optional as_of_date (default today UTC). Amounts use base_gross_price falling back to gross_price. PARTIALLY_PAID invoices are included at full face value (API has no remaining balance). Loads all sale invoice pages (page cap applies).",
      inputSchema: {
        type: "object" as const,
        properties: {
          as_of_date: {
            type: "string",
            description: "Cutoff date YYYY-MM-DD (default: today UTC)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(agingSchema, params);
        const asOf = args.as_of_date ?? todayUtcYmd();
        const invoices = await client.getAllPages<SalesInvoice>("/v1/sale_invoices");
        const result = computeAging(invoices, asOf);
        return jsonResult(formatAgingOutput(result, "top_debtors", "unmatched_client_invoices"));
      },
    },

    compute_payables_aging: {
      description:
        "Compute payables aging from unpaid confirmed purchase invoices. Buckets by days past due (create_date + term_days): current / 1-30 / 31-60 / 61-90 / 90+. Optional as_of_date (default today UTC). Amounts use base_gross_price falling back to gross_price. PARTIALLY_PAID invoices are included at full face value (API has no remaining balance). Loads all purchase invoice pages (page cap applies).",
      inputSchema: {
        type: "object" as const,
        properties: {
          as_of_date: {
            type: "string",
            description: "Cutoff date YYYY-MM-DD (default: today UTC)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(agingSchema, params);
        const asOf = args.as_of_date ?? todayUtcYmd();
        const invoices = await client.getAllPages<PurchaseInvoice>("/v1/purchase_invoices");
        const result = computeAging(invoices, asOf);
        return jsonResult(
          formatAgingOutput(result, "top_creditors", "unmatched_supplier_invoices"),
        );
      },
    },
  };
}
