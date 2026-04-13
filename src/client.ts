import type { Logger } from "pino";

import {
  createApiResponseError,
  createNetworkApiError,
  EFinancialsApiError,
  isRetryableFetchFailure,
  RETRYABLE_HTTP_STATUSES,
  throwNonOkResponse,
} from "./api-error.js";
import { type AuthConfig, generateAuthHeaders, rikRequestTimeoutMsFromEnv } from "./auth.js";
import { logger as defaultLogger } from "./logger.js";

export { EFinancialsApiError, RETRYABLE_HTTP_STATUSES } from "./api-error.js";

export interface ApiResponse<T = unknown> {
  // Error response fields
  response_code?: number;
  response_message?: string;
  // Success response fields
  id?: number;
  created_object_id?: number;
  items?: T[];
  current_page?: number;
  total_pages?: number;
  // Legacy fields
  total_count?: number;
  page?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface EFinancialsClientOptions {
  logger?: Logger;
  /** Max HTTP pages `getAllPages` will fetch; avoids unbounded loops if the API reports huge `total_pages`. Default 100; minimum 1. */
  maxPages?: number;
}

/** Static env config or a per-request resolver (HTTP multi-tenant). */
export type AuthConfigSource = AuthConfig | (() => AuthConfig);

const MAX_BACKOFF_MS = 8000;

function backoffDelayMs(attemptIndex: number, baseMs: number): number {
  const exponential = Math.min(baseMs * 2 ** attemptIndex, MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * Math.min(baseMs, 200));
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class EFinancialsClient {
  private readonly resolveConfig: () => AuthConfig;
  private logger: Logger;
  private readonly maxPages: number;

  constructor(source: AuthConfigSource, options?: EFinancialsClientOptions) {
    this.resolveConfig = typeof source === "function" ? source : () => source;
    this.logger = options?.logger ?? defaultLogger;
    this.maxPages = Math.max(1, options?.maxPages ?? 100);
  }

  private retrySettingsFrom(config: AuthConfig): { maxRetries: number; retryBaseMs: number } {
    return {
      maxRetries: Math.max(0, config.httpMaxRetries ?? 0),
      retryBaseMs: Math.max(0, config.httpRetryBaseMs ?? 500),
    };
  }

  private effectiveRequestTimeoutMs(config: AuthConfig): number {
    return config.requestTimeoutMs ?? rikRequestTimeoutMsFromEnv();
  }

  private logRikRequest(method: string, path: string, started: number, error?: unknown): void {
    const durationMs = Math.round(performance.now() - started);
    if (error === undefined) {
      this.logger.info(
        { component: "http", method, path, durationMs, outcome: "ok" },
        "rik request",
      );
      return;
    }
    if (error instanceof EFinancialsApiError) {
      const outcome =
        error.kind === "network"
          ? "network_error"
          : error.kind === "http"
            ? "http_error"
            : "api_response_error";
      this.logger.info(
        {
          component: "http",
          method,
          path,
          requestUrl: error.url,
          durationMs,
          outcome,
          httpStatus: error.httpStatus,
          apiCode: error.apiCode,
        },
        "rik request",
      );
      return;
    }
    this.logger.info(
      { component: "http", method, path, durationMs, outcome: "unknown_error" },
      "rik request",
    );
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const { method = "GET", params, body } = options;
    const started = performance.now();
    const config = this.resolveConfig();
    const { maxRetries, retryBaseMs } = this.retrySettingsFrom(config);

    try {
      const url = new URL(`${config.baseUrl}${path}`);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) {
            url.searchParams.set(key, String(value));
          }
        }
      }

      const urlString = url.toString();
      const headers = generateAuthHeaders(path, config);
      const maxAttempts = 1 + maxRetries;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const isLastAttempt = attempt === maxAttempts - 1;
        const timeoutMs = this.effectiveRequestTimeoutMs(config);

        let response: Response;
        try {
          response = await fetch(urlString, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          if (!isLastAttempt && isRetryableFetchFailure(e)) {
            await sleep(backoffDelayMs(attempt, retryBaseMs));
            continue;
          }
          throw createNetworkApiError(method, urlString, e);
        }

        if (!response.ok) {
          if (!isLastAttempt && RETRYABLE_HTTP_STATUSES.has(response.status)) {
            await response.arrayBuffer();
            await sleep(backoffDelayMs(attempt, retryBaseMs));
            continue;
          }
          const text = await response.text();
          throwNonOkResponse(method, urlString, response, text);
        }

        const data = (await response.json()) as ApiResponse<T>;

        if (data.created_object_id !== undefined && data.id === undefined) {
          data.id = data.created_object_id;
        }

        if (data.response_code !== undefined && data.response_code !== 0) {
          throw createApiResponseError({
            method,
            url: urlString,
            responseCode: data.response_code,
            responseMessage: data.response_message,
          });
        }

        this.logRikRequest(method, path, started, undefined);
        return data;
      }

      /* v8 ignore next - for-loop always returns or throws */
      throw createNetworkApiError(method, url.toString(), new Error("request loop exhausted"));
    } catch (error) {
      this.logRikRequest(method, path, started, error);
      throw error;
    }
  }

  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "GET", params });
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "POST", body });
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "PUT", body });
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "PATCH", body });
  }

  async delete<T = unknown>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "DELETE" });
  }

  async getAllPages<T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.get<T>(path, { ...params, page });
      if (response.items) {
        allItems.push(...response.items);
      }
      const currentPage = response.current_page || page;
      const totalPages = response.total_pages || 1;
      hasMore = currentPage < totalPages;
      if (hasMore && page >= this.maxPages) {
        this.logger.warn(
          {
            component: "http",
            path,
            maxPages: this.maxPages,
            totalPages,
            currentPage,
          },
          "getAllPages stopped at maxPages cap",
        );
        return allItems;
      }
      page++;
    }

    return allItems;
  }
}
