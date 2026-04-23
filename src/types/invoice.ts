export interface InvoiceRow {
  description: string;
  quantity: number;
  unit_price: number;
  products_id?: number;
  vat_rate_id?: number;
  accounts_id?: number;
}

export interface SalesInvoice {
  id: number;
  invoice_no: string;
  clients_id: number;
  client_name: string;
  invoice_date: string;
  due_date: string;
  total_amount: number;
  vat_amount: number;
  cl_currencies_id: string;
  status: "PROJECT" | "CONFIRMED" | "VOID";
  payment_status: "NOT_PAID" | "PARTIALLY_PAID" | "PAID";
  rows: InvoiceRow[];
}

export interface PurchaseInvoice {
  id: number;
  invoice_no: string;
  clients_id: number;
  supplier_name: string;
  invoice_date: string;
  due_date: string;
  total_amount: number;
  vat_amount: number;
  cl_currencies_id: string;
  status: "PROJECT" | "CONFIRMED" | "VOID";
  payment_status: "NOT_PAID" | "PARTIALLY_PAID" | "PAID";
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
