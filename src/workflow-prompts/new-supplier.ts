import { z } from "zod";
import { definePrompt, formatProvidedArgs, WORKFLOW_GUARDRAILS } from "./shared.js";

const newSupplierSchema = z.object({
  identifier: z
    .string()
    .min(1)
    .describe("Supplier name or 8-digit Estonian business registry code."),
});

export function identifierKind(identifier: string): "registry_code" | "name" {
  return /^\d{8}$/.test(identifier.trim()) ? "registry_code" : "name";
}

export const newSupplierPrompt = definePrompt(
  "Look up an existing supplier or, after approval, create a new supplier client from a name or Estonian registry code.",
  newSupplierSchema,
  (args) => {
    const kind = identifierKind(args.identifier);
    const kindLabel =
      kind === "registry_code"
        ? "8-digit Estonian business registry code"
        : "supplier name (not an 8-digit registry code)";
    return `Create or locate a supplier client from the given identifier using the e-Financials tools.

${WORKFLOW_GUARDRAILS}

${formatProvidedArgs(args)}
- Identifier interpretation: ${kindLabel}

## Step 1 — Search for an existing client first
Treat an 8-digit identifier as \`reg_code\` and anything else as a name (the user may still paste a VAT number or IBAN — search those too). If \`find_client_by_code\` or \`resolve_supplier\` is in the tool list, call it with auto-create turned off. Always also search with \`search_clients\` (try \`is_supplier: true\`) and \`list_suppliers\`, and load candidates with \`get_client\`. If a match already exists, report the client id and details and stop — do not create a duplicate.

## Step 2 — Gather official details
If \`resolve_supplier\` can look up registry data, use it. Otherwise ask the user for the legal name, registry code, VAT number, address, country, email, phone, and IBAN as needed. For an Estonian natural person, \`is_physical_entity\` must be true; an empty \`reg_code\` alone is not enough.

## Step 3 — Preview and approval gate
Present the \`create_client\` payload you would send, including \`name\`, \`is_supplier: true\`, and any of \`reg_code\`, \`vat_no\`, \`address\`, \`city\`, \`postal_code\`, \`country_code\`, \`email\`, \`phone\`, \`bank_account\`, \`bank_name\`, \`payment_term_days\`, and \`is_physical_entity\`. Do not call \`create_client\` until the user explicitly approves this payload. Never pass auto-create flags on a lookup tool without that approval.

## Step 4 — Create and report
After approval, call \`create_client\` and report the new client id, name, and supplier flags. If creation fails because of a conflict, fetch the existing client and report that instead of retrying blindly.
`;
  },
);
