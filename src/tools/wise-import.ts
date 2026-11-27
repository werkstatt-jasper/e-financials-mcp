import { z } from "zod";
import { createVerifiedTransaction } from "../banking/create-verified-transaction.js";
import { errorMessage } from "../banking/errors.js";
import { loadLabelledTransactions } from "../banking/stored-direction.js";
import {
  bookedAmount,
  bookedCurrency,
  bookedFeeAmount,
  bookedFeeCurrency,
  counterpartyName,
  hasBookedValue,
  humanWiseDescription,
  isCompletedWiseRow,
  isJarTransfer,
  parseWiseCsv,
  toolTypeForWiseDirection,
  WISE_FEE_CHART_ACCOUNT_ID,
  wiseFxQuote,
  wiseTransactionDate,
} from "../banking/wise-csv.js";
import {
  buildWiseDescription,
  buildWiseDuplicateIndex,
  findWiseDuplicate,
  rememberWiseEntry,
  type WiseImportEntry,
} from "../banking/wise-duplicates.js";
import type { EFinancialsClient } from "../client.js";
import { roundMoney } from "../money.js";
import { resolveFileInput } from "../resolve-file-input.js";
import type { AccountDimension } from "../types/accounts.js";
import type { Transaction } from "../types/transaction.js";
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalYmd,
  parseToolArgs,
  positiveInt,
} from "../validation/tool-args.js";

const wiseImportSchema = z.object({
  file_path: z.string().min(1),
  accounts_dimensions_id: positiveInt,
  fee_account_dimensions_id: optionalPositiveInt,
  execute: optionalBoolean,
  date_from: optionalYmd,
  date_to: optionalYmd,
  skip_jar_transfers: optionalBoolean,
});

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const BASE64_PREFIX = "base64:";

/**
 * `resolveFileInput` cannot magic-byte sniff CSV, so a bare `base64:<data>`
 * payload is rejected as ambiguous. Treat that form as `base64:csv:<data>`.
 * An explicit `base64:<ext>:<data>` hint is left unchanged.
 */
export function normalizeWiseImportFilePath(filePath: string): string {
  if (!filePath.startsWith(BASE64_PREFIX)) {
    return filePath;
  }
  const body = filePath.slice(BASE64_PREFIX.length);
  const firstColon = body.indexOf(":");
  const hasExtHint =
    firstColon > 0 && firstColon <= 5 && /^[A-Za-z0-9]+$/.test(body.slice(0, firstColon));
  if (hasExtHint) {
    return filePath;
  }
  return `${BASE64_PREFIX}csv:${body}`;
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

export function resolveWiseFeeAccountDimensionId(
  dimensions: AccountDimension[],
  feeAccountDimensionId: number | undefined,
  bankAccountDimensionId: number,
): number {
  if (feeAccountDimensionId != null) {
    if (!dimensions.some((dimension) => dimension.id === feeAccountDimensionId)) {
      throw new Error(`fee_account_dimensions_id ${feeAccountDimensionId} was not found`);
    }
    return feeAccountDimensionId;
  }

  const candidates = dimensions.filter(
    (dimension) =>
      dimension.accounts_id === WISE_FEE_CHART_ACCOUNT_ID &&
      dimension.id !== bankAccountDimensionId,
  );
  const only = candidates[0];
  if (candidates.length === 1 && only != null) {
    return only.id;
  }
  if (candidates.length > 1) {
    const ids = candidates.map((dimension) => dimension.id).join(", ");
    throw new Error(
      `Wise fee rows require fee_account_dimensions_id because account ${WISE_FEE_CHART_ACCOUNT_ID} has multiple dimensions (${ids}).`,
    );
  }
  throw new Error(
    `Wise fee rows require fee_account_dimensions_id. No unique dimension for account ${WISE_FEE_CHART_ACCOUNT_ID} was found. Use list_account_dimensions to find it.`,
  );
}

function entryPayload(
  entry: WiseImportEntry,
  accountsDimensionsId: number,
  extras: { currencyRate?: number; baseAmount?: number },
): Record<string, string | number> & { type: "C" | "D" } {
  const description = buildWiseDescription(entry);
  const body: Record<string, string | number> & { type: "C" | "D" } = {
    accounts_dimensions_id: accountsDimensionsId,
    type: entry.type,
    amount: entry.amount,
    cl_currencies_id: entry.currency,
    date: entry.date,
    description,
  };
  if (entry.counterparty) {
    body.bank_account_name = entry.counterparty;
  }
  if (entry.reference) {
    body.ref_number = entry.reference;
  }
  if (extras.currencyRate != null) {
    body.currency_rate = extras.currencyRate;
  }
  if (extras.baseAmount != null) {
    body.base_amount = extras.baseAmount;
  }
  return body;
}

/**
 * Import a Wise transaction-history CSV as PROJECT bank transactions.
 */
export function createWiseImportTools(client: EFinancialsClient) {
  return {
    import_wise_transactions: {
      description:
        "Import a Wise transaction-history CSV (the Transactions export, not a statement export) as PROJECT bank transactions. Dry-run by default; execute=true creates rows. Direction IN is type C (money in) and OUT is type D (money out). Fees are split into a separate outgoing transaction. Jar / savings-pot transfers are skipped unless skip_jar_transfers=false. file_path is a filesystem path or base64:/base64:csv: payload. Duplicate detection uses a description marker (and a date/amount/counterparty signature when a prior import left no marker). Created rows report direction_confirmed; check any unconfirmed rows before registering. Pro-tier batch write.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string",
            description: "Filesystem path or base64: / base64:csv: payload",
          },
          accounts_dimensions_id: {
            type: "number",
            description: "Bank account dimension id for the Wise account",
          },
          fee_account_dimensions_id: {
            type: "number",
            description:
              "Expense dimension for Wise fees (optional; auto-detected when a unique account 8610 dimension exists)",
          },
          execute: {
            type: "boolean",
            description: "Create transactions (default false = dry run)",
          },
          date_from: { type: "string", description: "Inclusive YYYY-MM-DD filter" },
          date_to: { type: "string", description: "Inclusive YYYY-MM-DD filter" },
          skip_jar_transfers: {
            type: "boolean",
            description: "Skip Jar (savings pot) transfers (default true)",
          },
        },
        required: ["file_path", "accounts_dimensions_id"],
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(wiseImportSchema, params);
        if (args.date_from != null && args.date_to != null && args.date_from > args.date_to) {
          throw new Error("date_from must be on or before date_to");
        }

        const file = await resolveFileInput(normalizeWiseImportFilePath(args.file_path));
        if (file.extension !== ".csv") {
          throw new Error("Wise import input must be CSV (path or base64:csv: payload)");
        }

        const parsed = parseWiseCsv(file.buffer.toString("utf8"));
        const rows = parsed.rows;
        const skipJars = args.skip_jar_transfers !== false;
        const execute = args.execute === true;

        const skipped: unknown[] = [];
        const eligible: Array<{ row: (typeof rows)[number]; date: string; type: "C" | "D" }> = [];
        let filteredOut = parsed.short_row_count;

        for (const row of rows) {
          const date = wiseTransactionDate(row);
          const type = toolTypeForWiseDirection(row.direction);
          if (
            !isCompletedWiseRow(row) ||
            type == null ||
            !hasBookedValue(row) ||
            !inDateRange(date, args.date_from, args.date_to)
          ) {
            filteredOut += 1;
            continue;
          }
          if (skipJars && isJarTransfer(row)) {
            skipped.push({
              wise_id: row.id,
              date,
              amount: bookedAmount(row),
              reason: "Jar / self-transfer detected (pass skip_jar_transfers=false to include)",
            });
            continue;
          }
          if (row.id === "") {
            skipped.push({
              date,
              amount: bookedAmount(row),
              reason: "Missing Wise transaction ID",
            });
            continue;
          }
          eligible.push({ row, date, type });
        }

        const dimensions = await client.getAllPages<AccountDimension>("/v1/account_dimensions");
        const dimensionId = args.accounts_dimensions_id;
        if (!dimensions.some((dimension) => dimension.id === dimensionId)) {
          throw new Error(`accounts_dimensions_id ${dimensionId} was not found`);
        }

        const hasFeeRows = eligible.some((item) => bookedFeeAmount(item.row) > 0);
        const feeAccountDimensionId = hasFeeRows
          ? resolveWiseFeeAccountDimensionId(
              dimensions,
              args.fee_account_dimensions_id,
              dimensionId,
            )
          : undefined;

        const existing = (
          await loadLabelledTransactions(client, {
            start_date: args.date_from,
            end_date: args.date_to,
          })
        ).filter((tx: Transaction) => tx.status !== "VOID" && tx.is_deleted !== true);

        const index = buildWiseDuplicateIndex(existing);
        const results: unknown[] = [];
        const errors: unknown[] = [];
        let createdCount = 0;
        let skippedCount = skipped.length;
        let errorCount = 0;
        let unconfirmedCount = 0;

        const recordSkip = (item: Record<string, unknown>) => {
          skippedCount += 1;
          skipped.push(item);
        };

        for (const item of eligible) {
          const { row, date, type } = item;

          const amount = bookedAmount(row);
          const currency = bookedCurrency(row);
          const fx = wiseFxQuote(row);
          const mainEntry: WiseImportEntry = {
            wiseId: row.id,
            kind: "main",
            date,
            type,
            amount,
            currency,
            counterparty: counterpartyName(row),
            reference: row.reference || undefined,
            description: humanWiseDescription(row, "main"),
          };
          const feeAmount = bookedFeeAmount(row);
          const feeCurrency = bookedFeeCurrency(row, currency);
          const feeEntry: WiseImportEntry | undefined =
            feeAmount > 0
              ? {
                  wiseId: row.id,
                  kind: "fee",
                  date,
                  type: "D",
                  amount: feeAmount,
                  currency: feeCurrency,
                  counterparty: "Wise",
                  description: humanWiseDescription(row, "fee"),
                }
              : undefined;

          let mainAvailableForFee = false;

          if (amount === 0) {
            // A 0.00 main booking is not useful; still allow a positive fee row.
            mainAvailableForFee = true;
          } else {
            const mainDup = findWiseDuplicate(mainEntry, index);
            if (mainDup != null) {
              recordSkip({
                wise_id: row.id,
                date,
                amount,
                currency,
                kind: "main",
                duplicate_transaction_ids: mainDup.transaction_ids,
                reason: mainDup.reason,
              });
              rememberWiseEntry(index, mainEntry, mainDup.transaction_ids[0]);
              mainAvailableForFee = true;
            } else {
              const body = entryPayload(mainEntry, dimensionId, {
                currencyRate: fx?.currencyRate,
                baseAmount: fx?.baseAmount,
              });
              const storedDescription = body.description;

              if (!execute) {
                createdCount += 1;
                results.push({
                  status: "would_create",
                  wise_id: row.id,
                  kind: "main",
                  date,
                  amount,
                  currency,
                  type,
                  description: mainEntry.description,
                  stored_description: storedDescription,
                  counterparty: mainEntry.counterparty,
                  ref_number: mainEntry.reference,
                  currency_rate: fx?.currencyRate,
                  base_amount: fx?.baseAmount,
                });
                rememberWiseEntry(index, mainEntry);
                mainAvailableForFee = true;
              } else {
                try {
                  const created = await createVerifiedTransaction(client, body);
                  createdCount += 1;
                  results.push({
                    status: "created",
                    wise_id: row.id,
                    kind: "main",
                    date,
                    amount,
                    currency,
                    type: created.type,
                    description: mainEntry.description,
                    stored_description: storedDescription,
                    counterparty: mainEntry.counterparty,
                    ref_number: mainEntry.reference,
                    currency_rate: fx?.currencyRate,
                    base_amount: fx?.baseAmount,
                    api_id: created.id,
                    rik_messages: created.rik_messages,
                    direction_confirmed: created.direction_confirmed,
                    read_back_error: created.read_back_error,
                  });
                  rememberWiseEntry(index, mainEntry, created.id);
                  mainAvailableForFee = true;
                  if (!created.direction_confirmed) {
                    unconfirmedCount += 1;
                  }
                } catch (err) {
                  errorCount += 1;
                  errors.push({
                    wise_id: row.id,
                    kind: "main",
                    date,
                    amount,
                    currency,
                    message: errorMessage(err),
                  });
                }
              }
            }
          }

          if (feeEntry == null) {
            continue;
          }
          if (!mainAvailableForFee) {
            recordSkip({
              wise_id: `FEE:${row.id}`,
              date,
              amount: feeEntry.amount,
              currency: feeEntry.currency,
              kind: "fee",
              reason: "Skipped because main transaction was not created",
            });
            continue;
          }

          const feeDup = findWiseDuplicate(feeEntry, index);
          if (feeDup != null) {
            recordSkip({
              wise_id: `FEE:${row.id}`,
              date,
              amount: feeEntry.amount,
              currency: feeEntry.currency,
              kind: "fee",
              duplicate_transaction_ids: feeDup.transaction_ids,
              reason: feeDup.reason,
            });
            rememberWiseEntry(index, feeEntry, feeDup.transaction_ids[0]);
            continue;
          }

          const feeFx =
            feeCurrency === "EUR"
              ? { currencyRate: 1 as number | undefined, baseAmount: feeAmount }
              : fx?.eurRate != null
                ? { currencyRate: fx.eurRate, baseAmount: roundMoney(feeAmount * fx.eurRate) }
                : {
                    currencyRate: undefined as number | undefined,
                    baseAmount: undefined as number | undefined,
                  };

          const feeBody = entryPayload(feeEntry, dimensionId, feeFx);
          const feeStoredDescription = feeBody.description;

          if (!execute) {
            createdCount += 1;
            results.push({
              status: "would_create",
              wise_id: `FEE:${row.id}`,
              kind: "fee",
              date,
              amount: feeEntry.amount,
              currency: feeEntry.currency,
              type: feeEntry.type,
              description: feeEntry.description,
              stored_description: feeStoredDescription,
              counterparty: feeEntry.counterparty,
              fee_account_dimensions_id: feeAccountDimensionId,
              currency_rate: feeFx.currencyRate,
              base_amount: feeFx.baseAmount,
            });
            rememberWiseEntry(index, feeEntry);
            continue;
          }

          try {
            const created = await createVerifiedTransaction(client, feeBody);
            createdCount += 1;
            results.push({
              status: "created",
              wise_id: `FEE:${row.id}`,
              kind: "fee",
              date,
              amount: feeEntry.amount,
              currency: feeEntry.currency,
              type: created.type,
              description: feeEntry.description,
              stored_description: feeStoredDescription,
              counterparty: feeEntry.counterparty,
              fee_account_dimensions_id: feeAccountDimensionId,
              currency_rate: feeFx.currencyRate,
              base_amount: feeFx.baseAmount,
              api_id: created.id,
              rik_messages: created.rik_messages,
              direction_confirmed: created.direction_confirmed,
              read_back_error: created.read_back_error,
            });
            rememberWiseEntry(index, feeEntry, created.id);
            if (!created.direction_confirmed) {
              unconfirmedCount += 1;
            }
          } catch (err) {
            errorCount += 1;
            errors.push({
              wise_id: `FEE:${row.id}`,
              kind: "fee",
              date,
              amount: feeEntry.amount,
              currency: feeEntry.currency,
              message: errorMessage(err),
            });
          }
        }

        return jsonResult({
          mode: execute ? "EXECUTED" : "DRY_RUN",
          fee_account_dimensions_id: feeAccountDimensionId,
          summary: {
            total_csv_rows: rows.length + parsed.short_row_count,
            eligible_rows: eligible.length,
            filtered_out: filteredOut,
            created_count: createdCount,
            skipped_count: skippedCount,
            error_count: errorCount,
            direction_unconfirmed_count: unconfirmedCount,
          },
          results,
          skipped,
          errors,
        });
      },
    },
  };
}
