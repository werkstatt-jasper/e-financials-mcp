import { z } from "zod";
import { definePrompt, formatProvidedArgs, WORKFLOW_GUARDRAILS } from "./shared.js";

const bookInvoiceSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path to the invoice document (PDF, JPG, or PNG)."),
});

export const bookInvoicePrompt = definePrompt(
  "Book a purchase invoice from a source document: extract or collect the fields, validate totals, resolve the supplier, preview the booking, and create plus register the invoice only after approval.",
  bookInvoiceSchema,
  (args) => `Book a purchase invoice from the source document using the e-Financials tools.

${WORKFLOW_GUARDRAILS}

${formatProvidedArgs(args)}

## Step 1 — Company VAT context
Call \`get_vat_info\` so later VAT choices can follow whether the company is VAT-registered.

## Step 2 — Collect invoice fields
If an extraction or OCR tool (for example \`extract_pdf_invoice\`) is in the tool list, run it on \`file_path\` and use its structured fields as the starting point. If that tool is missing or env-gated off, do not stop: ask the user to supply the invoice number, invoice date, due date, currency, supplier name, registry or VAT number, line items (description, quantity, unit price, VAT rate), and net / VAT / gross totals from the document at \`file_path\`.

## Step 3 — Validate totals
Call \`validate_invoice_data\` with the collected fields. Resolve every warning or error with the user before creating anything. Do not invent amounts to make the totals match.

## Step 4 — Resolve the supplier (do not create yet)
Prefer \`resolve_supplier\` if it is listed, with auto-create turned off. Otherwise search with \`search_clients\` (try \`is_supplier: true\`) and \`list_suppliers\`, and load candidates with \`get_client\`. Match on registry code, VAT number, IBAN, and name. If several records could be the same supplier, ask the user which one to use. Do not create a client in this step.

## Step 5 — Duplicate check
Call \`list_purchase_invoices\` (and \`get_purchase_invoice\` as needed) and look for an existing invoice with the same supplier, invoice number, date, and amount. If a likely duplicate appears, stop and ask the user whether to continue. If a dedicated duplicate-detection tool is listed, use that as well.

## Step 6 — Booking setup
If \`suggest_booking\` is listed, call it with the chosen \`clients_id\` (and the invoice description) and prefer confirmed purchase-invoice history. If it is not listed, inspect recent \`list_purchase_invoices\` for that supplier and call \`list_purchase_articles\` (and account dimensions if needed). Never invent a VAT rate, \`reversed_vat_id\`, or purchase article when history does not support it — ask the user instead.

## Step 7 — Preview and approval gate
Present a complete preview: supplier (existing id or the \`create_client\` payload with \`is_supplier: true\`), invoice dates and number, currency (and \`currency_rate\` when not EUR), line items, VAT treatment, and net / VAT / gross totals. Do not call any create or register tool until the user explicitly approves this preview.

## Step 8 — Create after approval
If a new supplier is required, call \`create_client\` with the approved payload first (Estonian private persons need \`is_physical_entity: true\`; empty \`reg_code\` alone is not enough). Then call \`create_purchase_invoice\` with the approved lines and headers. If useful, attach the source file with \`upload_purchase_invoice_file\`.

## Step 9 — Register after a second approval
Show the created draft (use \`get_purchase_invoice\`) and ask for explicit approval before \`register_purchase_invoice\`. Report the resulting invoice id, status, and any remaining warnings. Do not register automatically.
`,
);
