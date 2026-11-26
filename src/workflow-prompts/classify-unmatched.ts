import { z } from "zod";
import { optionalPositiveInt, optionalYmd } from "../validation/tool-args.js";
import {
  definePrompt,
  formatProvidedArgs,
  missingDimensionHint,
  WORKFLOW_GUARDRAILS,
  withDateRangeOrder,
} from "./shared.js";

const classifyUnmatchedObjectSchema = z.object({
  accounts_dimensions_id: optionalPositiveInt.describe(
    "Optional bank account dimension ID used when classifying transactions. If omitted, list dimensions and ask the user to confirm the account.",
  ),
  date_from: optionalYmd.describe("Optional inclusive transaction start date (YYYY-MM-DD)."),
  date_to: optionalYmd.describe("Optional inclusive transaction end date (YYYY-MM-DD)."),
});

export const classifyUnmatchedPrompt = definePrompt(
  "Classify unmatched bank transactions, preview generated purchase-invoice bookings, and apply them only after approval.",
  classifyUnmatchedObjectSchema,
  (args) => `Classify unmatched PROJECT bank transactions and apply bookings only after approval.

${WORKFLOW_GUARDRAILS}

${formatProvidedArgs(args)}
${missingDimensionHint(args.accounts_dimensions_id)}
Map prompt \`date_from\` / \`date_to\` to the tool's \`start_date\` / \`end_date\` parameters. If \`classify_bank_transactions\` is missing, explain that classification and apply modes need Pro (or a trial) and stop after that explanation.

## Step 1 — Classify
Call \`classify_bank_transactions\` with \`mode=classify\` (the default). Groupings are by counterparty / pattern (bank fees, SaaS, card purchases, tax, owner transfers, salary, revenue, unknown). Keep tax, owner, salary, and revenue groups on the needs-review list — they are review-only.

## Step 2 — Explain what can be applied
For each group, show the category, transaction ids, and any \`suggested_booking\`. Auto-apply only where the tool already has concrete supplier-history (or built-in bank-fee defaults). Never invent a VAT rate or purchase article for a weak or empty suggestion; leave those groups for review. You may use \`update_transaction\` only for non-mutating clarifications the user asked for, not as a silent booking shortcut.

## Step 3 — Dry-run
Call \`classify_bank_transactions\` with \`mode=dry_run_apply\`, passing \`groups\` from the classify result when you have them. Preview the purchase invoices and transaction confirmations that would be created. Do not send \`execute_apply\` yet.

## Step 4 — Approval gate
Walk the user through the dry-run. Let them drop or edit groups before anything is written. Do not apply review-only groups unless the user supplies an explicit booking and approves it.

## Step 5 — Execute
After approval, call \`classify_bank_transactions\` with \`mode=execute_apply\` and the approved \`groups\`. Report created invoice ids, confirmed transaction ids, and failures. Do not retry failed groups with guessed VAT or articles.
`,
  withDateRangeOrder(classifyUnmatchedObjectSchema),
);
