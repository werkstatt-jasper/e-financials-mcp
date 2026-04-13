const SNIPPET_MAX = 500;

export type EFinancialsErrorKind = "http" | "api" | "network";

export interface EFinancialsApiErrorOptions {
  kind: EFinancialsErrorKind;
  message: string;
  httpStatus?: number;
  apiCode?: number;
  method: string;
  url: string;
  bodySnippet?: string;
  cause?: unknown;
}

export class EFinancialsApiError extends Error {
  readonly kind: EFinancialsErrorKind;
  readonly httpStatus?: number;
  readonly apiCode?: number;
  readonly method: string;
  readonly url: string;
  readonly bodySnippet?: string;

  constructor(options: EFinancialsApiErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "EFinancialsApiError";
    this.kind = options.kind;
    this.httpStatus = options.httpStatus;
    this.apiCode = options.apiCode;
    this.method = options.method;
    this.url = options.url;
    this.bodySnippet = options.bodySnippet;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function truncateBodySnippet(text: string, max = SNIPPET_MAX): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max);
}

/** Safe suffix for client-visible error messages: method + pathname only (no host, query, or hash). */
export function clientFacingRequestLabel(method: string, url: string): string {
  try {
    const u = new URL(url);
    return `[${method} ${u.pathname}]`;
  } catch {
    return `[${method}]`;
  }
}

/** HTTP statuses that may be transient; 409 and other 4xx (except 408/429) are excluded. */
export const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableFetchFailure(error: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return false;
  }
  return true;
}

/**
 * Build error for non-2xx response with a JSON body (RIK or generic).
 */
export function createHttpJsonApiError(params: {
  method: string;
  url: string;
  httpStatus: number;
  errorData: Record<string, unknown>;
}): EFinancialsApiError {
  const { method, url, httpStatus, errorData } = params;
  const errorMessage =
    (typeof errorData.response_message === "string" ? errorData.response_message : undefined) ||
    (typeof errorData.message === "string" ? errorData.message : undefined) ||
    (typeof errorData.error === "string" ? errorData.error : undefined) ||
    (Array.isArray(errorData.errors) ? errorData.errors.join(", ") : undefined) ||
    JSON.stringify(errorData);
  const rawCode = errorData.response_code ?? errorData.code ?? httpStatus;
  const message = `API Error ${rawCode}: ${errorMessage} ${clientFacingRequestLabel(method, url)}`;
  const bodyStr = JSON.stringify(errorData);
  const apiCode = typeof rawCode === "number" && Number.isFinite(rawCode) ? rawCode : undefined;
  return new EFinancialsApiError({
    kind: "http",
    message,
    httpStatus,
    apiCode,
    method,
    url,
    bodySnippet: truncateBodySnippet(bodyStr),
  });
}

export function createHttpPlainApiError(params: {
  method: string;
  url: string;
  httpStatus: number;
  statusText: string;
  text: string;
}): EFinancialsApiError {
  const snippet = truncateBodySnippet(params.text);
  const message = `HTTP Error ${params.httpStatus}: ${params.statusText} - ${snippet} ${clientFacingRequestLabel(params.method, params.url)}`;
  return new EFinancialsApiError({
    kind: "http",
    message,
    httpStatus: params.httpStatus,
    method: params.method,
    url: params.url,
    bodySnippet: snippet,
  });
}

export function createApiResponseError(params: {
  method: string;
  url: string;
  responseCode: number;
  responseMessage: string | undefined;
}): EFinancialsApiError {
  const { responseCode, responseMessage } = params;
  const message = `API Error ${responseCode}: ${responseMessage ?? ""}`;
  return new EFinancialsApiError({
    kind: "api",
    message,
    httpStatus: 200,
    apiCode: responseCode,
    method: params.method,
    url: params.url,
    bodySnippet: truncateBodySnippet(
      JSON.stringify({ response_code: responseCode, response_message: responseMessage }),
    ),
  });
}

export function createNetworkApiError(
  method: string,
  url: string,
  cause: unknown,
): EFinancialsApiError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new EFinancialsApiError({
    kind: "network",
    message: `Network error: ${detail} ${clientFacingRequestLabel(method, url)}`,
    method,
    url,
    cause,
  });
}

export function throwNonOkResponse(
  method: string,
  url: string,
  response: Response,
  text: string,
): never {
  try {
    const errorData = JSON.parse(text) as unknown;
    if (errorData !== null && typeof errorData === "object") {
      throw createHttpJsonApiError({
        method,
        url,
        httpStatus: response.status,
        errorData: errorData as Record<string, unknown>,
      });
    }
  } catch (e) {
    if (e instanceof EFinancialsApiError) {
      throw e;
    }
  }
  throw createHttpPlainApiError({
    method,
    url,
    httpStatus: response.status,
    statusText: response.statusText,
    text,
  });
}
