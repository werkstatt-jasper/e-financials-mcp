import { z } from "zod";
import { definePrompt, formatProvidedArgs, WORKFLOW_GUARDRAILS } from "./shared.js";

const companyOverviewSchema = z.object({});

export const companyOverviewPrompt = definePrompt(
  "Build a read-only dashboard of the company's current financial state: VAT context, period summary, statements, aging, and unprocessed items.",
  companyOverviewSchema,
  (args) => `Prepare a read-only company overview using the e-Financials tools.

${WORKFLOW_GUARDRAILS}

${formatProvidedArgs(args)}

This workflow must not create, update, register, or delete anything. Default the period to the current calendar month and also offer a year-to-date view, unless the user names another range. Use \`date_from\` / \`date_to\` on statement tools and \`as_of_date\` (or today UTC) on aging tools. If a report tool is missing, skip it and say so.

## Step 1 — Company and VAT context
Call \`get_vat_info\`. Mention whether a VAT number is present so later figures can be read in context.

## Step 2 — Period summary
Call \`financial_summary\` for the current month (or the month the user named). Note transaction counts, invoice totals, and outstanding amounts.

## Step 3 — Statements
Call \`compute_trial_balance\`, \`compute_balance_sheet\`, and \`compute_profit_and_loss\` for the month, and again year-to-date if that is still a reasonable range. \`compute_profit_and_loss\` requires both \`date_from\` and \`date_to\`. If a tool refuses a load because the journal page cap was hit, narrow the dates and retry.

## Step 4 — Receivables and payables
Call \`compute_receivables_aging\` and \`compute_payables_aging\`. Also call \`list_unpaid_invoices\` if you need invoice-level follow-up ids. Highlight overdue buckets; do not treat overdue amounts as month-end close blockers by themselves.

## Step 5 — Unprocessed bank activity
Call \`get_unprocessed_transactions\` and/or list PROJECT transactions. Summarize counts and amounts that still need reconciliation or classification, and point the user at \`reconcile-bank\` or \`classify-unmatched\` when relevant.

## Step 6 — Dashboard
Present a compact overview: VAT context, P&L and balance-sheet highlights, outstanding A/R and A/P, unprocessed bank items, and suggested next workflows. No mutations.
`,
);
