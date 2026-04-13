import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type { CompanyInvoiceInfo, InvoiceSeries } from "../types/invoiceSettings.js";
import {
  optionalNumber,
  optionalPositiveInt,
  optionalString,
  parseToolArgs,
  positiveInt,
} from "../validation/tool-args.js";

function extractSeriesList(response: unknown): InvoiceSeries[] {
  if (Array.isArray(response)) {
    return response as InvoiceSeries[];
  }
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return obj.items as InvoiceSeries[];
    }
  }
  return [];
}

const companyInvoiceInfoSchemaProps = {
  address: {
    type: "string" as const,
    description: "Invoice address (max 200 chars per API)",
  },
  email: {
    type: "string" as const,
    description: "Invoice email",
  },
  phone: {
    type: "string" as const,
    description: "Invoice phone",
  },
  fax: {
    type: "string" as const,
    description: "Invoice fax",
  },
  webpage: {
    type: "string" as const,
    description: "Invoice webpage",
  },
  cl_templates_id: {
    type: "number" as const,
    description: "Default sales invoice template ID",
  },
  invoice_company_name: {
    type: "string" as const,
    description: "Company name on invoice / e-invoice (max 100 chars)",
  },
  invoice_email_subject: {
    type: "string" as const,
    description: "Sale invoice email subject (template variables allowed)",
  },
  invoice_email_body: {
    type: "string" as const,
    description: "Sale invoice email body",
  },
  balance_email_subject: {
    type: "string" as const,
    description: "Balance confirmation email subject",
  },
  balance_email_body: {
    type: "string" as const,
    description: "Balance confirmation email body",
  },
  balance_document_footer: {
    type: "string" as const,
    description: "Balance confirmation document footer",
  },
} satisfies Record<string, object>;

type CompanyInvoiceInfoKeys = keyof typeof companyInvoiceInfoSchemaProps;

function pickCompanyInvoiceInfoBody(
  params: Record<string, unknown>,
  keys: readonly CompanyInvoiceInfoKeys[],
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

const allCompanyInvoiceInfoKeys = Object.keys(
  companyInvoiceInfoSchemaProps,
) as CompanyInvoiceInfoKeys[];

const invoiceSeriesBodySchemaProps = {
  is_active: {
    type: "boolean" as const,
    description: "Whether the series is active",
  },
  is_default: {
    type: "boolean" as const,
    description: "Whether this is the default invoice series",
  },
  number_prefix: {
    type: "string" as const,
    description: "Invoice number prefix (1–100 chars)",
  },
  number_start_value: {
    type: "number" as const,
    description: "First invoice number in the series",
  },
  term_days: {
    type: "number" as const,
    description: "Payment term in days (max 9999)",
  },
  overdue_charge: {
    type: "number" as const,
    description: "Delinquency charge per day (max 1000)",
  },
} satisfies Record<string, object>;

type InvoiceSeriesBodyKeys = keyof typeof invoiceSeriesBodySchemaProps;

function pickInvoiceSeriesBody(
  params: Record<string, unknown>,
  keys: readonly InvoiceSeriesBodyKeys[],
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

const allInvoiceSeriesBodyKeys = Object.keys(
  invoiceSeriesBodySchemaProps,
) as InvoiceSeriesBodyKeys[];

const emptyToolArgs = z.object({});

const companyInvoiceInfoSchema = z.object({
  address: optionalString,
  email: optionalString,
  phone: optionalString,
  fax: optionalString,
  webpage: optionalString,
  cl_templates_id: optionalPositiveInt,
  invoice_company_name: optionalString,
  invoice_email_subject: optionalString,
  invoice_email_body: optionalString,
  balance_email_subject: optionalString,
  balance_email_body: optionalString,
  balance_document_footer: optionalString,
});

const invoiceSeriesIdSchema = z.object({ invoice_series_id: positiveInt });

const createInvoiceSeriesSchema = z.object({
  is_active: z.boolean(),
  is_default: z.boolean(),
  number_prefix: z.string().min(1),
  number_start_value: z.coerce.number(),
  term_days: z.coerce.number(),
  overdue_charge: optionalNumber,
});

const updateInvoiceSeriesSchema = createInvoiceSeriesSchema.partial().extend({
  invoice_series_id: positiveInt,
});

export function createInvoiceSettingsTools(client: EFinancialsClient) {
  return {
    get_invoice_info: {
      description:
        "Get company invoice settings (address, templates, email templates for invoices and balance letters).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<CompanyInvoiceInfo>("/v1/invoice_info");
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

    update_invoice_info: {
      description:
        "PATCH company invoice settings. Only include fields to change (OpenAPI CompanyInvoiceInfo).",
      inputSchema: {
        type: "object" as const,
        properties: companyInvoiceInfoSchemaProps,
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(companyInvoiceInfoSchema, params) as Record<string, unknown>;
        const body = pickCompanyInvoiceInfoBody(parsed, allCompanyInvoiceInfoKeys);
        const response = await client.patch("/v1/invoice_info", body);
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

    list_invoice_series: {
      description: "List all invoice series for the company (number prefix, terms, default flag).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<InvoiceSeries>("/v1/invoice_series");
        const items = extractSeriesList(response);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(items, null, 2),
            },
          ],
        };
      },
    },

    get_invoice_series: {
      description: "Get one invoice series by ID (OpenAPI InvoiceSeries).",
      inputSchema: {
        type: "object" as const,
        properties: {
          invoice_series_id: {
            type: "number",
            description: "Invoice series ID",
          },
        },
        required: ["invoice_series_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceSeriesIdSchema, params);
        const response = await client.get<InvoiceSeries>(
          `/v1/invoice_series/${args.invoice_series_id}`,
        );
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

    create_invoice_series: {
      description:
        "Create an invoice series. Required: is_active, is_default, number_prefix, number_start_value, term_days. API assigns id (read-only).",
      inputSchema: {
        type: "object" as const,
        properties: invoiceSeriesBodySchemaProps,
        required: ["is_active", "is_default", "number_prefix", "number_start_value", "term_days"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(createInvoiceSeriesSchema, params) as Record<string, unknown>;
        const body = pickInvoiceSeriesBody(parsed, allInvoiceSeriesBodyKeys);
        const response = await client.post("/v1/invoice_series", body);
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

    update_invoice_series: {
      description: "PATCH an invoice series. Only include fields to change. Read-only: id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          invoice_series_id: {
            type: "number",
            description: "Invoice series ID",
          },
          ...invoiceSeriesBodySchemaProps,
        },
        required: ["invoice_series_id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updateInvoiceSeriesSchema, params);
        const { invoice_series_id, ...rest } = parsed as Record<string, unknown> & {
          invoice_series_id: number;
        };
        const body = pickInvoiceSeriesBody(rest, allInvoiceSeriesBodyKeys);
        const response = await client.patch(`/v1/invoice_series/${invoice_series_id}`, body);
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

    delete_invoice_series: {
      description: "Delete an invoice series by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          invoice_series_id: {
            type: "number",
            description: "Invoice series ID",
          },
        },
        required: ["invoice_series_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceSeriesIdSchema, params);
        const response = await client.delete(`/v1/invoice_series/${args.invoice_series_id}`);
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
