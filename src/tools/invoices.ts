import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type {
  CreatePurchaseInvoiceParams,
  CreateSalesInvoiceParams,
  PurchaseInvoice,
  SalesInvoice,
} from "../types/invoice.js";
import type { ApiFile } from "../types/journal.js";
import { resolveUploadFilePath } from "../upload-file-path.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalPage,
  optionalPositiveInt,
  optionalString,
  optionalYmd,
  parseToolArgs,
  positiveInt,
  ymdDateString,
} from "../validation/tool-args.js";

const saleInvoiceStatusEnum = z.enum(["PROJECT", "CONFIRMED"]);
const paymentStatusEnum = z.enum(["NOT_PAID", "PARTIALLY_PAID", "PAID"]);

const listSalesInvoicesSchema = z.object({
  status: saleInvoiceStatusEnum.optional(),
  payment_status: paymentStatusEnum.optional(),
  clients_id: optionalPositiveInt,
  start_date: optionalYmd,
  end_date: optionalYmd,
  page: optionalPage,
});

const listPurchaseInvoicesSchema = z.object({
  status: saleInvoiceStatusEnum.optional(),
  payment_status: paymentStatusEnum.optional(),
  clients_id: optionalPositiveInt,
  start_date: optionalYmd,
  end_date: optionalYmd,
  modified_since: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  page: optionalPage,
});

const listUnpaidInvoicesSchema = z.object({
  type: z.enum(["sales", "purchase", "both"]).optional(),
});

const invoiceIdSchema = z.object({ id: positiveInt });

const invoiceRowSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number(),
  unit_price: z.coerce.number(),
  products_id: optionalPositiveInt,
  vat_rate_id: optionalPositiveInt,
  accounts_id: optionalPositiveInt,
});

const createSalesInvoiceSchema = z.object({
  clients_id: positiveInt,
  invoice_date: ymdDateString,
  due_date: ymdDateString,
  rows: z.array(invoiceRowSchema),
  cl_currencies_id: optionalString,
  description: optionalString,
  sale_invoice_type: optionalString,
  cl_templates_id: optionalPositiveInt,
  cl_countries_id: optionalString,
  show_client_balance: optionalBoolean,
  number_suffix: optionalString,
});

const createPurchaseInvoiceSchema = z.object({
  clients_id: positiveInt,
  client_name: z.string().min(1),
  invoice_no: z.string().min(1),
  invoice_date: ymdDateString,
  term_days: optionalPositiveInt,
  total_amount: z.coerce.number(),
  vat_amount: optionalNumber,
  cl_currencies_id: optionalString,
  description: optionalString,
  purchase_article_id: optionalPositiveInt,
  purchase_accounts_dimensions_id: optionalPositiveInt,
  vat_rate: optionalNumber,
  vat_accounts_id: optionalPositiveInt,
});

const updateSalesInvoiceSchema = z.object({
  id: positiveInt,
  clients_id: optionalPositiveInt,
  invoice_date: optionalYmd,
  due_date: optionalYmd,
  rows: z.array(z.unknown()).optional(),
  description: optionalString,
  cl_currencies_id: optionalString,
});

const updatePurchaseInvoiceSchema = z.object({
  id: positiveInt,
  clients_id: optionalPositiveInt,
  client_name: optionalString,
  invoice_no: optionalString,
  invoice_date: optionalYmd,
  term_days: optionalPositiveInt,
  total_amount: optionalNumber,
  vat_amount: optionalNumber,
  description: optionalString,
});

const deliverSalesInvoiceSchema = z.object({
  id: positiveInt,
  send_einvoice: optionalBoolean,
  send_email: optionalBoolean,
  email_addresses: optionalString,
  email_subject: optionalString,
  email_body: optionalString,
});

const uploadSalesInvoiceUserFileSchema = z.object({
  id: positiveInt,
  file_path: z.string().min(1),
});

const uploadPurchaseInvoiceFileSchema = z.object({
  invoice_id: positiveInt,
  file_path: z.string().min(1),
});

export function createInvoiceTools(client: EFinancialsClient) {
  return {
    list_sales_invoices: {
      description: "List sales invoices (invoices you send to customers) with optional filters.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: ["PROJECT", "CONFIRMED"],
            description: "Filter by status",
          },
          payment_status: {
            type: "string",
            enum: ["NOT_PAID", "PARTIALLY_PAID", "PAID"],
            description: "Filter by payment status",
          },
          clients_id: {
            type: "number",
            description: "Filter by client ID",
          },
          start_date: {
            type: "string",
            description: "Filter invoices from this date (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "Filter invoices up to this date (YYYY-MM-DD)",
          },
          page: {
            type: "number",
            description: "Page number for pagination (default: 1)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(listSalesInvoicesSchema, params);
        const response = await client.get<SalesInvoice>("/v1/sale_invoices", {
          status: args.status,
          payment_status: args.payment_status,
          clients_id: args.clients_id,
          start_date: args.start_date,
          end_date: args.end_date,
          page: args.page,
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

    list_purchase_invoices: {
      description:
        "List purchase invoices (invoices from suppliers you need to pay) with optional filters.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: ["PROJECT", "CONFIRMED"],
            description: "Filter by status",
          },
          payment_status: {
            type: "string",
            enum: ["NOT_PAID", "PARTIALLY_PAID", "PAID"],
            description: "Filter by payment status",
          },
          clients_id: {
            type: "number",
            description: "Filter by supplier ID",
          },
          start_date: {
            type: "string",
            description: "Filter invoices from this date (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "Filter invoices up to this date (YYYY-MM-DD)",
          },
          modified_since: {
            type: "string",
            description: "Filter by modification date (ISO format)",
          },
          page: {
            type: "number",
            description: "Page number for pagination (default: 1)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(listPurchaseInvoicesSchema, params);
        const response = await client.get<PurchaseInvoice>("/v1/purchase_invoices", {
          status: args.status,
          payment_status: args.payment_status,
          clients_id: args.clients_id,
          start_date: args.start_date,
          end_date: args.end_date,
          modified_since: args.modified_since,
          page: args.page,
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

    list_unpaid_invoices: {
      description:
        "List all unpaid invoices (both sales and purchase). Useful for checking outstanding payments.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: ["sales", "purchase", "both"],
            description: "Which type of invoices to show. Default: both",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(listUnpaidInvoicesSchema, params);
        const invoiceType = args.type || "both";
        const result: {
          sales_invoices?: SalesInvoice[];
          purchase_invoices?: PurchaseInvoice[];
        } = {};

        if (invoiceType === "sales" || invoiceType === "both") {
          const salesResponse = await client.get<SalesInvoice>("/v1/sale_invoices", {
            payment_status: "NOT_PAID",
          });
          result.sales_invoices = salesResponse.items || [];
        }

        if (invoiceType === "purchase" || invoiceType === "both") {
          const purchaseResponse = await client.get<PurchaseInvoice>("/v1/purchase_invoices", {
            payment_status: "NOT_PAID",
          });
          result.purchase_invoices = purchaseResponse.items || [];
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    },

    get_sales_invoice: {
      description: "Get details of a specific sales invoice by ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.get<SalesInvoice>(`/v1/sale_invoices/${args.id}`);
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

    get_purchase_invoice: {
      description: "Get details of a specific purchase invoice by ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Purchase invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.get<PurchaseInvoice>(`/v1/purchase_invoices/${args.id}`);
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

    create_sales_invoice: {
      description:
        "Create a new sales invoice draft. The invoice will be created with PROJECT status (not registered). Fetches the default invoice series and template from the API automatically.",
      inputSchema: {
        type: "object" as const,
        properties: {
          clients_id: {
            type: "number",
            description: "Client ID (the customer)",
          },
          invoice_date: {
            type: "string",
            description: "Invoice date (YYYY-MM-DD)",
          },
          due_date: {
            type: "string",
            description: "Payment due date (YYYY-MM-DD)",
          },
          rows: {
            type: "array",
            description: "Invoice line items",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                quantity: { type: "number" },
                unit_price: { type: "number" },
                products_id: {
                  type: "number",
                  description:
                    "Product/service ID (auto-detected from first available product if omitted)",
                },
                vat_rate_id: { type: "number" },
                accounts_id: { type: "number" },
              },
              required: ["description", "quantity", "unit_price"],
            },
          },
          cl_currencies_id: {
            type: "string",
            description: "Currency code (default: EUR)",
          },
          description: {
            type: "string",
            description: "Invoice description/notes",
          },
          sale_invoice_type: {
            type: "string",
            description: "Invoice type (default: INVOICE)",
          },
          cl_templates_id: {
            type: "number",
            description: "Template ID (auto-detected from first available template if omitted)",
          },
          cl_countries_id: {
            type: "string",
            description: "Country code for place of supply (default: EST)",
          },
          show_client_balance: {
            type: "boolean",
            description: "Show client balance on invoice (default: false)",
          },
          number_suffix: {
            type: "string",
            description:
              "Invoice number (auto-generated from the default series start value if omitted)",
          },
        },
        required: ["clients_id", "invoice_date", "due_date", "rows"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(createSalesInvoiceSchema, params) as CreateSalesInvoiceParams;

        const needsProductLookup = args.rows.some((r) => !r.products_id);

        const [seriesResponse, templatesResponse, productsResponse] = await Promise.all([
          client.get("/v1/invoice_series"),
          client.get("/v1/templates"),
          needsProductLookup ? client.get("/v1/products") : Promise.resolve({ items: [] }),
        ]);

        const seriesList = (seriesResponse.items ?? []) as Array<Record<string, unknown>>;
        const defaultSeries = seriesList.find((s) => s.is_default === true) ?? seriesList[0] ?? {};

        const templatesList = (templatesResponse.items ?? []) as Array<Record<string, unknown>>;
        const defaultTemplate = templatesList[0] ?? {};

        const productsList = (productsResponse.items ?? []) as Array<Record<string, unknown>>;
        const defaultProductId = (productsList[0]?.id as number) ?? 1;

        const invoiceDate = new Date(args.invoice_date);
        const dueDate = new Date(args.due_date);
        const termDays = Math.max(
          0,
          Math.round((dueDate.getTime() - invoiceDate.getTime()) / 86_400_000),
        );

        const numberSuffix =
          args.number_suffix ?? String(defaultSeries.number_start_value ?? Date.now());

        const apiPayload = {
          sale_invoice_type: args.sale_invoice_type ?? "INVOICE",
          cl_templates_id: args.cl_templates_id ?? defaultTemplate.id ?? 1,
          clients_id: args.clients_id,
          cl_countries_id: args.cl_countries_id ?? "EST",
          number_suffix: numberSuffix,
          create_date: args.invoice_date,
          journal_date: args.invoice_date,
          term_days: termDays,
          cl_currencies_id: args.cl_currencies_id ?? "EUR",
          show_client_balance: args.show_client_balance ?? false,
          notes: args.description,
          items: args.rows.map((row) => ({
            custom_title: row.description,
            products_id: row.products_id ?? defaultProductId,
            amount: row.quantity,
            unit_net_price: row.unit_price,
            total_net_price: row.quantity * row.unit_price,
            vat_accounts_id: row.vat_rate_id,
            sale_accounts_dimensions_id: row.accounts_id,
          })),
        };

        const response = await client.post<SalesInvoice>("/v1/sale_invoices", apiPayload);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: "Sales invoice draft created",
                  id: response.id,
                  response,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    create_purchase_invoice: {
      description:
        "Create a new purchase invoice draft. The invoice will be created with PROJECT status (not registered). Creates a single line item from the total amount.",
      inputSchema: {
        type: "object" as const,
        properties: {
          clients_id: {
            type: "number",
            description: "Supplier ID",
          },
          client_name: {
            type: "string",
            description: "Supplier name (must match the client record)",
          },
          invoice_no: {
            type: "string",
            description: "Supplier's invoice number",
          },
          invoice_date: {
            type: "string",
            description: "Invoice date (YYYY-MM-DD)",
          },
          term_days: {
            type: "number",
            description: "Payment term in days (default: 0 for immediate)",
          },
          total_amount: {
            type: "number",
            description: "Total invoice amount (including VAT)",
          },
          vat_amount: {
            type: "number",
            description: "VAT amount (default: 0)",
          },
          cl_currencies_id: {
            type: "string",
            description: "Currency code (default: EUR)",
          },
          description: {
            type: "string",
            description: "Invoice description/notes (also used as line item title)",
          },
          purchase_article_id: {
            type: "number",
            description:
              "Purchase article ID for expense categorization (default: 39 = Office supplies). Use 23 for SaaS/services (account 4130).",
          },
          purchase_accounts_dimensions_id: {
            type: "number",
            description:
              "Account dimension ID. Required when purchase_article_id maps to an account with dimensions. For article 23 (account 4130), use dimension 6488057.",
          },
          vat_rate: {
            type: "number",
            description: "VAT rate percentage (default: 0)",
          },
          vat_accounts_id: {
            type: "number",
            description:
              "VAT account ID. Required when vat_rate > 0. Use get_vat_info or list_sale_articles to find available VAT accounts.",
          },
        },
        required: ["clients_id", "client_name", "invoice_no", "invoice_date", "total_amount"],
      },
      handler: async (params: unknown) => {
        const paramsParsed = parseToolArgs(
          createPurchaseInvoiceSchema,
          params,
        ) as CreatePurchaseInvoiceParams;
        // Calculate net price from gross and VAT
        const grossPrice = paramsParsed.total_amount;
        const vatPrice = paramsParsed.vat_amount ?? 0;
        const netPrice = grossPrice - vatPrice;

        // Map friendly param names to API field names
        const apiPayload = {
          clients_id: paramsParsed.clients_id,
          client_name: paramsParsed.client_name,
          number: paramsParsed.invoice_no,
          create_date: paramsParsed.invoice_date,
          journal_date: paramsParsed.invoice_date,
          term_days: paramsParsed.term_days ?? 0,
          gross_price: grossPrice,
          vat_price: vatPrice,
          cl_currencies_id: paramsParsed.cl_currencies_id ?? "EUR",
          notes: paramsParsed.description,
          items: [
            {
              custom_title: paramsParsed.description || "Purchase",
              amount: 1,
              unit_net_price: netPrice,
              total_net_price: netPrice,
              cl_purchase_articles_id: paramsParsed.purchase_article_id ?? 39,
              purchase_accounts_dimensions_id: paramsParsed.purchase_accounts_dimensions_id,
              vat_rate_dropdown: String(paramsParsed.vat_rate ?? 0),
              vat_accounts_id: paramsParsed.vat_accounts_id,
              cl_vat_articles_id: paramsParsed.vat_rate ? 1 : undefined,
              cl_fringe_benefits_id: 1,
            },
          ],
        };
        const response = await client.post<PurchaseInvoice>("/v1/purchase_invoices", apiPayload);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: "Purchase invoice draft created",
                  id: response.id,
                  response,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    update_sales_invoice: {
      description: "Update a sales invoice draft. Only works on PROJECT status invoices.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Invoice ID to update",
          },
          clients_id: { type: "number" },
          invoice_date: { type: "string" },
          due_date: { type: "string" },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                quantity: { type: "number" },
                unit_price: { type: "number" },
              },
            },
          },
          description: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updateSalesInvoiceSchema, params);
        const { id, ...updateParams } = parsed as {
          id: number;
        } & Partial<CreateSalesInvoiceParams>;

        // Fetch current invoice to get required fields (API requires all fields in PATCH)
        const currentResponse = await client.get(`/v1/sale_invoices/${id}`);
        const current = currentResponse as unknown as Record<string, unknown>;

        // Build payload with existing values as defaults, override with provided updates
        const apiPayload = {
          sale_invoice_type: current.sale_invoice_type,
          cl_templates_id: current.cl_templates_id,
          clients_id: updateParams.clients_id ?? current.clients_id,
          cl_countries_id: current.cl_countries_id,
          number_suffix: current.number_suffix,
          create_date: updateParams.invoice_date ?? current.create_date,
          journal_date: updateParams.invoice_date ?? current.journal_date,
          term_days: current.term_days,
          cl_currencies_id: updateParams.cl_currencies_id ?? current.cl_currencies_id,
          show_client_balance: current.show_client_balance,
          notes: updateParams.description ?? current.notes,
          items: updateParams.rows ?? current.items,
        };

        const response = await client.patch<SalesInvoice>(`/v1/sale_invoices/${id}`, apiPayload);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Sales invoice ${id} updated`,
                  response,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    delete_sales_invoice: {
      description:
        "Delete a sales invoice. Typically allowed only for draft invoices (status PROJECT); registered invoices (CONFIRMED) may be rejected by the API. Use invalidate_sales_invoice for posted invoices when the API allows. See RIK e-Financials API documentation for state rules.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.delete(`/v1/sale_invoices/${args.id}`);
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

    register_sales_invoice: {
      description:
        "Register (post to the books) a sales invoice. Usually applies to draft invoices (PROJECT) that are ready to be confirmed (CONFIRMED). The API accepts an empty PATCH body. CONFIRMED/VOID transitions follow RIK rules — see e-Financials API documentation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.patch(`/v1/sale_invoices/${args.id}/register`);
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

    invalidate_sales_invoice: {
      description:
        "Invalidate a registered sales invoice (reverse registration per API rules). Typically applies to posted invoices (CONFIRMED); draft invoices (PROJECT) should use delete_sales_invoice instead. See RIK e-Financials API documentation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.patch(`/v1/sale_invoices/${args.id}/invalidate`);
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

    get_sales_invoice_xml: {
      description:
        "Get the system-generated e-invoice XML for a sales invoice (OpenAPI ApiFile: name + base64 contents).",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.get<ApiFile>(`/v1/sale_invoices/${args.id}/xml`);
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

    get_sales_invoice_pdf_system: {
      description:
        "Get the system-generated PDF for a sales invoice (OpenAPI ApiFile: name + base64 contents).",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.get<ApiFile>(`/v1/sale_invoices/${args.id}/pdf_system`);
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

    get_sales_invoice_user_file: {
      description:
        "Get the user-uploaded file attached to a sales invoice (OpenAPI ApiFile: name + base64 contents).",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.get<ApiFile>(`/v1/sale_invoices/${args.id}/document_user`);
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

    upload_sales_invoice_user_file: {
      description:
        "Upload a file to a sales invoice (PUT .../document_user). File is read from disk, base64-encoded, sent as OpenAPI ApiFile.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
          file_path: {
            type: "string",
            description:
              "Local path to the file to upload. If MCP_FILE_UPLOAD_ROOT is set, use a path relative to that directory (absolute paths are rejected). Otherwise any readable path is allowed.",
          },
        },
        required: ["id", "file_path"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(uploadSalesInvoiceUserFileSchema, params);
        const resolvedPath = await resolveUploadFilePath(args.file_path);
        const fileBuffer = await readFile(resolvedPath);
        const base64Content = fileBuffer.toString("base64");
        const filename = basename(resolvedPath);

        const response = await client.put(`/v1/sale_invoices/${args.id}/document_user`, {
          name: filename,
          contents: base64Content,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `File "${filename}" uploaded to sales invoice ${args.id}`,
                  response,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    delete_sales_invoice_user_file: {
      description: "Delete the user-uploaded file from a sales invoice.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.delete(`/v1/sale_invoices/${args.id}/document_user`);
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

    get_sales_invoice_delivery_options: {
      description:
        "Get delivery options for a sales invoice (e-invoice vs email, suggested addresses, reasons).",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.get(`/v1/sale_invoices/${args.id}/delivery_options`);
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

    deliver_sales_invoice: {
      description:
        "Send a sales invoice to the customer (PATCH .../deliver): e-invoice and/or email with optional subject and body.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Sales invoice ID",
          },
          send_einvoice: {
            type: "boolean",
            description: "Send machine-readable e-invoice to the customer",
          },
          send_email: {
            type: "boolean",
            description: "Send invoice by email (PDF)",
          },
          email_addresses: {
            type: "string",
            description: "Recipient email addresses",
          },
          email_subject: {
            type: "string",
            description: "Optional email subject",
          },
          email_body: {
            type: "string",
            description: "Optional email body",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(deliverSalesInvoiceSchema, params);
        const { id, ...rest } = parsed;
        const body: Record<string, unknown> = {};
        if (rest.send_einvoice !== undefined) body.send_einvoice = rest.send_einvoice;
        if (rest.send_email !== undefined) body.send_email = rest.send_email;
        if (rest.email_addresses !== undefined) body.email_addresses = rest.email_addresses;
        if (rest.email_subject !== undefined) body.email_subject = rest.email_subject;
        if (rest.email_body !== undefined) body.email_body = rest.email_body;

        const response = await client.patch(`/v1/sale_invoices/${id}/deliver`, body);
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

    update_purchase_invoice: {
      description: "Update a purchase invoice draft. Only works on PROJECT status invoices.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Invoice ID to update",
          },
          clients_id: { type: "number" },
          client_name: { type: "string" },
          invoice_no: { type: "string" },
          invoice_date: { type: "string" },
          term_days: { type: "number" },
          total_amount: { type: "number" },
          vat_amount: { type: "number" },
          description: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updatePurchaseInvoiceSchema, params);
        const { id, ...updateParams } = parsed as {
          id: number;
        } & Partial<CreatePurchaseInvoiceParams>;

        // Fetch current invoice to get required fields (API requires all fields in PATCH)
        const currentResponse = await client.get(`/v1/purchase_invoices/${id}`);
        const current = currentResponse as unknown as Record<string, unknown>;

        // Build payload with existing values as defaults, override with provided updates
        const apiPayload = {
          clients_id: updateParams.clients_id ?? current.clients_id,
          client_name: updateParams.client_name ?? current.client_name,
          number: updateParams.invoice_no ?? current.number,
          create_date: updateParams.invoice_date ?? current.create_date,
          journal_date: updateParams.invoice_date ?? current.journal_date,
          term_days: updateParams.term_days ?? current.term_days ?? 0,
          cl_currencies_id: current.cl_currencies_id,
          gross_price: updateParams.total_amount ?? current.gross_price,
          vat_price: updateParams.vat_amount ?? current.vat_price ?? 0,
          notes: updateParams.description ?? current.notes,
          items: current.items,
        };

        const response = await client.patch<PurchaseInvoice>(
          `/v1/purchase_invoices/${id}`,
          apiPayload,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Purchase invoice ${id} updated`,
                  response,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    delete_purchase_invoice: {
      description:
        "Delete a purchase invoice. Typically allowed only for draft invoices (status PROJECT); registered invoices (CONFIRMED) may be rejected by the API. Use invalidate_purchase_invoice for posted invoices when the API allows. See RIK e-Financials API documentation for state rules.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Purchase invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.delete(`/v1/purchase_invoices/${args.id}`);
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

    register_purchase_invoice: {
      description:
        "Register (post to the books) a purchase invoice. Usually applies to draft invoices (PROJECT) that are ready to be confirmed (CONFIRMED). The API accepts an empty PATCH body. CONFIRMED/VOID transitions follow RIK rules — see e-Financials API documentation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Purchase invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.patch(`/v1/purchase_invoices/${args.id}/register`);
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

    invalidate_purchase_invoice: {
      description:
        "Invalidate a registered purchase invoice (reverse registration per API rules). Typically applies to posted invoices (CONFIRMED); draft invoices (PROJECT) should use delete_purchase_invoice instead. See RIK e-Financials API documentation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Purchase invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.patch(`/v1/purchase_invoices/${args.id}/invalidate`);
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

    get_purchase_invoice_user_file: {
      description:
        "Get the user-uploaded file attached to a purchase invoice (OpenAPI ApiFile: name + base64 contents).",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Purchase invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.get<ApiFile>(
          `/v1/purchase_invoices/${args.id}/document_user`,
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

    delete_purchase_invoice_user_file: {
      description: "Delete the user-uploaded file from a purchase invoice.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Purchase invoice ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(invoiceIdSchema, params);
        const response = await client.delete(`/v1/purchase_invoices/${args.id}/document_user`);
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

    upload_purchase_invoice_file: {
      description:
        "Upload a PDF or other file attachment to a purchase invoice. The file will be base64-encoded and sent to the API.",
      inputSchema: {
        type: "object" as const,
        properties: {
          invoice_id: {
            type: "number",
            description: "Purchase invoice ID to attach the file to",
          },
          file_path: {
            type: "string",
            description:
              "Local path to the file to upload. If MCP_FILE_UPLOAD_ROOT is set, use a path relative to that directory (absolute paths are rejected). Otherwise any readable path is allowed.",
          },
        },
        required: ["invoice_id", "file_path"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(uploadPurchaseInvoiceFileSchema, params);
        // Read file and encode as base64
        const resolvedPath = await resolveUploadFilePath(args.file_path);
        const fileBuffer = await readFile(resolvedPath);
        const base64Content = fileBuffer.toString("base64");
        const filename = basename(resolvedPath);

        // Determine MIME type from extension
        const ext = filename.split(".").pop()?.toLowerCase();
        const mimeTypes: Record<string, string> = {
          pdf: "application/pdf",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          xml: "application/xml",
          txt: "text/plain",
        };
        const _mimeType = mimeTypes[ext || ""] || "application/octet-stream";

        const response = await client.put(
          `/v1/purchase_invoices/${args.invoice_id}/document_user`,
          {
            name: filename,
            contents: base64Content,
          },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `File "${filename}" uploaded to purchase invoice ${args.invoice_id}`,
                  response,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },
  };
}
