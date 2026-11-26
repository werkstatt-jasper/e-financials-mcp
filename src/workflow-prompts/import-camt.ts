import { z } from "zod";
import { optionalPositiveInt, optionalYmd } from "../validation/tool-args.js";
import {
  definePrompt,
  formatProvidedArgs,
  missingDimensionHint,
  WORKFLOW_GUARDRAILS,
  withDateRangeOrder,
} from "./shared.js";

const importCamtObjectSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe(
      "Filesystem path to the CAMT.053 XML file, or a base64: / base64:xml: payload as accepted by process_camt053.",
    ),
  accounts_dimensions_id: optionalPositiveInt.describe(
    "Optional bank account dimension ID. Required by the tool for dry_run and execute; if omitted, list dimensions and ask the user to confirm the account.",
  ),
  date_from: optionalYmd.describe("Optional inclusive statement-entry start date (YYYY-MM-DD)."),
  date_to: optionalYmd.describe("Optional inclusive statement-entry end date (YYYY-MM-DD)."),
});

export const importCamtPrompt = definePrompt(
  "Parse a CAMT.053 bank statement, preview the import as a dry run, and create PROJECT transactions only after approval.",
  importCamtObjectSchema,
  (args) => `Import a CAMT.053 bank statement using \`process_camt053\`.

${WORKFLOW_GUARDRAILS}

${formatProvidedArgs(args)}
${missingDimensionHint(args.accounts_dimensions_id)}
Pass \`file_path\` through to the tool as given (filesystem path or \`base64:\` / \`base64:xml:\` payload). If \`process_camt053\` is missing, explain that CAMT import is a Pro (or trial) batch-write capability and stop after that explanation.

## Step 1 — Parse
Call \`process_camt053\` with \`mode=parse\` and the given file and optional date filters. Summarize statement metadata, entry counts, currencies, and any parse problems. This step is read-only.

## Step 2 — Dry-run
Once \`accounts_dimensions_id\` is known, call \`process_camt053\` with \`mode=dry_run\` (do not use \`execute\` yet). Review would-create rows, skipped duplicates (bank reference / prior import markers), and errors. Point out rows that may need a direction check (\`direction_confirmed\` / \`direction_unconfirmed_count\`) before later registration.

## Step 3 — Approval gate
Show the dry-run summary and wait for explicit approval. Do not create transactions if the user declines or wants a narrower date range — adjust filters and dry-run again instead.

## Step 4 — Execute
After approval, call \`process_camt053\` with \`mode=execute\`, the same \`accounts_dimensions_id\`, file, and date filters. Report created, skipped, and error counts with ids. Leave the new rows as PROJECT drafts; do not call \`register_transaction\` as part of this import.
`,
  withDateRangeOrder(importCamtObjectSchema),
);
