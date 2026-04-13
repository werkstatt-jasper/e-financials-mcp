/** Active currency row from GET `/v1/currencies`. */
export interface Currency {
  id: string;
  name_est: string;
  name_eng: string;
}

/** Sale article row from GET `/v1/sale_articles`. */
export interface SaleArticle {
  id: number;
  group_est: string;
  group_eng: string;
  name_est: string;
  name_eng: string;
  accounts_id: number;
  vat_type: number;
  is_valid: boolean;
  cl_account_groups: string[];
  description_est?: string | null;
  description_eng?: string | null;
  vat_rate?: number | null;
  vat_accounts_id?: number | null;
  priority?: number;
  start_date?: string | null;
  end_date?: string | null;
}

/** Sale invoice template row from GET `/v1/templates`. */
export interface InvoiceTemplate {
  id: number;
  name: string;
  is_default: boolean;
  cl_languages_id: string;
  cl_account_groups?: string | string[];
}
