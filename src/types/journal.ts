/** RIK OpenAPI `Postings` (journal line). */
export interface Posting {
  id?: number;
  journals_id?: number;
  accounts_id: number;
  accounts_dimensions_id?: number | null;
  type?: string;
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
  operation_type?: string;
  document_number?: string | null;
  cl_currencies_id?: string;
  currency_rate?: number;
  base_document_files_id?: number | null;
  is_xls_imported?: boolean;
  is_deleted?: boolean;
  postings: Posting[];
}

/** RIK OpenAPI `ApiFile` for user document upload/download. */
export interface ApiFile {
  name: string;
  contents: string;
}
