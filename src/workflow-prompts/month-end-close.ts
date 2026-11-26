import { z } from "zod";
import { monthToDateRange } from "../tools/month-end-close.js";
import {
  definePrompt,
  formatProvidedArgs,
  WORKFLOW_GUARDRAILS,
  yearMonthString,
} from "./shared.js";

const monthEndCloseSchema = z.object({
  month: yearMonthString,
});

export const monthEndClosePrompt = definePrompt(
  "Run the month-end close checklist, work through blockers, and prepare financial statements for a YYYY-MM month.",
  monthEndCloseSchema,
  (args) => {
    const { dateFrom, dateTo } = monthToDateRange(args.month);
    const fiscalYearStart = `${args.month.slice(0, 4)}-01-01`;
    return `Run a month-end close for ${args.month} using the e-Financials tools.

${WORKFLOW_GUARDRAILS}

${formatProvidedArgs(args)}
- Period: ${dateFrom} to ${dateTo}
- Year to date: ${fiscalYearStart} to ${dateTo}

Use these dates as \`date_from\` / \`date_to\` (or \`start_date\` / \`end_date\`) on follow-up tools.

## Step 1 — Checklist
Call \`month_end_close_checklist\` with \`month\` ${args.month}. Treat its counts and entity IDs as the work list. \`ready_to_close\` is true only when unconfirmed journals, invoices, and bank transactions are empty; overdue receivables or payables do not block the close, but they must appear in the summary.

## Step 2 — Work through blockers (no silent confirmation)
For each unconfirmed item, load the record (\`get_journal\`, \`get_sales_invoice\`, \`get_purchase_invoice\`, \`get_transaction\`) and tell the user what is still in PROJECT / draft status. Propose a next action, but do not call \`register_journal\`, \`register_sales_invoice\`, \`register_purchase_invoice\`, or \`register_transaction\` until the user explicitly approves that item.

## Step 3 — Missing source documents
If \`find_missing_documents\` is in the tool list, run it for this period and attach the result to the summary. If it is missing, note that a document audit is not available yet and continue.

## Step 4 — Duplicate invoices
Review sales and purchase invoices in the period with \`list_sales_invoices\` and \`list_purchase_invoices\`. Flag same supplier or customer, date, number, or amount. If a dedicated duplicate-detection tool is listed, use it. Ask the user before deleting or invalidating anything.

## Step 5 — Financial statements
Call \`compute_trial_balance\`, \`compute_balance_sheet\`, and \`compute_profit_and_loss\` for the month (${dateFrom} to ${dateTo}). \`compute_profit_and_loss\` requires both dates. Optionally also produce a year-to-date view (${fiscalYearStart} to ${dateTo}). If a statement tool refuses a load because the journal page cap was hit, narrow the dates and retry.

## Step 6 — Summary
Report whether the month is ready to close, the remaining unconfirmed items (with ids), overdue receivables and payables, missing-document status, duplicate flags, and the statement totals. Do not close or register anything as part of the summary.
`;
  },
);
