import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type { Currency, InvoiceTemplate, SaleArticle } from "../types/reference.js";
import { parseToolArgs } from "../validation/tool-args.js";

const emptyToolArgs = z.object({});

function extractItems<T>(response: unknown): T[] {
  if (Array.isArray(response)) {
    return response as T[];
  }
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return obj.items as T[];
    }
  }
  return [];
}

export function createReferenceTools(client: EFinancialsClient) {
  return {
    list_currencies: {
      description:
        "List active currencies configured for the company (codes and Estonian/English names).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<Currency>("/v1/currencies");
        const items = extractItems<Currency>(response);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
        };
      },
    },

    list_sale_articles: {
      description:
        "List sale articles (revenue / sales categories linked to accounts and VAT) for the company.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<SaleArticle>("/v1/sale_articles");
        const items = extractItems<SaleArticle>(response);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
        };
      },
    },

    list_templates: {
      description: "List sale invoice templates available for the company.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<InvoiceTemplate>("/v1/templates");
        const items = extractItems<InvoiceTemplate>(response);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
        };
      },
    },
  };
}
