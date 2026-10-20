/**
 * RIK OpenAPI `Journals.operation_type` enum (spec changelog 22.06.2026).
 * `INITIAL` is the opening-balance entry (UI: Algbilansi kanne); `ENTRY` is a manual entry.
 */
export const JOURNAL_OPERATION_TYPES = [
  "ENTRY",
  "INITIAL",
  "NORMAL",
  "CLOSING",
  "TRANSACTION",
  "SETTLEMENT",
  "PURCHASE_INVOICE",
  "PURCHASE_INVOICE_PERIOD",
  "SALE_INVOICE",
  "SALE_INVOICE_PERIOD",
  "SALE_INVOICE_DOUBTFUL",
  "SALE_INVOICE_HOPELESS",
  "SALARY_PAYMENT",
  "SALARY_PAYMENT_MINOBLIGATION",
  "EMTA_PREPAYMENT",
  "EMTA_VAT_DECLARATION",
  "FIXED_ASSET_AMORTIZATION",
  "FIXED_ASSET_WRITEOFF",
  "FIXED_ASSET",
  "COMBINED_FIXED_ASSET",
  "YEAR_CLOSING",
] as const;

export type JournalOperationType = (typeof JOURNAL_OPERATION_TYPES)[number];

/** RIK OpenAPI `Postings.type` enum: debit or credit. */
export type PostingType = "C" | "D";

/** RIK OpenAPI `Postings` (journal line). */
export interface Posting {
  id?: number;
  /** Read-only since the 08.05.2026 spec; never sent on create or update. */
  journals_id?: number;
  accounts_id: number;
  accounts_dimensions_id?: number | null;
  /** `C` or `D` per the spec; `string` kept so existing callers still compile. */
  type?: PostingType | (string & {});
  amount: number;
  base_amount?: number;
  cl_currencies_id?: string;
  projects_project_id?: number | null;
  projects_location_id?: number | null;
  projects_person_id?: number | null;
  is_deleted?: boolean;
}

/** RIK OpenAPI `Journals` (journal entry). */
export interface Journal {
  id?: number;
  parent_id?: number | null;
  clients_id?: number | null;
  subclients_id?: number | null;
  number?: number;
  amendment_number?: number;
  title?: string;
  effective_date: string;
  registered?: boolean;
  operations_id?: number;
  /** One of {@link JOURNAL_OPERATION_TYPES}; `string` kept so existing callers still compile. */
  operation_type?: JournalOperationType | (string & {});
  document_number?: string | null;
  cl_currencies_id?: string;
  currency_rate?: number;
  base_document_files_id?: number | null;
  is_xls_imported?: boolean;
  is_deleted?: boolean;
  /** Date the entry was registered (read-only). */
  register_date?: string | null;
  postings: Posting[];
}

/** RIK OpenAPI `ApiFile` for user document upload/download. */
export interface ApiFile {
  name: string;
  contents: string;
}
