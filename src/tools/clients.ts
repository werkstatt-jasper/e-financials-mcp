import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type { Client, CreateClientAPIParams, CreateClientParams } from "../types/clients.js";
import {
  optionalBoolean,
  optionalPage,
  optionalPositiveInt,
  optionalString,
  parseToolArgs,
  positiveInt,
} from "../validation/tool-args.js";

// Map 2-letter ISO codes to 3-letter codes (API requires 3-letter)
const countryCodeMap: Record<string, string> = {
  EE: "EST",
  ESTonia: "EST",
  FI: "FIN",
  FInland: "FIN",
  DE: "DEU",
  DEU: "DEU",
  NL: "NLD",
  NLD: "NLD",
  GB: "GBR",
  UK: "GBR",
  GBR: "GBR",
  US: "USA",
  USA: "USA",
  SE: "SWE",
  SWE: "SWE",
  LV: "LVA",
  LVA: "LVA",
  LT: "LTU",
  LTU: "LTU",
  FR: "FRA",
  FRA: "FRA",
  IT: "ITA",
  ITA: "ITA",
  ES: "ESP",
  ESP: "ESP",
  PL: "POL",
  POL: "POL",
  AT: "AUT",
  AUT: "AUT",
  BE: "BEL",
  BEL: "BEL",
  CH: "CHE",
  CHE: "CHE",
  DK: "DNK",
  DNK: "DNK",
  NO: "NOR",
  NOR: "NOR",
  AU: "AUS",
  AUS: "AUS",
  IE: "IRL",
  IRL: "IRL",
  PT: "PRT",
  PRT: "PRT",
};

function normalizeCountryCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  return countryCodeMap[upper] || upper; // Return as-is if not found (might already be 3-letter)
}

const clientWritableInputProperties = {
  name: {
    type: "string" as const,
    description: "Client/company name",
  },
  reg_code: {
    type: "string" as const,
    description: "Registration/company code",
  },
  vat_no: {
    type: "string" as const,
    description: "VAT number",
  },
  email: {
    type: "string" as const,
    description: "Email address",
  },
  phone: {
    type: "string" as const,
    description: "Phone number",
  },
  address: {
    type: "string" as const,
    description: "Street address",
  },
  city: {
    type: "string" as const,
    description: "City",
  },
  postal_code: {
    type: "string" as const,
    description: "Postal/ZIP code",
  },
  country_code: {
    type: "string" as const,
    description: "Country code (e.g., EE, FI, DE)",
  },
  is_buyer: {
    type: "boolean" as const,
    description: "Is this a buyer/customer?",
  },
  is_supplier: {
    type: "boolean" as const,
    description: "Is this a supplier/vendor?",
  },
  bank_account: {
    type: "string" as const,
    description: "Bank account number (IBAN)",
  },
  bank_name: {
    type: "string" as const,
    description: "Bank name",
  },
  payment_term_days: {
    type: "number" as const,
    description: "Payment term in days",
  },
} satisfies Record<string, object>;

type UpdateClientParams = { id: number } & Partial<CreateClientParams>;

const emptyToolArgs = z.object({});

const listClientsSchema = z.object({
  is_supplier: optionalBoolean,
  is_buyer: optionalBoolean,
  modified_since: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  page: optionalPage,
});

const clientIdSchema = z.object({ id: positiveInt });

const searchClientsSchema = z.object({
  query: z.string().min(1),
  is_supplier: optionalBoolean,
});

const createClientSchema = z.object({
  name: z.string().min(1),
  reg_code: optionalString,
  vat_no: optionalString,
  email: optionalString,
  phone: optionalString,
  address: optionalString,
  city: optionalString,
  postal_code: optionalString,
  country_code: optionalString,
  is_buyer: optionalBoolean,
  is_supplier: optionalBoolean,
  bank_account: optionalString,
  bank_name: optionalString,
  payment_term_days: optionalPositiveInt,
});

const updateClientSchema = z.object({
  id: positiveInt,
  name: optionalString,
  reg_code: optionalString,
  vat_no: optionalString,
  email: optionalString,
  phone: optionalString,
  address: optionalString,
  city: optionalString,
  postal_code: optionalString,
  country_code: optionalString,
  is_buyer: optionalBoolean,
  is_supplier: optionalBoolean,
  bank_account: optionalString,
  bank_name: optionalString,
  payment_term_days: optionalPositiveInt,
});

/** Maps user-facing partial params to RIK `Clients` JSON for PATCH (only defined keys). */
function buildPartialClientPatchBody(params: UpdateClientParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (params.name !== undefined) {
    body.name = params.name;
  }
  if (params.reg_code !== undefined) {
    body.code = params.reg_code;
  }
  if (params.vat_no !== undefined) {
    body.invoice_vat_no = params.vat_no;
  }
  if (params.email !== undefined) {
    body.email = params.email;
  }
  if (params.phone !== undefined) {
    body.telephone = params.phone;
  }
  if (
    params.address !== undefined ||
    params.city !== undefined ||
    params.postal_code !== undefined
  ) {
    const addressParts = [params.address, params.city, params.postal_code].filter(Boolean);
    body.address_text = addressParts.length > 0 ? addressParts.join(", ") : "";
  }
  if (params.country_code !== undefined) {
    const cc = normalizeCountryCode(params.country_code);
    if (cc !== undefined) {
      body.cl_code_country = cc;
    }
  }
  if (params.is_buyer !== undefined) {
    body.is_client = params.is_buyer;
  }
  if (params.is_supplier !== undefined) {
    body.is_supplier = params.is_supplier;
  }
  if (params.bank_account !== undefined) {
    body.bank_account_no = params.bank_account;
  }
  if (params.payment_term_days !== undefined) {
    body.invoice_days = params.payment_term_days;
  }

  return body;
}

export function createClientTools(client: EFinancialsClient) {
  return {
    list_clients: {
      description:
        "List all clients (buyers and suppliers). Can filter to show only buyers or only suppliers.",
      inputSchema: {
        type: "object" as const,
        properties: {
          is_supplier: {
            type: "boolean",
            description: "Filter to only show suppliers",
          },
          is_buyer: {
            type: "boolean",
            description: "Filter to only show buyers",
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
        const args = parseToolArgs(listClientsSchema, params);
        const response = await client.get<Client>("/v1/clients", {
          is_supplier: args.is_supplier,
          is_buyer: args.is_buyer,
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

    list_suppliers: {
      description:
        "List all suppliers (vendors you pay). Convenience method that filters clients to only suppliers.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (params: unknown) => {
        parseToolArgs(emptyToolArgs, params);
        const response = await client.get<Client>("/v1/clients", {
          is_supplier: true,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response.items || [], null, 2),
            },
          ],
        };
      },
    },

    get_client: {
      description: "Get details of a specific client by ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Client ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(clientIdSchema, params);
        const response = await client.get<Client>(`/v1/clients/${args.id}`);
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

    search_clients: {
      description:
        "Search for clients by name. Useful for finding the right client to assign to a transaction.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query (matches against client name)",
          },
          is_supplier: {
            type: "boolean",
            description: "Only search suppliers",
          },
        },
        required: ["query"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(searchClientsSchema, params);
        const allClients = await client.getAllPages<Client>("/v1/clients", {
          is_supplier: args.is_supplier,
        });
        const query = args.query.toLowerCase();
        const matches = allClients.filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            c.reg_code?.toLowerCase().includes(query) ||
            c.email?.toLowerCase().includes(query),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query: args.query,
                  count: matches.length,
                  clients: matches,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    },

    create_client: {
      description: "Create a new client (buyer or supplier). The client will be created as active.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...clientWritableInputProperties,
          name: {
            type: "string" as const,
            description: "Client/company name (required)",
          },
        },
        required: ["name"],
      },
      handler: async (params: unknown) => {
        const paramsParsed = parseToolArgs(createClientSchema, params) as CreateClientParams;
        // Build address_text from components if provided
        const addressParts = [
          paramsParsed.address,
          paramsParsed.city,
          paramsParsed.postal_code,
        ].filter(Boolean);
        const address_text = addressParts.length > 0 ? addressParts.join(", ") : undefined;

        // Map user-friendly params to API field names
        const apiParams: CreateClientAPIParams = {
          name: paramsParsed.name,
          code: paramsParsed.reg_code,
          invoice_vat_no: paramsParsed.vat_no,
          email: paramsParsed.email,
          telephone: paramsParsed.phone,
          address_text: address_text,
          cl_code_country: normalizeCountryCode(paramsParsed.country_code) || "EST",
          is_client: paramsParsed.is_buyer ?? false,
          is_supplier: paramsParsed.is_supplier ?? false,
          bank_account_no: paramsParsed.bank_account,
          invoice_days: paramsParsed.payment_term_days,
          is_juridical_entity: true,
          is_physical_entity: false,
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
        };

        const response = await client.post<Client>("/v1/clients", apiParams);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Client "${paramsParsed.name}" created`,
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

    update_client: {
      description:
        "PATCH an existing client. Only include fields to change; maps the same friendly names as create_client to the API.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number" as const,
            description: "Client ID",
          },
          ...clientWritableInputProperties,
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updateClientSchema, params);
        const { id, ...rest } = parsed as UpdateClientParams;
        const body = buildPartialClientPatchBody({ id, ...rest });
        if (Object.keys(body).length === 0) {
          throw new Error(
            "update_client: provide at least one field to change (e.g. name, email, is_buyer) in addition to id",
          );
        }
        const response = await client.patch<Client>(`/v1/clients/${id}`, body);
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

    delete_client: {
      description:
        "Permanently delete a client by ID. This cannot be undone; use deactivate_client if you only need to hide the client from active use.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number" as const,
            description: "Client ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(clientIdSchema, params);
        const response = await client.delete(`/v1/clients/${args.id}`);
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

    deactivate_client: {
      description:
        "Deactivate a client (soft-disable). The record remains; use reactivate_client to enable again.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number" as const,
            description: "Client ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(clientIdSchema, params);
        const response = await client.patch(`/v1/clients/${args.id}/deactivate`);
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

    reactivate_client: {
      description: "Reactivate a previously deactivated client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number" as const,
            description: "Client ID",
          },
        },
        required: ["id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(clientIdSchema, params);
        const response = await client.patch(`/v1/clients/${args.id}/reactivate`);
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
