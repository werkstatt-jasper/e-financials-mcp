import type { PromptRecord } from "../prompts.js";
import { bookInvoicePrompt } from "./book-invoice.js";
import { classifyUnmatchedPrompt } from "./classify-unmatched.js";
import { companyOverviewPrompt } from "./company-overview.js";
import { importCamtPrompt } from "./import-camt.js";
import { monthEndClosePrompt } from "./month-end-close.js";
import { newSupplierPrompt } from "./new-supplier.js";
import { reconcileBankPrompt } from "./reconcile-bank.js";

/** Guided multi-step accounting workflows registered next to getting-started. */
export const WORKFLOW_PROMPTS: PromptRecord = {
  "book-invoice": bookInvoicePrompt,
  "month-end-close": monthEndClosePrompt,
  "reconcile-bank": reconcileBankPrompt,
  "import-camt": importCamtPrompt,
  "classify-unmatched": classifyUnmatchedPrompt,
  "new-supplier": newSupplierPrompt,
  "company-overview": companyOverviewPrompt,
};

export const WORKFLOW_PROMPT_NAMES = [
  "book-invoice",
  "month-end-close",
  "reconcile-bank",
  "import-camt",
  "classify-unmatched",
  "new-supplier",
  "company-overview",
] as const;
