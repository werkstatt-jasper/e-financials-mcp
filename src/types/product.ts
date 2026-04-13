/** Matches RIK OpenAPI `Products` (read-only: id, sale_accounts_id, purchase_accounts_id). */
export interface Product {
  id?: number;
  name: string;
  code: string;
  foreign_names?: Record<string, string>;
  cl_sale_articles_id?: number | null;
  sale_accounts_id?: number | null;
  sale_accounts_dimensions_id?: number | null;
  cl_purchase_articles_id?: number | null;
  purchase_accounts_id?: number | null;
  purchase_accounts_dimensions_id?: number | null;
  description?: string | null;
  sales_price?: number | null;
  net_price?: number | null;
  price_currency?: string;
  notes?: string | null;
  translations?: Record<string, string>;
  activity_text?: string | null;
  emtak_code?: string | null;
  emtak_version?: string | null;
  unit?: string | null;
  amount?: number | null;
  is_deleted?: boolean;
}
