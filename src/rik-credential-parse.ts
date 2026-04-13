import type { AuthConfig } from "./auth.js";
import { assertAllowedRikBaseUrl } from "./rik-base-url.js";

type TenantFileEntry = {
  apiKeyId: string;
  apiKeyPassword: string;
  apiKeyPublic: string;
  baseUrl?: string;
  httpMaxRetries?: number;
  httpRetryBaseMs?: number;
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Parses RIK signing fields from JSON (MCP tenant file value or decrypted DB payload).
 * When `baseUrlFromColumn` is set (e.g. from `api_credentials.base_url`), it is used and JSON may omit `baseUrl`.
 */
export function parseRikAuthCredentialJson(
  raw: unknown,
  keyLabel: string,
  baseUrlFromColumn?: string,
): AuthConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`Tenant "${keyLabel}": value must be a JSON object`);
  }
  const o = raw as TenantFileEntry;
  if (!isNonEmptyString(o.apiKeyId)) {
    throw new Error(`Tenant "${keyLabel}": missing or empty apiKeyId`);
  }
  if (!isNonEmptyString(o.apiKeyPassword)) {
    throw new Error(`Tenant "${keyLabel}": missing or empty apiKeyPassword`);
  }
  if (!isNonEmptyString(o.apiKeyPublic)) {
    throw new Error(`Tenant "${keyLabel}": missing or empty apiKeyPublic`);
  }

  let baseUrl: string;
  if (baseUrlFromColumn !== undefined) {
    if (!isNonEmptyString(baseUrlFromColumn)) {
      throw new Error(`Tenant "${keyLabel}": baseUrl must be non-empty`);
    }
    baseUrl = baseUrlFromColumn.trim().replace(/\/$/, "");
  } else if (isNonEmptyString(o.baseUrl)) {
    baseUrl = o.baseUrl.trim().replace(/\/$/, "");
  } else {
    throw new Error(`Tenant "${keyLabel}": missing or empty baseUrl`);
  }

  assertAllowedRikBaseUrl(baseUrl);

  const config: AuthConfig = {
    apiKeyId: o.apiKeyId.trim(),
    apiKeyPassword: o.apiKeyPassword,
    apiKeyPublic: o.apiKeyPublic.trim(),
    baseUrl,
  };
  if (o.httpMaxRetries !== undefined) {
    if (!Number.isInteger(o.httpMaxRetries) || o.httpMaxRetries < 0) {
      throw new Error(`Tenant "${keyLabel}": httpMaxRetries must be a non-negative integer`);
    }
    config.httpMaxRetries = o.httpMaxRetries;
  }
  if (o.httpRetryBaseMs !== undefined) {
    if (!Number.isInteger(o.httpRetryBaseMs) || o.httpRetryBaseMs < 0) {
      throw new Error(`Tenant "${keyLabel}": httpRetryBaseMs must be a non-negative integer`);
    }
    config.httpRetryBaseMs = o.httpRetryBaseMs;
  }
  return config;
}
