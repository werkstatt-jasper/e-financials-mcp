export interface Client {
  id: number;
  name: string;
  reg_code: string | null;
  vat_no: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
  is_buyer: boolean;
  is_supplier: boolean;
  is_active: boolean;
  bank_account: string | null;
  bank_name: string | null;
  payment_term_days: number | null;
}

export interface CreateClientParams {
  name: string;
  reg_code?: string;
  vat_no?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  country_code?: string;
  is_buyer?: boolean;
  is_supplier?: boolean;
  bank_account?: string;
  bank_name?: string;
  payment_term_days?: number;
}

export interface CreateClientAPIParams {
  name: string;
  code?: string;
  invoice_vat_no?: string;
  email?: string;
  telephone?: string;
  address_text?: string;
  cl_code_country: string;
  is_client: boolean;
  is_supplier: boolean;
  bank_account_no?: string;
  invoice_days?: number;
  is_juridical_entity?: boolean;
  is_physical_entity?: boolean;
  is_member: boolean;
  send_invoice_to_email: boolean;
  send_invoice_to_accounting_email: boolean;
}
