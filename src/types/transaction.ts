export interface Transaction {
  id: number;
  accounts_id: number;
  accounts_dimensions_id: number;
  clients_id: number | null;
  bank_accounts_id: number;
  bank_ref_number: string;
  bank_subtype: string;
  type: "C" | "D"; // C = Credit (money in), D = Debit (money out)
  bank_account_no: string | null;
  bank_account_name: string | null;
  ref_number: string | null;
  amount: number;
  cl_currencies_id: string;
  description: string;
  date: string;
  status: "PROJECT" | "CONFIRMED" | "VOID";
  is_deleted: boolean;
  currency_rate: number;
  base_amount: number;
}

export interface ListTransactionsParams {
  status?: "PROJECT" | "CONFIRMED" | "VOID";
  modified_since?: string;
  start_date?: string;
  end_date?: string;
  bank_accounts_id?: number;
  type?: "C" | "D";
  clients_id?: number;
  page?: number;
}

export interface UpdateTransactionParams {
  clients_id?: number;
  accounts_id?: number;
  description?: string;
}

/** OpenAPI `TransactionsDistribution` — one row in the register payload (`TransactionsDistributions`). */
export interface TransactionDistributionRow {
  related_table: string;
  amount: number;
  related_id?: number;
  related_sub_id?: number;
}

/** Writable fields for POST `/v1/transactions` (OpenAPI `Transactions`; read-only fields omitted). */
export interface CreateTransactionParams {
  accounts_dimensions_id: number;
  type: "C" | "D";
  amount: number;
  cl_currencies_id: string;
  date: string;
  clients_id?: number;
  description?: string;
  ref_number?: string;
  bank_account_name?: string;
  base_amount?: number;
  currency_rate?: number;
  transactions_files_id?: number;
  export_format?: string;
}
