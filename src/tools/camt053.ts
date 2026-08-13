import { z } from "zod";
import {
  buildCamtDescription,
  buildDuplicateIndex,
  entryBatchKey,
  findExactDuplicate,
  findPossibleDuplicates,
  transactionTypeFromDirection,
} from "../banking/camt053-duplicates.js";
import { type CamtEntry, parseCamt053 } from "../banking/camt053-parser.js";
import { errorMessage } from "../banking/errors.js";
import type { EFinancialsClient } from "../client.js";
import { resolveFileInput } from "../resolve-file-input.js";
import type { AccountDimension } from "../types/accounts.js";
import type { Client } from "../types/clients.js";
import type { Transaction } from "../types/transaction.js";
import { optionalYmd, parseToolArgs, positiveInt } from "../validation/tool-args.js";

const camt053Schema = z.object({
  mode: z.enum(["parse", "dry_run", "execute"]).optional(),
  file_path: z.string().min(1),
  accounts_dimensions_id: positiveInt.optional(),
  date_from: optionalYmd,
  date_to: optionalYmd,
});

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function inDateRange(date: string, dateFrom?: string, dateTo?: string): boolean {
  if (dateFrom != null && date < dateFrom) {
    return false;
  }
  if (dateTo != null && date > dateTo) {
    return false;
  }
  return true;
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export type ClientMatchType = "reg_code" | "exact_name" | "single_name_match";

export function matchClient(
  entry: CamtEntry,
  clients: Client[],
): { clients_id: number; match_type: ClientMatchType } | undefined {
  if (entry.counterparty_reg_code) {
    const hit = clients.find((c) => c.reg_code === entry.counterparty_reg_code);
    if (hit) {
      return { clients_id: hit.id, match_type: "reg_code" };
    }
  }
  if (entry.counterparty_name == null || entry.counterparty_name.trim() === "") {
    return undefined;
  }
  const want = normalizeName(entry.counterparty_name);
  const exact = clients.filter((c) => normalizeName(c.name) === want);
  for (const hit of exact) {
    if (exact.length === 1) {
      return { clients_id: hit.id, match_type: "exact_name" };
    }
    break;
  }
  const fuzzy = clients.filter((c) => {
    const n = normalizeName(c.name);
    return n.includes(want) || want.includes(n);
  });
  for (const hit of fuzzy) {
    if (fuzzy.length === 1) {
      return { clients_id: hit.id, match_type: "single_name_match" };
    }
    break;
  }
  return undefined;
}

function entryPayload(entry: CamtEntry, accountsDimensionsId: number, clientsId?: number) {
  const description = buildCamtDescription(entry);
  const body: Record<string, string | number> = {
    accounts_dimensions_id: accountsDimensionsId,
    type: transactionTypeFromDirection(entry.direction),
    amount: entry.amount,
    cl_currencies_id: entry.currency,
    date: entry.date,
  };
  if (description != null) {
    body.description = description;
  }
  if (entry.counterparty_name) {
    body.bank_account_name = entry.counterparty_name;
  }
  if (entry.counterparty_iban) {
    body.bank_account_no = entry.counterparty_iban;
  }
  if (entry.reference_number) {
    body.ref_number = entry.reference_number;
  }
  if (entry.bank_reference) {
    body.bank_ref_number = entry.bank_reference;
  }
  if (clientsId != null) {
    body.clients_id = clientsId;
  }
  return body;
}

function createdId(response: unknown): number | undefined {
  if (response == null || typeof response !== "object") {
    return undefined;
  }
  const rec = response as Record<string, unknown>;
  if (typeof rec.id === "number") {
    return rec.id;
  }
  if (typeof rec.created_object_id === "number") {
    return rec.created_object_id;
  }
  return undefined;
}

function summaryFromEntries(entries: CamtEntry[]) {
  const credits = entries.filter((e) => e.direction === "CRDT");
  const debits = entries.filter((e) => e.direction === "DBIT");
  return {
    entry_count: entries.length,
    credit_count: credits.length,
    credit_total: credits.reduce((s, e) => s + e.amount, 0),
    debit_count: debits.length,
    debit_total: debits.reduce((s, e) => s + e.amount, 0),
  };
}

/**
 * Import ISO 20022 CAMT.053 bank statements as PROJECT bank transactions.
 */
export function createCamt053Tools(client: EFinancialsClient) {
  return {
    process_camt053: {
      description:
        "Import an ISO 20022 CAMT.053 bank statement (LHV, Swedbank, SEB, Coop, Luminor). Modes: parse (read-only), dry_run (default for import; no writes), execute (create PROJECT transactions). file_path is a filesystem path or base64:/base64:xml: payload. dry_run/execute require accounts_dimensions_id. Duplicate detection uses bank reference (and a description marker when the API drops dedicated fields). Pro-tier batch write.",
      inputSchema: {
        type: "object" as const,
        properties: {
          mode: {
            type: "string",
            enum: ["parse", "dry_run", "execute"],
            description: "parse (default), dry_run, or execute",
          },
          file_path: {
            type: "string",
            description: "Filesystem path or base64: / base64:xml: payload",
          },
          accounts_dimensions_id: {
            type: "number",
            description: "Bank account dimension id (required for dry_run and execute)",
          },
          date_from: { type: "string", description: "Inclusive YYYY-MM-DD filter" },
          date_to: { type: "string", description: "Inclusive YYYY-MM-DD filter" },
        },
        required: ["file_path"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(camt053Schema, params);
        const mode = args.mode ?? "parse";
        if (args.date_from != null && args.date_to != null && args.date_from > args.date_to) {
          throw new Error("date_from must be on or before date_to");
        }

        const file = await resolveFileInput(args.file_path);
        if (file.extension !== ".xml") {
          throw new Error("CAMT.053 input must be XML (path or base64:xml: payload)");
        }
        const parsed = parseCamt053(file.buffer.toString("utf8"));
        const eligible = parsed.entries.filter((e) =>
          inDateRange(e.date, args.date_from, args.date_to),
        );

        const existing = (
          await client.getAllPages<Transaction>("/v1/transactions", {
            start_date: args.date_from,
            end_date: args.date_to,
          })
        ).filter((t) => t.status !== "VOID" && t.is_deleted !== true);

        if (mode === "parse") {
          const index = buildDuplicateIndex(existing, eligible);
          const entries = eligible.map((entry) => {
            const dup = findExactDuplicate(entry, index);
            return {
              ...entry,
              duplicate: dup != null ? true : undefined,
              duplicate_transaction_ids: dup?.transaction_ids,
            };
          });
          const duplicate_count = entries.filter((e) => e.duplicate === true).length;
          return jsonResult({
            mode: "parse",
            statement_metadata: parsed.statement_metadata,
            entries,
            summary: { ...summaryFromEntries(eligible), duplicate_count },
          });
        }

        const dimensionId = args.accounts_dimensions_id;
        if (dimensionId == null) {
          throw new Error("accounts_dimensions_id is required for dry_run and execute");
        }
        const dimensions = await client.getAllPages<AccountDimension>("/v1/account_dimensions");
        if (!dimensions.some((d) => d.id === dimensionId)) {
          throw new Error(`accounts_dimensions_id ${dimensionId} was not found`);
        }

        const index = buildDuplicateIndex(existing, eligible, dimensionId);
        const clients = await client.getAllPages<Client>("/v1/clients");
        const seenBatch = new Set<string>();
        const execute = mode === "execute";

        const results: unknown[] = [];
        const skipped: unknown[] = [];
        const errors: unknown[] = [];
        const possible: unknown[] = [];
        let createdCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const entry of eligible) {
          const batchKey = entryBatchKey(entry);
          if (seenBatch.has(batchKey)) {
            skippedCount += 1;
            skipped.push({
              date: entry.date,
              amount: entry.amount,
              bank_reference: entry.bank_reference,
              reason: "Duplicate CAMT entry inside current import batch",
            });
            continue;
          }
          seenBatch.add(batchKey);

          const dup = findExactDuplicate(entry, index);
          if (dup != null) {
            skippedCount += 1;
            skipped.push({
              date: entry.date,
              amount: entry.amount,
              bank_reference: entry.bank_reference,
              duplicate_transaction_ids: dup.transaction_ids,
              reason: dup.reason,
            });
            continue;
          }

          const clientHit = matchClient(entry, clients);
          const possibleHits = findPossibleDuplicates(entry, index);
          const body = entryPayload(entry, dimensionId, clientHit?.clients_id);
          const storedDescription =
            typeof body.description === "string" ? body.description : undefined;

          if (!execute) {
            createdCount += 1;
            results.push({
              status: "would_create",
              date: entry.date,
              amount: entry.amount,
              currency: entry.currency,
              type: transactionTypeFromDirection(entry.direction),
              description: entry.description,
              stored_description: storedDescription,
              counterparty: entry.counterparty_name,
              bank_reference: entry.bank_reference,
              ref_number: entry.reference_number,
              clients_id: clientHit?.clients_id,
              client_match: clientHit?.match_type,
            });
          } else {
            try {
              const response = await client.post("/v1/transactions", body);
              const apiId = createdId(response);
              createdCount += 1;
              results.push({
                status: "created",
                date: entry.date,
                amount: entry.amount,
                currency: entry.currency,
                type: transactionTypeFromDirection(entry.direction),
                description: entry.description,
                stored_description: storedDescription,
                counterparty: entry.counterparty_name,
                bank_reference: entry.bank_reference,
                ref_number: entry.reference_number,
                clients_id: clientHit?.clients_id,
                client_match: clientHit?.match_type,
                api_id: apiId,
              });
              if (possibleHits.length > 0) {
                possible.push({
                  date: entry.date,
                  amount: entry.amount,
                  bank_reference: entry.bank_reference,
                  new_transaction_api_id: apiId,
                  existing_transactions: possibleHits,
                });
              }
            } catch (err) {
              errorCount += 1;
              errors.push({
                date: entry.date,
                amount: entry.amount,
                bank_reference: entry.bank_reference,
                message: errorMessage(err),
              });
            }
          }

          if (!execute && possibleHits.length > 0) {
            possible.push({
              date: entry.date,
              amount: entry.amount,
              bank_reference: entry.bank_reference,
              existing_transactions: possibleHits,
            });
          }
        }

        return jsonResult({
          mode: execute ? "EXECUTED" : "DRY_RUN",
          statement_metadata: parsed.statement_metadata,
          summary: {
            total_statement_entries: parsed.entries.length,
            eligible_entries: eligible.length,
            filtered_out: parsed.entries.length - eligible.length,
            created_count: createdCount,
            skipped_count: skippedCount,
            error_count: errorCount,
            possible_duplicate_count: possible.length,
          },
          results,
          skipped,
          errors,
          possible_duplicates: possible,
        });
      },
    },
  };
}
