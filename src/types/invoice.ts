export interface InvoiceRow {
  description: string;
  quantity: number;
  unit_price: number;
  products_id?: number;
  vat_rate_id?: number;
  accounts_id?: number;
}

/**
 * Live API list/detail items carry `gross_price`/`net_price`, `number`,
 * `create_date`/`journal_date`, and `term_days`; `payment_status` is null on
 * drafts. The `invoice_no`/`invoice_date`/`due_date`/`total_amount` names are
 * legacy aliases kept optional for fixtures and older integrations.
 */
export interface SalesInvoice {
  id: number;
  number?: string | null;
  number_prefix?: string | null;
  number_suffix?: string | null;
  clients_id: number;
  client_name: string;
  create_date?: string | null;
  journal_date?: string | null;
  term_days?: number | null;
  net_price?: number | null;
  gross_price?: number | null;
  cl_currencies_id: string;
  status: "PROJECT" | "CONFIRMED" | "VOID";
  payment_status: "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | null;
  rows?: InvoiceRow[];
  // Legacy aliases (not returned by the live API)
  invoice_no?: string;
  invoice_date?: string;
  due_date?: string;
  total_amount?: number;
  vat_amount?: number;
}

export interface PurchaseInvoice {
  id: number;
  number?: string | null;
  clients_id: number;
  /** The live API uses `client_name` for the supplier on purchase invoices. */
  client_name?: string;
  create_date?: string | null;
  journal_date?: string | null;
  term_days?: number | null;
  net_price?: number | null;
  gross_price?: number | null;
  vat_price?: number | null;
  cl_currencies_id: string;
  status: "PROJECT" | "CONFIRMED" | "VOID";
  payment_status: "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | null;
  // Legacy aliases (not returned by the live API)
  invoice_no?: string;
  supplier_name?: string;
  invoice_date?: string;
  due_date?: string;
  total_amount?: number;
  vat_amount?: number;
}

export interface CreateSalesInvoiceParams {
  clients_id: number;
  invoice_date: string;
  due_date: string;
  rows: InvoiceRow[];
  cl_currencies_id?: string;
  description?: string;
  sale_invoice_type?: string;
  cl_templates_id?: number;
  cl_countries_id?: string;
  show_client_balance?: boolean;
  number_suffix?: string;
}

export interface CreatePurchaseInvoiceParams {
  clients_id: number;
  client_name: string;
  invoice_no: string;
  invoice_date: string;
  term_days?: number;
  total_amount: number;
  vat_amount?: number;
  cl_currencies_id?: string;
  description?: string;
  purchase_article_id?: number;
  purchase_accounts_dimensions_id?: number;
  vat_rate?: number;
  vat_accounts_id?: number;
  reversed_vat_id?: number;
}
