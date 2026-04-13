import { createHmac } from "node:crypto";

import { assertAllowedRikBaseUrl } from "./rik-base-url.js";

export const DEFAULT_RIK_REQUEST_TIMEOUT_MS = 30_000;

export interface AuthConfig {
  apiKeyId: string;
  apiKeyPassword: string;
  apiKeyPublic: string;
  baseUrl: string;
  /** Max extra attempts after the first request (default from env or 0). */
  httpMaxRetries?: number;
  /** Base delay in ms for exponential backoff (default from env or 500). */
  httpRetryBaseMs?: number;
  /** Outbound RIK HTTP timeout in ms (from env when unset on this object). */
  requestTimeoutMs?: number;
}

function parseNonNegativeInt(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

/** Reads `RIK_REQUEST_TIMEOUT_MS`; invalid or non-positive values use {@link DEFAULT_RIK_REQUEST_TIMEOUT_MS}. */
export function rikRequestTimeoutMsFromEnv(): number {
  const raw = process.env.RIK_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_RIK_REQUEST_TIMEOUT_MS;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_RIK_REQUEST_TIMEOUT_MS;
  }
  return n;
}

export interface AuthHeaders {
  [key: string]: string;
  "Content-Type": string;
  "X-AUTH-QUERYTIME": string;
  "X-AUTH-KEY": string;
}

export function loadAuthConfig(): AuthConfig {
  const apiKeyId = process.env.RIK_API_KEY_ID;
  const apiKeyPassword = process.env.RIK_API_KEY_PASSWORD;
  const apiKeyPublic = process.env.RIK_API_KEY_PUBLIC;
  const baseUrl = process.env.RIK_API_BASE_URL || "https://rmp-api.rik.ee";
  assertAllowedRikBaseUrl(baseUrl);

  if (!apiKeyId || !apiKeyPassword || !apiKeyPublic) {
    throw new Error(
      "Missing required environment variables: RIK_API_KEY_ID, RIK_API_KEY_PASSWORD, RIK_API_KEY_PUBLIC",
    );
  }

  return {
    apiKeyId,
    apiKeyPassword,
    apiKeyPublic,
    baseUrl,
    httpMaxRetries: parseNonNegativeInt(process.env.RIK_HTTP_MAX_RETRIES, 0),
    httpRetryBaseMs: parseNonNegativeInt(process.env.RIK_HTTP_RETRY_BASE_MS, 500),
    requestTimeoutMs: rikRequestTimeoutMsFromEnv(),
  };
}

export function generateAuthHeaders(urlPath: string, config: AuthConfig): AuthHeaders {
  // UTC timestamp without milliseconds (format: 2024-01-15T14:30:00)
  const queryTime = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .trim();

  // Create the string to sign: apikeyid:time:url
  const stringToSign = `${config.apiKeyId}:${queryTime}:${urlPath}`;

  // Generate HMAC-SHA-384 signature
  const hmac = createHmac("sha384", config.apiKeyPassword);
  hmac.update(stringToSign);
  const signature = hmac.digest("base64");

  // Construct X-AUTH-KEY: public_key:signature
  const authKey = `${config.apiKeyPublic}:${signature}`;

  return {
    "Content-Type": "application/json",
    "X-AUTH-QUERYTIME": queryTime,
    "X-AUTH-KEY": authKey,
  };
}
