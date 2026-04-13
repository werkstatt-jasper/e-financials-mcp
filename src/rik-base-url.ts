/** Thrown when `assertAllowedRikBaseUrl` rejects a URL (HTTP handlers may map to 400). */
export class RikBaseUrlNotAllowedError extends Error {
  override readonly name = "RikBaseUrlNotAllowedError";
}

/** Default RIK API hostnames when `MCP_ALLOWED_RIK_HOSTS` is unset or empty. */
export const DEFAULT_ALLOWED_RIK_HOSTS = ["rmp-api.rik.ee", "demo-rmp-api.rik.ee"] as const;

/**
 * When set to a non-empty string, the comma-separated hostnames replace the default
 * allowlist entirely (operators must list every permitted host, including demo).
 */
function allowedHostsFromEnv(): string[] {
  const raw = process.env.MCP_ALLOWED_RIK_HOSTS?.trim();
  if (!raw) {
    return [...DEFAULT_ALLOWED_RIK_HOSTS];
  }
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

function parseBaseUrlForValidation(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withScheme);
}

/**
 * Ensures `baseUrl` uses HTTPS and its hostname is allowed for outbound RIK API calls.
 * Throws `Error` if invalid (wrong scheme, userinfo, or hostname not in allowlist).
 */
export function assertAllowedRikBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = parseBaseUrlForValidation(baseUrl);
  } catch {
    throw new RikBaseUrlNotAllowedError("RIK base URL must be a valid https URL");
  }

  if (url.protocol !== "https:") {
    throw new RikBaseUrlNotAllowedError("RIK base URL must use https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RikBaseUrlNotAllowedError("RIK base URL must not include a username or password");
  }

  const host = url.hostname.toLowerCase();
  const allowed = allowedHostsFromEnv();
  if (!allowed.includes(host)) {
    throw new RikBaseUrlNotAllowedError("RIK base URL hostname is not allowed");
  }
}
