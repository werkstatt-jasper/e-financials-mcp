import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { EFinancialsClient } from "../client.js";
import type { ApiFile, Journal, Posting } from "../types/journal.js";
import { resolveUploadFilePath } from "../upload-file-path.js";
import {
  creditDebitEnum,
  optionalNumber,
  optionalPage,
  optionalPositiveInt,
  optionalString,
  optionalYmd,
  parseToolArgs,
  positiveInt,
  ymdDateString,
} from "../validation/tool-args.js";

const postingLineSchemaProps = {
  journals_id: {
    type: "number" as const,
    description:
      "Journal entry ID for this line. When creating a new journal, use 0 or omit (the server links lines after create).",
  },
  accounts_id: {
    type: "number" as const,
    description: "Ledger account ID",
  },
  accounts_dimensions_id: {
    type: "number" as const,
    description: "Account dimension ID",
  },
  type: {
    type: "string" as const,
    description: "Line type: debit (D) or credit (C)",
  },
  amount: {
    type: "number" as const,
    description: "Line amount",
  },
  cl_currencies_id: {
    type: "string" as const,
    description: "ISO 4217 currency code (3 letters), e.g. EUR",
  },
  projects_project_id: {
    type: "number" as const,
    description: "Cost/profit centre (project) ID",
  },
  projects_location_id: {
    type: "number" as const,
    description: "Cost/profit centre (location) ID",
  },
  projects_person_id: {
    type: "number" as const,
    description: "Cost/profit centre (person) ID",
  },
} satisfies Record<string, object>;

const journalBodySchemaProps = {
  clients_id: {
    type: "number" as const,
    description: "Buyer/supplier/employee client ID",
  },
  subclients_id: {
    type: "number" as const,
    description: "Subclient ID",
  },
  title: {
    type: "string" as const,
    description: "Journal title (max 100 characters per API)",
  },
  effective_date: {
    type: "string" as const,
    description: "Entry effective date (ISO date YYYY-MM-DD)",
  },
  document_number: {
    type: "string" as const,
    description: "Document number",
  },
  cl_currencies_id: {
    type: "string" as const,
    description: "ISO 4217 currency code (3 letters)",
  },
  currency_rate: {
    type: "number" as const,
    description: "Exchange rate vs base currency",
  },
  postings: {
    type: "array" as const,
    description:
      "Journal lines (debits/credits). OpenAPI requires journals_id on each line; use 0 for new entries.",
    items: {
      type: "object" as const,
      properties: postingLineSchemaProps,
      required: ["accounts_id", "amount"],
    },
  },
} satisfies Record<string, object>;

type JournalBodyKeys = keyof typeof journalBodySchemaProps;

function pickJournalBody(
  params: Record<string, unknown>,
  keys: readonly JournalBodyKeys[],
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

const allJournalBodyKeys = Object.keys(journalBodySchemaProps) as JournalBodyKeys[];

const postingLineSchema = z.object({
  journals_id: z.union([z.null(), z.coerce.number().int().min(0)]).optional(),
  accounts_id: positiveInt,
  accounts_dimensions_id: optionalPositiveInt,
  type: creditDebitEnum.optional(),
  amount: z.coerce.number(),
  cl_currencies_id: optionalString,
  projects_project_id: optionalPositiveInt,
  projects_location_id: optionalPositiveInt,
  projects_person_id: optionalPositiveInt,
});

const listJournalsSchema = z.object({
  page: optionalPage,
  modified_since: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  start_date: optionalYmd,
  end_date: optionalYmd,
});

const journalsIdSchema = z.object({ journals_id: positiveInt });

const createJournalSchema = z.object({
  clients_id: optionalPositiveInt,
  subclients_id: optionalPositiveInt,
  title: optionalString,
  effective_date: ymdDateString,
  document_number: optionalString,
  cl_currencies_id: optionalString,
  currency_rate: optionalNumber,
  postings: z.union([z.array(postingLineSchema), z.string()]),
});

const updateJournalSchema = z.object({
  journals_id: positiveInt,
  clients_id: optionalPositiveInt,
  subclients_id: optionalPositiveInt,
  title: optionalString,
  effective_date: optionalYmd,
  document_number: optionalString,
  cl_currencies_id: optionalString,
  currency_rate: optionalNumber,
  postings: z.union([z.array(postingLineSchema), z.null()]).optional(),
});

const uploadJournalFileSchema = z.object({
  journals_id: positiveInt,
  file_path: z.string().min(1),
});

function normalizePostingsForApi(postings: unknown): Posting[] {
  if (!Array.isArray(postings)) {
    return [];
  }
  return postings.map((row) => {
    const line = { ...(row as Record<string, unknown>) };
    if (line.journals_id === undefined) {
      line.journals_id = 0;
    }
    return line as unknown as Posting;
  });
}

export function createJournalTools(client: EFinancialsClient) {
  return {
    list_journals: {
      description:
        "List journal entries with optional pagination and filters (modified_since, effective date range).",
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
          start_date: {
            type: "string",
            description: "Effective date on this date or later (YYYY-MM-DD)",
          },
          end_date: {
            type: "string",
            description: "Effective date on this date or before (YYYY-MM-DD)",
          },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(listJournalsSchema, params);
        const response = await client.get<Journal>("/v1/journals", {
          page: args.page,
          modified_since: args.modified_since,
          start_date: args.start_date,
          end_date: args.end_date,
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

    get_journal: {
      description: "Get one journal entry by ID (includes postings).",
      inputSchema: {
        type: "object" as const,
        properties: {
          journals_id: {
            type: "number",
            description: "Journal entry ID",
          },
        },
        required: ["journals_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(journalsIdSchema, params);
        const response = await client.get<Journal>(`/v1/journals/${args.journals_id}`);
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

    create_journal: {
      description:
        "Create a journal entry (POST). Body follows OpenAPI Journals: effective_date and balanced postings (debit/credit) are required. Each posting line should include accounts_id and amount; use journals_id 0 on lines for new entries.",
      inputSchema: {
        type: "object" as const,
        properties: journalBodySchemaProps,
        required: ["effective_date", "postings"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(createJournalSchema, params) as Record<string, unknown>;
        const body = pickJournalBody(parsed, allJournalBodyKeys);
        if (Array.isArray(body.postings)) {
          body.postings = normalizePostingsForApi(body.postings);
        }
        const response = await client.post("/v1/journals", body);
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

    update_journal: {
      description:
        "PATCH an existing journal entry. Only send fields to change. Read-only: id, parent_id, number, amendment_number, registered, operations_id, operation_type, base_document_files_id, is_xls_imported, posting ids, posting base_amount.",
      inputSchema: {
        type: "object" as const,
        properties: {
          journals_id: {
            type: "number",
            description: "Journal entry ID",
          },
          ...journalBodySchemaProps,
        },
        required: ["journals_id"],
      },
      handler: async (params: unknown) => {
        const parsed = parseToolArgs(updateJournalSchema, params);
        const { journals_id, ...rest } = parsed as Record<string, unknown> & {
          journals_id: number;
        };
        const body = pickJournalBody(rest, allJournalBodyKeys);
        if (body.postings !== undefined) {
          body.postings = normalizePostingsForApi(body.postings);
        }
        const response = await client.patch(`/v1/journals/${journals_id}`, body);
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

    delete_journal: {
      description: "Delete a journal entry by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          journals_id: {
            type: "number",
            description: "Journal entry ID",
          },
        },
        required: ["journals_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(journalsIdSchema, params);
        const response = await client.delete(`/v1/journals/${args.journals_id}`);
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

    register_journal: {
      description: "Register (confirm/post) a journal entry.",
      inputSchema: {
        type: "object" as const,
        properties: {
          journals_id: {
            type: "number",
            description: "Journal entry ID",
          },
        },
        required: ["journals_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(journalsIdSchema, params);
        const response = await client.patch(`/v1/journals/${args.journals_id}/register`);
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

    invalidate_journal: {
      description: "Invalidate a journal entry (reverse registration state per API rules).",
      inputSchema: {
        type: "object" as const,
        properties: {
          journals_id: {
            type: "number",
            description: "Journal entry ID",
          },
        },
        required: ["journals_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(journalsIdSchema, params);
        const response = await client.patch(`/v1/journals/${args.journals_id}/invalidate`);
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

    get_journal_file: {
      description:
        "Get the user-uploaded file attached to a journal entry (OpenAPI ApiFile: name + base64 contents).",
      inputSchema: {
        type: "object" as const,
        properties: {
          journals_id: {
            type: "number",
            description: "Journal entry ID",
          },
        },
        required: ["journals_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(journalsIdSchema, params);
        const response = await client.get<ApiFile>(
          `/v1/journals/${args.journals_id}/document_user`,
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

    upload_journal_file: {
      description:
        "Upload a file to a journal entry (PUT .../document_user). File is read from disk, base64-encoded, sent as OpenAPI ApiFile.",
      inputSchema: {
        type: "object" as const,
        properties: {
          journals_id: {
            type: "number",
            description: "Journal entry ID",
          },
          file_path: {
            type: "string",
            description:
              "Local path to the file to upload. If MCP_FILE_UPLOAD_ROOT is set, use a path relative to that directory (absolute paths are rejected). Otherwise any readable path is allowed.",
          },
        },
        required: ["journals_id", "file_path"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(uploadJournalFileSchema, params);
        const resolvedPath = await resolveUploadFilePath(args.file_path);
        const fileBuffer = await readFile(resolvedPath);
        const base64Content = fileBuffer.toString("base64");
        const filename = basename(resolvedPath);

        const response = await client.put(`/v1/journals/${args.journals_id}/document_user`, {
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
                  message: `File "${filename}" uploaded to journal ${args.journals_id}`,
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

    delete_journal_file: {
      description: "Delete the user-uploaded file from a journal entry.",
      inputSchema: {
        type: "object" as const,
        properties: {
          journals_id: {
            type: "number",
            description: "Journal entry ID",
          },
        },
        required: ["journals_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(journalsIdSchema, params);
        const response = await client.delete(`/v1/journals/${args.journals_id}/document_user`);
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
