/** RIK OpenAPI `CompanyInvoiceInfo` (company invoice settings). */
export interface CompanyInvoiceInfo {
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  fax?: string | null;
  webpage?: string | null;
  cl_templates_id?: number | null;
  invoice_company_name?: string | null;
  invoice_email_subject?: string | null;
  invoice_email_body?: string | null;
  balance_email_subject?: string | null;
  balance_email_body?: string | null;
  balance_document_footer?: string | null;
}

/** RIK OpenAPI `InvoiceSeries`. `id` is read-only from the API. */
export interface InvoiceSeries {
  id?: number;
  is_active: boolean;
  is_default: boolean;
  number_prefix: string;
  number_start_value: number;
  term_days: number;
  overdue_charge?: number | null;
}
