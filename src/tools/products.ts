import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type { Product } from "../types/product.js";
import {
  optionalNumber,
  optionalPage,
  optionalPositiveInt,
  optionalString,
  parseToolArgs,
  positiveInt,
} from "../validation/tool-args.js";

const productBodySchemaProps = {
  name: {
    type: "string" as const,
    description: "Product name (required on create)",
  },
  code: {
    type: "string" as const,
    description: "Product code, max 20 characters (required on create)",
  },
  foreign_names: {
    type: "object" as const,
    description: "Map of locale keys to translated names",
    additionalProperties: { type: "string" },
  },
  cl_sale_articles_id: {
    type: "number" as const,
    description: "Sales article ID",
  },
  sale_accounts_dimensions_id: {
    type: "number" as const,
    description: "Sales dimension ID",
  },
  cl_purchase_articles_id: {
    type: "number" as const,
    description: "Purchase article ID",
  },
  purchase_accounts_dimensions_id: {
    type: "number" as const,
    description: "Purchase dimension ID",
  },
  description: {
    type: "string" as const,
    description: "Note / description",
  },
  sales_price: {
    type: "number" as const,
    description: "Sales price",
  },
  net_price: {
    type: "number" as const,
    description: "Prime cost / net price",
  },
  price_currency: {
    type: "string" as const,
    description: "ISO 4217 currency code (3 letters), e.g. EUR",
  },
  notes: {
    type: "string" as const,
    description: "Other notes",
  },
  translations: {
    type: "object" as const,
    description: "Translation map",
    additionalProperties: { type: "string" },
  },
  activity_text: {
    type: "string" as const,
    description: "Field of activity as text",
  },
  emtak_code: {
    type: "string" as const,
    description: "EMTAK code",
  },
  emtak_version: {
    type: "string" as const,
    description: "EMTAK version",
  },
  unit: {
    type: "string" as const,
    description: "Unit of measure (e.g. tk)",
  },
  amount: {
    type: "number" as const,
    description: "Amount / sum",
  },
} satisfies Record<string, object>;

type ProductBodyKeys = keyof typeof productBodySchemaProps;

function pickProductBody(
  params: Record<string, unknown>,
  keys: readonly ProductBodyKeys[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    const v = params[key];
    if (v !== undefined) {
      body[key] = v;
    }
  }
  return body;
}

const allProductBodyKeys = Object.keys(productBodySchemaProps) as ProductBodyKeys[];

const productBodyFieldsSchema = z.object({
  foreign_names: z.record(z.string()).optional(),
  translations: z.record(z.string()).optional(),
  name: z.string().optional(),
  code: z.string().optional(),
  cl_sale_articles_id: optionalPositiveInt,
  sale_accounts_dimensions_id: optionalPositiveInt,
  cl_purchase_articles_id: optionalPositiveInt,
  purchase_accounts_dimensions_id: optionalPositiveInt,
  description: optionalString,
  sales_price: optionalNumber,
  net_price: optionalNumber,
  price_currency: optionalString,
  notes: optionalString,
  activity_text: optionalString,
  emtak_code: optionalString,
  emtak_version: optionalString,
  unit: optionalString,
  amount: optionalNumber,
});

const createProductSchema = productBodyFieldsSchema.extend({
  name: z.string().min(1),
  code: z.string().min(1),
});

const updateProductSchema = productBodyFieldsSchema.extend({
  products_id: positiveInt,
});

const listProductsSchema = z.object({
  page: optionalPage,
  modified_since: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
});

const productsIdSchema = z.object({ products_id: positiveInt });

export function createProductTools(client: EFinancialsClient) {
  return {
    list_products: {
      description:
        "List products/services for the company with optional pagination and modified_since filter.",
      inputSchema: {
        type: "object" as const,
        properties: {
          page: {
            type: "number",
            description: "Page number (1-based)",
          },
          modified_since: {
            type: "string",
            description: "ISO date-time: return only objects modified since this timestamp",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(listProductsSchema, params);
        const response = await client.get<Product>("/v1/products", {
          page: args.page,
          modified_since: args.modified_since,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  items: response.items || [],
                  current_page: response.current_page || 1,
                  total_pages: response.total_pages || 1,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    get_product: {
      description: "Get one product/service by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          products_id: {
            type: "number",
            description: "Product ID",
          },
        },
        required: ["products_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(productsIdSchema, params);
        const response = await client.get<Product>(`/v1/products/${args.products_id}`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    create_product: {
      description:
        "Create a product/service. API assigns sale_accounts_id and purchase_accounts_id (read-only in OpenAPI).",
      inputSchema: {
        type: "object" as const,
        properties: productBodySchemaProps,
        required: ["name", "code"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(createProductSchema, params) as Record<string, unknown>;
        const body = pickProductBody(parsed, allProductBodyKeys);
        const response = await client.post("/v1/products", body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    update_product: {
      description:
        "PATCH an existing product/service. Only include fields to change. Read-only: id, sale_accounts_id, purchase_accounts_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          products_id: {
            type: "number",
            description: "Product ID",
          },
          ...productBodySchemaProps,
        },
        required: ["products_id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updateProductSchema, params);
        const { products_id, ...rest } = parsed as Record<string, unknown> & {
          products_id: number;
        };
        const body = pickProductBody(rest, allProductBodyKeys);
        const response = await client.patch(`/v1/products/${products_id}`, body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    delete_product: {
      description: "Delete a product/service by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          products_id: {
            type: "number",
            description: "Product ID",
          },
        },
        required: ["products_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(productsIdSchema, params);
        const response = await client.delete(`/v1/products/${args.products_id}`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    deactivate_product: {
      description: "Deactivate a product/service.",
      inputSchema: {
        type: "object" as const,
        properties: {
          products_id: {
            type: "number",
            description: "Product ID",
          },
        },
        required: ["products_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(productsIdSchema, params);
        const response = await client.patch(`/v1/products/${args.products_id}/deactivate`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },

    reactivate_product: {
      description: "Reactivate a previously deactivated product/service.",
      inputSchema: {
        type: "object" as const,
        properties: {
          products_id: {
            type: "number",
            description: "Product ID",
          },
        },
        required: ["products_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(productsIdSchema, params);
        const response = await client.patch(`/v1/products/${args.products_id}/reactivate`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      },
    },
  };
}
