import { EFinancialsApiError } from "../api-error.js";

export type RegisterInvoiceKind = "sale" | "purchase";

/** Plain-language next step for a 409 on PATCH /{sale,purchase}_invoices/{id}/register. */
export function registerConflictHint(kind: RegisterInvoiceKind, id: number): string {
  const article = kind === "sale" ? "sale article" : "purchase article";
  const articles = kind === "sale" ? "list_sale_articles" : "list_purchase_articles";
  const update = kind === "sale" ? "update_sales_invoice" : "update_purchase_invoice";
  const label = kind === "sale" ? "Sales" : "Purchase";
  return [
    `${label} invoice ${id} was not registered (HTTP 409). All RIK messages are listed above.`,
    "If they mention a line classifier that is missing or not allowed: RIK derives line classifiers from the company settings, so the line itself needs a valid setup.",
    `Find the line named in the messages, check its ${article}, account and VAT settings (in e-arveldaja, or with ${articles} and list_accounts), fix that line with ${update}, then register again.`,
    "Other 409s usually mean the invoice cannot be registered in its current state (for example it is already registered).",
  ].join(" ");
}

/**
 * Run a register call; on HTTP 409 rethrow the same API error with every RIK
 * message kept and a plain-language hint appended.
 */
export async function withRegisterConflictHint<T>(
  kind: RegisterInvoiceKind,
  id: number,
  register: () => Promise<T>,
): Promise<T> {
  try {
    return await register();
  } catch (error) {
    if (!(error instanceof EFinancialsApiError) || error.httpStatus !== 409) {
      throw error;
    }
    throw new EFinancialsApiError({
      kind: error.kind,
      message: `${error.message}\n${registerConflictHint(kind, id)}`,
      httpStatus: error.httpStatus,
      apiCode: error.apiCode,
      method: error.method,
      url: error.url,
      bodySnippet: error.bodySnippet,
      cause: error,
    });
  }
}
