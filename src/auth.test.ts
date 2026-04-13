import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RIK_REQUEST_TIMEOUT_MS,
  generateAuthHeaders,
  loadAuthConfig,
  rikRequestTimeoutMsFromEnv,
} from "./auth.js";

const missingEnvMessage =
  "Missing required environment variables: RIK_API_KEY_ID, RIK_API_KEY_PASSWORD, RIK_API_KEY_PUBLIC";

describe("loadAuthConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns AuthConfig when all env vars are set", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_API_BASE_URL", "https://demo-rmp-api.rik.ee");

    expect(loadAuthConfig()).toEqual({
      apiKeyId: "id-1",
      apiKeyPassword: "secret",
      apiKeyPublic: "pub-1",
      baseUrl: "https://demo-rmp-api.rik.ee",
      httpMaxRetries: 0,
      httpRetryBaseMs: 500,
      requestTimeoutMs: DEFAULT_RIK_REQUEST_TIMEOUT_MS,
    });
  });

  it("throws when RIK_API_BASE_URL is not an allowed RIK hostname", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_API_BASE_URL", "https://evil.example");

    expect(() => loadAuthConfig()).toThrow(/hostname is not allowed/);
  });

  it("uses default baseUrl when RIK_API_BASE_URL is unset", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_API_BASE_URL", undefined);

    expect(loadAuthConfig().baseUrl).toBe("https://rmp-api.rik.ee");
  });

  it("throws when RIK_API_KEY_ID is missing", () => {
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_API_KEY_ID", undefined);

    expect(() => loadAuthConfig()).toThrow(missingEnvMessage);
  });

  it("throws when RIK_API_KEY_PASSWORD is missing", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", undefined);

    expect(() => loadAuthConfig()).toThrow(missingEnvMessage);
  });

  it("throws when RIK_API_KEY_PUBLIC is missing", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", undefined);

    expect(() => loadAuthConfig()).toThrow(missingEnvMessage);
  });

  it("throws when a required key is empty string", () => {
    vi.stubEnv("RIK_API_KEY_ID", "");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");

    expect(() => loadAuthConfig()).toThrow(missingEnvMessage);
  });

  it("parses RIK_HTTP_MAX_RETRIES and RIK_HTTP_RETRY_BASE_MS", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_HTTP_MAX_RETRIES", "3");
    vi.stubEnv("RIK_HTTP_RETRY_BASE_MS", "1000");

    const cfg = loadAuthConfig();
    expect(cfg.httpMaxRetries).toBe(3);
    expect(cfg.httpRetryBaseMs).toBe(1000);
  });

  it("falls back when retry env vars are invalid", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_HTTP_MAX_RETRIES", "not-a-number");
    vi.stubEnv("RIK_HTTP_RETRY_BASE_MS", "-1");

    const c = loadAuthConfig();
    expect(c.httpMaxRetries).toBe(0);
    expect(c.httpRetryBaseMs).toBe(500);
  });

  it("parses RIK_REQUEST_TIMEOUT_MS", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_REQUEST_TIMEOUT_MS", "60000");

    expect(loadAuthConfig().requestTimeoutMs).toBe(60_000);
  });

  it("falls back when RIK_REQUEST_TIMEOUT_MS is invalid or non-positive", () => {
    vi.stubEnv("RIK_API_KEY_ID", "id-1");
    vi.stubEnv("RIK_API_KEY_PASSWORD", "secret");
    vi.stubEnv("RIK_API_KEY_PUBLIC", "pub-1");
    vi.stubEnv("RIK_REQUEST_TIMEOUT_MS", "0");

    expect(loadAuthConfig().requestTimeoutMs).toBe(DEFAULT_RIK_REQUEST_TIMEOUT_MS);

    vi.stubEnv("RIK_REQUEST_TIMEOUT_MS", "not-a-number");
    expect(loadAuthConfig().requestTimeoutMs).toBe(DEFAULT_RIK_REQUEST_TIMEOUT_MS);
  });
});

describe("rikRequestTimeoutMsFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns default when unset", () => {
    vi.stubEnv("RIK_REQUEST_TIMEOUT_MS", undefined);
    expect(rikRequestTimeoutMsFromEnv()).toBe(DEFAULT_RIK_REQUEST_TIMEOUT_MS);
  });

  it("returns parsed positive integer", () => {
    vi.stubEnv("RIK_REQUEST_TIMEOUT_MS", "42");
    expect(rikRequestTimeoutMsFromEnv()).toBe(42);
  });
});

describe("generateAuthHeaders", () => {
  const config = {
    apiKeyId: "test-id",
    apiKeyPassword: "test-secret",
    apiKeyPublic: "test-public",
    baseUrl: "https://rmp-api.rik.ee",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets X-AUTH-QUERYTIME without milliseconds", () => {
    const headers = generateAuthHeaders("/v1/transactions", config);
    expect(headers["X-AUTH-QUERYTIME"]).toBe("2025-06-15T12:00:00");
    expect(headers["X-AUTH-QUERYTIME"]).not.toMatch(/\./);
  });

  it("sets Content-Type to application/json", () => {
    const headers = generateAuthHeaders("/v1/transactions", config);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("builds X-AUTH-KEY as publicKey:base64 HMAC-SHA384 of apiKeyId:time:path", () => {
    const urlPath = "/v1/transactions";
    const queryTime = "2025-06-15T12:00:00";
    const stringToSign = `${config.apiKeyId}:${queryTime}:${urlPath}`;
    const expectedSig = createHmac("sha384", config.apiKeyPassword)
      .update(stringToSign)
      .digest("base64");

    const headers = generateAuthHeaders(urlPath, config);
    expect(headers["X-AUTH-KEY"]).toBe(`${config.apiKeyPublic}:${expectedSig}`);
  });

  it("signs the urlPath argument verbatim (query string in path affects signature)", () => {
    const pathWithQuery = "/v1/foo?x=1";
    const queryTime = "2025-06-15T12:00:00";
    const stringToSign = `${config.apiKeyId}:${queryTime}:${pathWithQuery}`;
    const expectedSig = createHmac("sha384", config.apiKeyPassword)
      .update(stringToSign)
      .digest("base64");

    const headers = generateAuthHeaders(pathWithQuery, config);
    expect(headers["X-AUTH-KEY"]).toBe(`${config.apiKeyPublic}:${expectedSig}`);

    const pathOnly = "/v1/foo";
    const stringPathOnly = `${config.apiKeyId}:${queryTime}:${pathOnly}`;
    const sigPathOnly = createHmac("sha384", config.apiKeyPassword)
      .update(stringPathOnly)
      .digest("base64");
    expect(headers["X-AUTH-KEY"]).not.toBe(`${config.apiKeyPublic}:${sigPathOnly}`);
  });
});
