import { z } from "zod";
import { errorMessage } from "../banking/errors.js";
import { looksLikeBankFee } from "../banking/fee-patterns.js";
import {
  buildAccountDistribution,
  buildOwnBankMaps,
  expandOwnDimensionsFromTransactions,
  findOneSidedTransfers,
  findTransferPairs,
  indexInterAccountJournals,
  isAlreadyJournalizedTransfer,
} from "../banking/inter-account.js";
import {
  buildInvoiceIndexes,
  buildOpenInvoicePool,
  canAutoDistribute,
  candidateInvoicesForTransaction,
  invoiceConsumptionKey,
  rankInvoiceMatches,
} from "../banking/invoice-index.js";
import { buildInvoiceDistribution } from "../banking/match-score.js";
import type { EFinancialsClient } from "../client.js";
import type { AccountDimension, BankAccounts } from "../types/accounts.js";
import type { Client } from "../types/clients.js";
import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import type { Journal } from "../types/journal.js";
import type { Transaction } from "../types/transaction.js";
import { optionalPositiveInt, optionalYmd, parseToolArgs } from "../validation/tool-args.js";

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function isProjectTransaction(t: Transaction): boolean {
  return t.status === "PROJECT" && !t.is_deleted;
}

async function loadProjectTransactions(
  client: EFinancialsClient,
  opts: {
    accounts_dimensions_id?: number;
    start_date?: string;
    end_date?: string;
  },
): Promise<Transaction[]> {
  const all = await client.getAllPages<Transaction>("/v1/transactions", {
    status: "PROJECT",
    start_date: opts.start_date,
    end_date: opts.end_date,
  });
  return all.filter((t) => {
    if (!isProjectTransaction(t)) {
      return false;
    }
    if (
      opts.accounts_dimensions_id != null &&
      t.accounts_dimensions_id !== opts.accounts_dimensions_id
    ) {
      return false;
    }
    return true;
  });
}

async function loadOpenInvoices(client: EFinancialsClient): Promise<{
  sales: SalesInvoice[];
  purchases: PurchaseInvoice[];
}> {
  const [sales, purchases] = await Promise.all([
    client.getAllPages<SalesInvoice>("/v1/sale_invoices"),
    client.getAllPages<PurchaseInvoice>("/v1/purchase_invoices"),
  ]);
  return { sales, purchases };
}

async function loadBankContext(client: EFinancialsClient): Promise<{
  maps: ReturnType<typeof buildOwnBankMaps>;
  companyName?: string;
}> {
  const [bankAccounts, dimensions, invoiceInfo] = await Promise.all([
    client.getAllPages<BankAccounts>("/v1/bank_accounts"),
    client.getAllPages<AccountDimension>("/v1/account_dimensions"),
    client.get<{ company_name?: string }>("/v1/invoice_info").catch(() => ({})),
  ]);
  const maps = buildOwnBankMaps(bankAccounts, dimensions);
  const info = invoiceInfo as { company_name?: string };
  return {
    maps,
    companyName: info.company_name,
  };
}

const analyzeSchema = z.object({
  min_confidence: z.coerce.number().min(0).max(100).optional(),
  accounts_dimensions_id: optionalPositiveInt,
  start_date: optionalYmd,
  end_date: optionalYmd,
});

const reconcileSchema = z.object({
  mode: z.enum(["match", "auto_confirm", "transfers"]).optional(),
  execute: z.boolean().optional(),
  min_confidence: z.coerce.number().min(0).max(100).optional(),
  max_date_gap: z.coerce.number().int().min(0).max(31).optional(),
  target_accounts_dimensions_id: optionalPositiveInt,
  accounts_dimensions_id: optionalPositiveInt,
  start_date: optionalYmd,
  end_date: optionalYmd,
});

export function createBankReconciliationTools(client: EFinancialsClient) {
  return {
    analyze_unconfirmed_transactions: {
      description:
        "Read-only diagnostic for PROJECT bank transactions: suggest duplicates, inter-account transfers, invoice matches, small bank fees, or manual review. Free-tier counterpart to reconcile_bank_transactions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          min_confidence: {
            type: "number",
            description: "Minimum invoice-match confidence (default 40)",
          },
          accounts_dimensions_id: {
            type: "number",
            description: "Optional bank account dimension filter",
          },
          start_date: { type: "string", description: "YYYY-MM-DD" },
          end_date: { type: "string", description: "YYYY-MM-DD" },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(analyzeSchema, params);
        const minConfidence = args.min_confidence ?? 40;
        const projectTxs = await loadProjectTransactions(client, args);
        const [{ sales, purchases }, { maps, companyName }, journals] = await Promise.all([
          loadOpenInvoices(client),
          loadBankContext(client),
          client.getAllPages<Journal>("/v1/journals"),
        ]);
        expandOwnDimensionsFromTransactions(maps, projectTxs);
        const indexes = buildInvoiceIndexes(buildOpenInvoicePool(sales, purchases));

        const summary: Record<string, number> = {
          reimport_duplicate: 0,
          likely_duplicate: 0,
          inter_account: 0,
          confirm_invoice: 0,
          confirm_expense: 0,
          manual_review: 0,
        };
        const suggestions: unknown[] = [];

        for (const tx of projectTxs) {
          // Duplicate: same bank dimension/amount/date already in a registered journal
          const dupKeyCandidates = journals.filter((j) => {
            if (j.is_deleted || !j.registered) {
              return false;
            }
            return j.postings?.some(
              (p) =>
                p.accounts_dimensions_id === tx.accounts_dimensions_id &&
                Math.abs(p.amount - Math.abs(tx.amount)) < 0.02 &&
                j.effective_date === tx.date &&
                (p.type === tx.type || !p.type),
            );
          });
          if (dupKeyCandidates.length > 0) {
            const sharedRef = dupKeyCandidates.some(
              (j) =>
                tx.bank_ref_number && j.document_number && j.document_number === tx.bank_ref_number,
            );
            const action = sharedRef ? "reimport_duplicate" : "likely_duplicate";
            summary[action] += 1;
            suggestions.push({
              transaction_id: tx.id,
              suggested_action: action,
              confidence: sharedRef ? 95 : dupKeyCandidates.length > 1 ? 55 : 70,
              journal_ids: dupKeyCandidates.map((j) => j.id).filter((id) => id != null),
            });
            continue;
          }

          const counterIban = (tx.bank_account_no ?? "").replace(/\s+/g, "").toUpperCase();
          if (counterIban && maps.ownIbans.has(counterIban)) {
            const targetDim = maps.ibanToDimension.get(counterIban);
            const accountsId =
              targetDim != null ? maps.dimensionToAccountsId.get(targetDim) : undefined;
            summary.inter_account += 1;
            suggestions.push({
              transaction_id: tx.id,
              suggested_action: "inter_account",
              confidence: 90,
              distribution:
                accountsId != null && targetDim != null
                  ? buildAccountDistribution(tx, accountsId, targetDim)
                  : undefined,
            });
            continue;
          }

          const company = (companyName ?? "").trim().toLowerCase();
          const counterName = (tx.bank_account_name ?? "").trim().toLowerCase();
          if (company.length >= 4 && counterName.includes(company)) {
            summary.inter_account += 1;
            suggestions.push({
              transaction_id: tx.id,
              suggested_action: "inter_account",
              confidence: maps.ownDimensions.size === 2 ? 80 : 60,
            });
            continue;
          }

          const ranked = rankInvoiceMatches(
            tx,
            candidateInvoicesForTransaction(tx, indexes),
            minConfidence,
          );
          if (ranked.best) {
            summary.confirm_invoice += 1;
            suggestions.push({
              transaction_id: tx.id,
              suggested_action: "confirm_invoice",
              confidence: ranked.best.confidence,
              match_reasons: ranked.best.reasons,
              invoice_id: ranked.best.invoice.id,
              invoice_kind: ranked.best.invoice.kind,
              distribution: canAutoDistribute(ranked.best)
                ? buildInvoiceDistribution(tx, ranked.best.invoice)
                : undefined,
              manual_review_required: !canAutoDistribute(ranked.best),
            });
            continue;
          }

          if (tx.type === "D" && looksLikeBankFee(tx.description, tx.amount)) {
            summary.confirm_expense += 1;
            suggestions.push({
              transaction_id: tx.id,
              suggested_action: "confirm_expense",
              confidence: 60,
            });
            continue;
          }

          summary.manual_review += 1;
          suggestions.push({
            transaction_id: tx.id,
            suggested_action: "manual_review",
            confidence: 0,
          });
        }

        return toolResult({
          total_unconfirmed: projectTxs.length,
          summary,
          suggestions,
        });
      },
    },

    reconcile_bank_transactions: {
      description:
        "Mode-based bank reconciliation. mode=match (default): score PROJECT txs against open invoices. mode=auto_confirm: dry-run by default; with execute=true confirm unambiguous high-confidence invoice matches via register_transaction distributions. mode=transfers: dry-run by default; detect own-account transfers (execute confirms outgoing + deletes duplicate incoming). Our types: C=money in (sale invoices), D=money out (purchase invoices).",
      inputSchema: {
        type: "object" as const,
        properties: {
          mode: {
            type: "string",
            enum: ["match", "auto_confirm", "transfers"],
            description: "match | auto_confirm | transfers (default match)",
          },
          execute: {
            type: "boolean",
            description:
              "For auto_confirm/transfers: false (default) = dry-run; true = mutate via API",
          },
          min_confidence: {
            type: "number",
            description: "Match threshold (default 50; auto_confirm uses max(this, 90))",
          },
          max_date_gap: {
            type: "number",
            description: "Max days between transfer legs (default 1)",
          },
          target_accounts_dimensions_id: {
            type: "number",
            description: "Preferred target bank dimension for one-sided transfers",
          },
          accounts_dimensions_id: {
            type: "number",
            description: "Optional filter to one bank dimension",
          },
          start_date: { type: "string", description: "YYYY-MM-DD" },
          end_date: { type: "string", description: "YYYY-MM-DD" },
        },
      },
      handler: async (params: unknown) => {
        const args = parseToolArgs(reconcileSchema, params);
        const mode = args.mode ?? "match";
        const execute = args.execute === true;
        const minConfidence = args.min_confidence ?? 50;
        const maxDateGap = args.max_date_gap ?? 1;

        if (mode === "match" || mode === "auto_confirm") {
          const projectTxs = await loadProjectTransactions(client, args);
          const { sales, purchases } = await loadOpenInvoices(client);
          const indexes = buildInvoiceIndexes(buildOpenInvoicePool(sales, purchases));
          const threshold = mode === "auto_confirm" ? Math.max(minConfidence, 90) : minConfidence;
          const consumed = new Set<string>();
          const matches: unknown[] = [];
          const results: unknown[] = [];
          const errors: unknown[] = [];
          let confirmed = 0;
          let wouldConfirm = 0;

          for (const tx of projectTxs) {
            const ranked = rankInvoiceMatches(
              tx,
              candidateInvoicesForTransaction(tx, indexes),
              threshold,
            );
            if (!ranked.best) {
              if (mode === "match") {
                matches.push({
                  transaction_id: tx.id,
                  date: tx.date,
                  amount: tx.amount,
                  type: tx.type,
                  best_match: null,
                  other_candidate_count: 0,
                });
              }
              continue;
            }

            if (mode === "match") {
              const dist = canAutoDistribute(ranked.best)
                ? buildInvoiceDistribution(tx, ranked.best.invoice)
                : undefined;
              matches.push({
                transaction_id: tx.id,
                date: tx.date,
                amount: tx.amount,
                type: tx.type,
                best_match: {
                  invoice_id: ranked.best.invoice.id,
                  invoice_kind: ranked.best.invoice.kind,
                  confidence: ranked.best.confidence,
                  match_reasons: ranked.best.reasons,
                  partially_paid: ranked.best.partiallyPaid,
                  base_only_match: ranked.best.baseOnlyMatch,
                },
                other_candidate_count: ranked.otherCandidateCount,
                distribution: dist,
                manual_review_required: !dist,
              });
              continue;
            }

            // auto_confirm
            if (ranked.best.partiallyPaid || ranked.best.baseOnlyMatch) {
              errors.push({
                transaction_id: tx.id,
                reason: ranked.best.partiallyPaid ? "partially_paid" : "cross_currency_base_only",
              });
              continue;
            }
            if (ranked.allAboveThreshold.length !== 1) {
              errors.push({
                transaction_id: tx.id,
                reason: "ambiguous_or_missing",
                candidate_count: ranked.allAboveThreshold.length,
              });
              continue;
            }
            const key = invoiceConsumptionKey(ranked.best.invoice);
            if (consumed.has(key)) {
              errors.push({ transaction_id: tx.id, reason: "invoice_already_consumed", key });
              continue;
            }
            consumed.add(key);
            const distribution = buildInvoiceDistribution(tx, ranked.best.invoice);

            if (!execute) {
              wouldConfirm += 1;
              results.push({
                status: "would_confirm",
                transaction_id: tx.id,
                distribution,
                confidence: ranked.best.confidence,
              });
              continue;
            }

            try {
              if (!tx.clients_id && ranked.best.invoice.clients_id != null) {
                await client.patch(`/v1/transactions/${tx.id}`, {
                  clients_id: ranked.best.invoice.clients_id,
                });
              }
              await client.patch(`/v1/transactions/${tx.id}/register`, [distribution]);
              confirmed += 1;
              results.push({
                status: "confirmed",
                transaction_id: tx.id,
                distribution,
              });
            } catch (err) {
              errors.push({
                transaction_id: tx.id,
                reason: "register_failed",
                message: errorMessage(err),
              });
            }
          }

          if (mode === "match") {
            return toolResult({
              mode: "match",
              summary: {
                total_unconfirmed: projectTxs.length,
                matched: matches.filter((m) => (m as { best_match: unknown }).best_match != null)
                  .length,
                unmatched: matches.filter((m) => (m as { best_match: unknown }).best_match == null)
                  .length,
              },
              matches,
            });
          }

          return toolResult({
            mode: execute ? "EXECUTED" : "DRY_RUN",
            summary: {
              total_unconfirmed: projectTxs.length,
              would_confirm: wouldConfirm,
              confirmed,
              skipped: errors.length,
            },
            results,
            errors,
          });
        }

        // transfers
        const projectTxs = await loadProjectTransactions(client, args);
        const { maps, companyName } = await loadBankContext(client);
        expandOwnDimensionsFromTransactions(maps, projectTxs);
        const journals = await client.getAllPages<Journal>("/v1/journals");
        const journalKeys = indexInterAccountJournals(journals, maps);
        const { pairs, ambiguous } = findTransferPairs(projectTxs, maps, maxDateGap);
        const used = new Set<number>();
        const pairResults: unknown[] = [];
        const alreadyHandled: unknown[] = [];
        const errors: unknown[] = [];
        let wouldConfirm = 0;
        let confirmed = 0;
        let deleted = 0;

        for (const pair of pairs) {
          used.add(pair.outgoing.id);
          used.add(pair.incoming.id);
          if (
            isAlreadyJournalizedTransfer(
              pair.outgoing.accounts_dimensions_id,
              pair.targetDimensionId,
              Math.abs(pair.outgoing.amount),
              pair.outgoing.date,
              journalKeys,
            )
          ) {
            alreadyHandled.push({
              outgoing_id: pair.outgoing.id,
              incoming_id: pair.incoming.id,
              reason: "already_journalized",
            });
            continue;
          }
          const distribution = buildAccountDistribution(
            pair.outgoing,
            pair.targetAccountsId,
            pair.targetDimensionId,
          );
          if (!execute) {
            wouldConfirm += 1;
            pairResults.push({
              status: "would_confirm",
              outgoing_id: pair.outgoing.id,
              incoming_id: pair.incoming.id,
              incoming_action: "would_delete_duplicate",
              distribution,
              confidence: pair.confidence,
              reasons: pair.reasons,
            });
            continue;
          }
          try {
            if (!pair.outgoing.clients_id) {
              const clients = await client.getAllPages<Client>("/v1/clients");
              const company = clients.find(
                (c) =>
                  companyName && c.name.toLowerCase().includes(companyName.trim().toLowerCase()),
              );
              if (company) {
                await client.patch(`/v1/transactions/${pair.outgoing.id}`, {
                  clients_id: company.id,
                });
              }
            }
            await client.patch(`/v1/transactions/${pair.outgoing.id}/register`, [distribution]);
            confirmed += 1;
            try {
              await client.delete(`/v1/transactions/${pair.incoming.id}`);
              deleted += 1;
              pairResults.push({
                status: "confirmed",
                outgoing_id: pair.outgoing.id,
                incoming_id: pair.incoming.id,
                incoming_action: "deleted",
                distribution,
              });
            } catch {
              pairResults.push({
                status: "confirmed",
                outgoing_id: pair.outgoing.id,
                incoming_id: pair.incoming.id,
                incoming_action: "orphan",
                distribution,
              });
            }
          } catch (err) {
            errors.push({
              outgoing_id: pair.outgoing.id,
              reason: "register_failed",
              message: errorMessage(err),
            });
          }
        }

        const oneSided = findOneSidedTransfers(
          projectTxs,
          maps,
          companyName,
          args.target_accounts_dimensions_id,
          used,
        );
        const oneSidedResults: unknown[] = [];
        for (const side of oneSided) {
          if (
            isAlreadyJournalizedTransfer(
              side.transaction.accounts_dimensions_id,
              side.targetDimensionId,
              Math.abs(side.transaction.amount),
              side.transaction.date,
              journalKeys,
            )
          ) {
            alreadyHandled.push({
              transaction_id: side.transaction.id,
              reason: "already_journalized",
            });
            continue;
          }
          const distribution = buildAccountDistribution(
            side.transaction,
            side.targetAccountsId,
            side.targetDimensionId,
          );
          if (!execute) {
            wouldConfirm += 1;
            oneSidedResults.push({
              status: "would_confirm",
              transaction_id: side.transaction.id,
              distribution,
              confidence: side.confidence,
              reasons: side.reasons,
            });
            continue;
          }
          try {
            await client.patch(`/v1/transactions/${side.transaction.id}/register`, [distribution]);
            confirmed += 1;
            oneSidedResults.push({
              status: "confirmed",
              transaction_id: side.transaction.id,
              distribution,
            });
          } catch (err) {
            errors.push({
              transaction_id: side.transaction.id,
              reason: "register_failed",
              message: errorMessage(err),
            });
          }
        }

        return toolResult({
          mode: execute ? "EXECUTED" : "DRY_RUN",
          summary: {
            pairs: pairResults.length,
            one_sided: oneSidedResults.length,
            ambiguous: ambiguous.length,
            already_handled: alreadyHandled.length,
            would_confirm: wouldConfirm,
            confirmed,
            deleted,
            errors: errors.length,
          },
          pairs: pairResults,
          one_sided: oneSidedResults,
          ambiguous_pairs: ambiguous,
          already_handled: alreadyHandled,
          errors,
        });
      },
    },
  };
}
