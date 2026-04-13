export interface Account {
  id: number;
  name_est: string;
  name_eng: string;
  balance_type: string;
  account_type_est: string;
  account_type_eng: string;
  is_valid: boolean;
  is_vat_account: boolean;
  is_fixed_asset: boolean;
  priority: number;
  allows_deactivation: boolean;
  transaction_in_bindable: boolean;
  transaction_out_bindable: boolean;
  cl_account_groups: string[];
}

export interface AccountDimension {
  id: number;
  accounts_id: number;
  title_est: string;
  title_eng: string;
  cl_currencies_id: string;
}

export interface PurchaseArticle {
  id: number;
  level: number;
  name_est: string;
  name_eng: string;
  accounts_id: number;
  priority: number;
  cl_account_groups: string[];
}

/** Matches RIK OpenAPI `BankAccounts` (`id` read-only on create/update body). */
export interface BankAccounts {
  id?: number;
  account_name_est: string;
  account_name_eng?: string | null;
  account_no: string;
  cl_banks_id?: number | null;
  bank_name?: string | null;
  bank_regcode?: string | null;
  iban_code?: string | null;
  swift_code?: string | null;
  start_sum?: number | null;
  day_limit?: number | null;
  credit_limit?: number | null;
  show_in_sale_invoices?: boolean;
  default_salary_account?: boolean;
  beneficiary_name?: string | null;
}

export interface VatInfo {
  vat_number: string;
  tax_refnumber: string;
}

export interface Project {
  id: number;
  name: string;
  code: string;
  is_active: boolean;
}
