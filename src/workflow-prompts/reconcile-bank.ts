import { z } from "zod";
import { optionalPositiveInt, optionalYmd } from "../validation/tool-args.js";
import {
  definePrompt,
  formatProvidedArgs,
  missingDimensionHint,
  WORKFLOW_GUARDRAILS,
} from "./shared.js";

const reconcileBankObjectSchema = z.object({
  mode: z
    .enum(["auto", "review", "transaction"])
    .optional()
    .describe('Reconciliation mode: "auto" (default), "review", or "transaction".'),
  transaction_id: optionalPositiveInt.describe(
    'Specific bank transaction ID when mode is "transaction".',
  ),
  accounts_dimensions_id: optionalPositiveInt.describe(
    "Optional bank account dimension ID. If omitted, list dimensions and ask the user to confirm the account.",
  ),
  date_from: optionalYmd.describe("Optional inclusive start date (YYYY-MM-DD)."),
  date_to: optionalYmd.describe("Optional inclusive end date (YYYY-MM-DD)."),
});

const reconcileBankSchema = reconcileBankObjectSchema.superRefine((value, ctx) => {
  if (value.date_from && value.date_to && value.date_from > value.date_to) {
    ctx.addIssue({
      code: "custom",
      message: "date_from must be on or before date_to",
      path: ["date_from"],
    });
  }
  if (value.mode === "transaction" && value.transaction_id == null) {
    ctx.addIssue({
      code: "custom",
      message: "transaction_id is required when mode is transaction",
      path: ["transaction_id"],
    });
  }
});

export const reconcileBankPrompt = definePrompt(
  "Match unconfirmed bank transactions to invoices, optionally auto-confirm unambiguous exact matches, and surface inter-account transfers — dry-run first, mutate only after approval.",
  reconcileBankObjectSchema,
  (args) => {
    const selectedMode = args.mode ?? "auto";
    return `Reconcile unconfirmed bank transactions using the e-Financials tools.

${WORKFLOW_GUARDRAILS}

${formatProvidedArgs(args)}
- Selected mode: ${selectedMode}
${missingDimensionHint(args.accounts_dimensions_id)}
Map prompt \`date_from\` / \`date_to\` to the tools' \`start_date\` / \`end_date\` parameters.

## Step 1 — Read-only diagnosis
Call \`analyze_unconfirmed_transactions\` first (read-only, free-tier). Then call \`reconcile_bank_transactions\` with \`mode=match\` (and \`execute\` omitted or false). Our transaction types are \`C\` for money in (sale invoices) and \`D\` for money out (purchase invoices). If \`reconcile_bank_transactions\` is missing because of plan gating, explain that auto-confirm and transfer execution need Pro (or a trial), and continue with the analyze results only.

## Step 2 — Present candidates
Show matches with amounts, dates, counterparties, invoice ids, confidence, and \`match_reasons\`. Flag close-amount / partially-paid warnings and anything marked for manual review. Do not register a transaction yet.

## Step 3 — Follow the selected mode (${selectedMode})
### auto (default)
Also call \`reconcile_bank_transactions\` with \`mode=transfers\` and \`mode=auto_confirm\`, both with \`execute\` omitted or false (dry-run). After the user approves, set \`execute=true\` only for unambiguous high-confidence invoice matches and unambiguous transfer pairs. If two targets tie, report the ambiguity and skip — never guess. Leave close-amount and manual-review items for the user.

### review
Walk the user through the match list. Confirm or skip each item only after they decide. You may use \`mode=auto_confirm\` or \`mode=transfers\` with \`execute=true\` for the rows they approved, never for the whole set by default.

### transaction
Limit every call and every summary to bank transaction id ${args.transaction_id ?? "(ask the user for `transaction_id`)"}. Load it with \`get_transaction\` and apply the same dry-run-then-approve rule.

## Step 4 — Inter-account transfers
Use \`reconcile_bank_transactions\` \`mode=transfers\` (dry-run first). If a target dimension is needed for a one-sided transfer, ask the user or use \`target_accounts_dimensions_id\` when they provided one.

## Step 5 — Still unmatched
Point the user at the \`classify-unmatched\` prompt (and \`classify_bank_transactions\`) for leftover PROJECT transactions that have no invoice match.

## Step 6 — Summary
Report confirmed, would-confirm, skipped, ambiguous, and still-unmatched counts with transaction ids. Include any \`execute=true\` results only after approval.
`;
  },
  reconcileBankSchema,
);
