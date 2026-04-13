import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rootLoggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  fatal: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./auth.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./auth.js")>();
  return {
    ...mod,
    generateAuthHeaders: vi.fn(() => ({
      "Content-Type": "application/json",
      "X-AUTH-QUERYTIME": "2025-06-15T12:00:00",
      "X-AUTH-KEY": "test-public:stub-sig",
    })),
  };
});

vi.mock("./logger.js", () => ({
  logger: rootLoggerMocks,
}));

import errorResponses from "./__fixtures__/error-responses.json" with { type: "json" };
import transactionsFixture from "./__fixtures__/transactions.json" with { type: "json" };
import { generateAuthHeaders } from "./auth.js";
import { EFinancialsApiError, EFinancialsClient } from "./client.js";

const baseConfig = {
  apiKeyId: "id",
  apiKeyPassword: "pw",
  apiKeyPublic: "pub",
  baseUrl: "https://rmp-api.rik.ee",
  requestTimeoutMs: 30_000,
};

function jsonResponse(data: unknown, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(data), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

describe("EFinancialsClient", () => {
  let client: EFinancialsClient;

  beforeEach(() => {
    client = new EFinancialsClient(baseConfig);
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(generateAuthHeaders).mockClear();
    rootLoggerMocks.info.mockClear();
    rootLoggerMocks.warn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("AuthConfigSource getter", () => {
    it("resolves config on each request for dynamic credentials", async () => {
      let call = 0;
      const configA = { ...baseConfig, apiKeyId: "tenant-a", baseUrl: "https://rmp-api.rik.ee" };
      const configB = {
        ...baseConfig,
        apiKeyId: "tenant-b",
        baseUrl: "https://demo-rmp-api.rik.ee",
      };
      const dynamicClient = new EFinancialsClient(() => (call++ === 0 ? configA : configB));
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(transactionsFixture.list_empty))
        .mockResolvedValueOnce(jsonResponse(transactionsFixture.list_empty));

      await dynamicClient.get("/v1/shared");
      await dynamicClient.get("/v1/shared");

      expect(generateAuthHeaders).toHaveBeenNthCalledWith(1, "/v1/shared", configA);
      expect(generateAuthHeaders).toHaveBeenNthCalledWith(2, "/v1/shared", configB);
    });
  });

  describe("request / HTTP verbs", () => {
    it("builds URL with query params and omits undefined", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.list_empty));

      await client.get("/v1/clients", { page: 2, is_supplier: true, filter: undefined });

      expect(generateAuthHeaders).toHaveBeenCalledWith("/v1/clients", baseConfig);
      const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
      const url = new URL(calledUrl);
      expect(url.origin + url.pathname).toBe("https://rmp-api.rik.ee/v1/clients");
      expect(url.searchParams.get("page")).toBe("2");
      expect(url.searchParams.get("is_supplier")).toBe("true");
      expect(url.searchParams.has("filter")).toBe(false);
    });

    it("passes mocked auth headers to fetch", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.http_ok_flag));

      await client.get("/v1/foo");

      expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({
        "Content-Type": "application/json",
        "X-AUTH-QUERYTIME": "2025-06-15T12:00:00",
        "X-AUTH-KEY": "test-public:stub-sig",
      });
    });

    it("passes an AbortSignal from AbortSignal.timeout to fetch", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.list_empty));

      await client.get("/v1/foo");

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
      timeoutSpy.mockRestore();
    });

    it("uses config.requestTimeoutMs for AbortSignal.timeout", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.list_empty));
      const c = new EFinancialsClient({ ...baseConfig, requestTimeoutMs: 12_345 });

      await c.get("/v1/foo");

      expect(timeoutSpy).toHaveBeenCalledWith(12_345);
      timeoutSpy.mockRestore();
    });

    it("falls back to RIK_REQUEST_TIMEOUT_MS when config omits requestTimeoutMs", async () => {
      vi.stubEnv("RIK_REQUEST_TIMEOUT_MS", "7777");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.list_empty));
      const { requestTimeoutMs: _omitTimeout, ...cfgNoTimeout } = baseConfig;
      void _omitTimeout;
      const c = new EFinancialsClient(cfgNoTimeout);

      await c.get("/v1/foo");

      expect(timeoutSpy).toHaveBeenCalledWith(7777);
      timeoutSpy.mockRestore();
    });

    it("sends JSON body for POST", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.http_post_created));
      const body = { name: "Acme", n: 42 };

      await client.post("/v1/clients", body);

      expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
        method: "POST",
        body: JSON.stringify(body),
      });
    });

    it("sends JSON body for PUT", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.http_ok_empty));
      await client.put("/v1/clients/1", { name: "Updated" });
      expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
        method: "PUT",
        body: JSON.stringify({ name: "Updated" }),
      });
    });

    it("sends JSON body for PATCH", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.http_ok_empty));
      await client.patch("/v1/clients/1", { active: false });
      expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
        method: "PATCH",
        body: JSON.stringify({ active: false }),
      });
    });

    it("normalizes created_object_id to id on POST responses", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({ response_code: 0, created_object_id: 42, messages: ["OK"] }),
      );

      const result = await client.post("/v1/clients", { name: "Test" });
      expect(result.id).toBe(42);
      expect(result.created_object_id).toBe(42);
    });

    it("does not overwrite existing id with created_object_id", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({ response_code: 0, id: 99, created_object_id: 42, messages: ["OK"] }),
      );

      const result = await client.post("/v1/clients", { name: "Test" });
      expect(result.id).toBe(99);
      expect(result.created_object_id).toBe(42);
    });

    it("omits body for GET and DELETE when no body", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.list_empty));
      await client.get("/v1/x");
      expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();

      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.http_ok_empty));
      await client.delete("/v1/x/1");
      expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBeUndefined();
    });
  });

  describe("HTTP request logging", () => {
    let logInfo: ReturnType<typeof vi.fn>;
    let logClient: EFinancialsClient;

    beforeEach(() => {
      logInfo = vi.fn();
      logClient = new EFinancialsClient(baseConfig, {
        logger: { info: logInfo } as unknown as Logger,
      });
      vi.stubGlobal("fetch", vi.fn());
    });

    it("logs ok with path and method and omits secrets", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.list_empty));

      await logClient.get("/v1/clients");

      expect(logInfo).toHaveBeenCalledTimes(1);
      expect(logInfo.mock.calls[0][0]).toMatchObject({
        component: "http",
        method: "GET",
        path: "/v1/clients",
        outcome: "ok",
      });
      expect(typeof (logInfo.mock.calls[0][0] as { durationMs: number }).durationMs).toBe("number");
      const blob = JSON.stringify(logInfo.mock.calls);
      expect(blob).not.toContain("pw");
      expect(blob).not.toContain("X-AUTH-KEY");
      expect(blob).not.toContain("stub-sig");
    });

    it("logs network_error on fetch failure", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network down"));

      await expect(logClient.get("/v1/x")).rejects.toMatchObject({ kind: "network" });

      expect(logInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "http",
          method: "GET",
          path: "/v1/x",
          requestUrl: "https://rmp-api.rik.ee/v1/x",
          outcome: "network_error",
        }),
        "rik request",
      );
    });

    it("logs http_error on non-OK response", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(errorResponses.http_401_body, 401, "Unauthorized"),
      );

      await expect(logClient.get("/v1/x")).rejects.toMatchObject({ kind: "http" });

      expect(logInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/x",
          requestUrl: "https://rmp-api.rik.ee/v1/x",
          outcome: "http_error",
          httpStatus: 401,
        }),
        "rik request",
      );
    });

    it("logs api_response_error when response_code is non-zero", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(errorResponses.api_business_error_body));

      await expect(logClient.get("/v1/x")).rejects.toMatchObject({ kind: "api" });

      expect(logInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/x",
          requestUrl: "https://rmp-api.rik.ee/v1/x",
          outcome: "api_response_error",
          apiCode: 7,
        }),
        "rik request",
      );
    });

    it("logs unknown_error when a non-API error is thrown before fetch", async () => {
      vi.mocked(generateAuthHeaders).mockImplementationOnce(() => {
        throw new Error("auth setup failed");
      });
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.list_empty));

      await expect(logClient.get("/v1/x")).rejects.toThrow("auth setup failed");

      expect(logInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/x",
          outcome: "unknown_error",
        }),
        "rik request",
      );
    });
  });

  describe("HTTP error responses (!response.ok)", () => {
    it("throws API Error with response_message and response_code from JSON body", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(errorResponses.http_401_body, 401, "Unauthorized"),
      );

      await expect(client.get("/v1/x")).rejects.toThrow("API Error 401: Unauthorized [GET /v1/x]");
    });

    it("uses message fallback when response_message missing", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(errorResponses.http_400_message_body, 400, "Bad Request"),
      );

      await expect(client.post("/v1/x")).rejects.toThrow("API Error 400: Bad request");
    });

    it("uses errors array join when present", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(errorResponses.http_422_errors_body, 422, "Unprocessable Entity"),
      );

      await expect(client.get("/v1/x")).rejects.toThrow("API Error 422: a, b");
    });

    it("uses error field when other message fields missing", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(errorResponses.http_error_field_body, 400, "Bad Request"),
      );

      await expect(client.get("/v1/x")).rejects.toThrow(
        "API Error 400: custom error string [GET /v1/x]",
      );
    });

    it("uses JSON.stringify when body has no known message fields", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(errorResponses.http_empty_json_body, 500, "Server Error"),
      );

      await expect(client.get("/v1/x")).rejects.toThrow("API Error 500: {} [GET /v1/x]");
    });

    it("uses code from JSON body when response_code missing", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(errorResponses.http_code_field_body, 500, "Server Error"),
      );

      await expect(client.get("/v1/x")).rejects.toThrow(
        'API Error 418: {"code":418,"detail":"nope"} [GET /v1/x]',
      );
    });

    it("throws HTTP Error when body is not JSON", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response("plain text error", { status: 502, statusText: "Bad Gateway" }),
      );

      await expect(client.get("/v1/x")).rejects.toThrow(
        "HTTP Error 502: Bad Gateway - plain text error [GET /v1/x]",
      );
    });
  });

  describe("API-level errors (HTTP OK, response_code !== 0)", () => {
    it("throws when response_code is non-zero", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(errorResponses.api_business_error_body));

      await expect(client.get("/v1/x")).rejects.toThrow("API Error 7: Business rule failed");
    });

    it("does not throw when response_code is 0", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(errorResponses.api_success_with_items));

      await expect(client.get("/v1/x")).resolves.toEqual(errorResponses.api_success_with_items);
    });

    it("does not throw when response_code is undefined", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(errorResponses.items_numeric));

      await expect(client.get("/v1/x")).resolves.toEqual(errorResponses.items_numeric);
    });
  });

  describe("getAllPages", () => {
    it("aggregates items across multiple pages", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(transactionsFixture.pagination_page_1))
        .mockResolvedValueOnce(jsonResponse(transactionsFixture.pagination_page_2))
        .mockResolvedValueOnce(jsonResponse(transactionsFixture.pagination_page_3));

      const items = await client.getAllPages<{ id: string }>("/v1/list");

      expect(items).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
      const urls = vi.mocked(fetch).mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toContain("page=1");
      expect(urls[1]).toContain("page=2");
      expect(urls[2]).toContain("page=3");
    });

    it("stops after one page when total_pages is 1", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.single_page_list));

      const items = await client.getAllPages("/v1/list");

      expect(items).toEqual(transactionsFixture.single_page_list.items);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when items missing or empty", async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.paged_no_items_key));

      await expect(client.getAllPages("/v1/empty")).resolves.toEqual([]);

      vi.mocked(fetch).mockResolvedValue(jsonResponse(transactionsFixture.paged_empty_items));

      await expect(client.getAllPages("/v1/empty2")).resolves.toEqual([]);
    });

    it("continues pagination when a page omits items but more pages remain", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse({
            items: [{ id: "first" }],
            total_pages: 3,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            current_page: 2,
            total_pages: 3,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            items: [{ id: "last" }],
            current_page: 3,
            total_pages: 3,
          }),
        );

      const items = await client.getAllPages<{ id: string }>("/v1/list");
      expect(items).toEqual([{ id: "first" }, { id: "last" }]);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    });

    it("uses loop page when response current_page is zero", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "x" }],
          current_page: 0,
          total_pages: 1,
        }),
      );

      const items = await client.getAllPages<{ id: string }>("/v1/list");
      expect(items).toEqual([{ id: "x" }]);
    });

    it("treats total_pages zero as one page", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "z" }],
          current_page: 1,
          total_pages: 0,
        }),
      );

      const items = await client.getAllPages<{ id: string }>("/v1/list");
      expect(items).toEqual([{ id: "z" }]);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it("stops after maxPages default and logs when API reports more pages", async () => {
      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            items: [{ id: "loop" }],
            current_page: 1,
            total_pages: 10000,
          }),
        ),
      );

      const items = await client.getAllPages<{ id: string }>("/v1/huge");

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(100);
      expect(items).toHaveLength(100);
      expect(rootLoggerMocks.warn).toHaveBeenCalledTimes(1);
      expect(rootLoggerMocks.warn.mock.calls[0][0]).toMatchObject({
        component: "http",
        path: "/v1/huge",
        maxPages: 100,
        totalPages: 10000,
        currentPage: 1,
      });
      expect(rootLoggerMocks.warn.mock.calls[0][1]).toBe("getAllPages stopped at maxPages cap");
    });

    it("respects custom maxPages and returns partial results", async () => {
      const logWarn = vi.fn();
      const cappedClient = new EFinancialsClient(baseConfig, {
        maxPages: 2,
        logger: { info: vi.fn(), warn: logWarn } as unknown as Logger,
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse({
            items: [{ id: "a" }],
            current_page: 1,
            total_pages: 3,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            items: [{ id: "b" }],
            current_page: 2,
            total_pages: 3,
          }),
        );

      const items = await cappedClient.getAllPages<{ id: string }>("/v1/paged");

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(items).toEqual([{ id: "a" }, { id: "b" }]);
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn.mock.calls[0][0]).toMatchObject({
        component: "http",
        path: "/v1/paged",
        maxPages: 2,
        totalPages: 3,
        currentPage: 2,
      });
    });
  });

  it("throws network error when fetch rejects and retries are disabled", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network down"));

    await expect(client.get("/v1/x")).rejects.toMatchObject({
      kind: "network",
      name: "EFinancialsApiError",
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  describe("EFinancialsApiError and retries", () => {
    describe("structured errors", () => {
      it("exposes http JSON error fields", async () => {
        vi.mocked(fetch).mockResolvedValue(
          jsonResponse(errorResponses.http_401_body, 401, "Unauthorized"),
        );

        await expect(client.get("/v1/x")).rejects.toSatisfy((e: unknown) => {
          expect(e).toBeInstanceOf(EFinancialsApiError);
          expect(e).toMatchObject({
            kind: "http",
            httpStatus: 401,
            apiCode: 401,
            method: "GET",
            url: expect.stringContaining("/v1/x"),
            bodySnippet: expect.stringContaining("Unauthorized"),
          });
          return true;
        });
      });

      it("exposes api-level error fields for HTTP 200 with response_code", async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse(errorResponses.api_business_error_body));

        await expect(client.get("/v1/x")).rejects.toMatchObject({
          kind: "api",
          httpStatus: 200,
          apiCode: 7,
          method: "GET",
        });
      });

      it("exposes plain HTTP error bodySnippet", async () => {
        vi.mocked(fetch).mockResolvedValue(
          new Response("plain text error", { status: 502, statusText: "Bad Gateway" }),
        );

        await expect(client.get("/v1/x")).rejects.toMatchObject({
          kind: "http",
          httpStatus: 502,
          bodySnippet: "plain text error",
        });
      });
    });

    describe("retries", () => {
      let retryClient: EFinancialsClient;

      beforeEach(() => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        retryClient = new EFinancialsClient({
          ...baseConfig,
          httpMaxRetries: 2,
          httpRetryBaseMs: 10,
        });
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
        vi.mocked(Math.random).mockRestore();
      });

      it("retries on 503 then succeeds", async () => {
        vi.mocked(fetch)
          .mockResolvedValueOnce(
            new Response(null, { status: 503, statusText: "Service Unavailable" }),
          )
          .mockResolvedValueOnce(
            new Response(null, { status: 503, statusText: "Service Unavailable" }),
          )
          .mockResolvedValueOnce(jsonResponse(transactionsFixture.list_empty));

        const p = retryClient.get("/v1/x");
        await vi.runAllTimersAsync();
        await expect(p).resolves.toEqual(transactionsFixture.list_empty);
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
      });

      it("retries after fetch throws then succeeds", async () => {
        vi.mocked(fetch)
          .mockRejectedValueOnce(new TypeError("fetch failed"))
          .mockResolvedValueOnce(jsonResponse(transactionsFixture.list_empty));

        const p = retryClient.get("/v1/x");
        await vi.runAllTimersAsync();
        await expect(p).resolves.toEqual(transactionsFixture.list_empty);
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      });

      it("does not retry on 409", async () => {
        vi.mocked(fetch).mockResolvedValue(
          jsonResponse(errorResponses.http_409_body, 409, "Conflict"),
        );

        const c = new EFinancialsClient({ ...baseConfig, httpMaxRetries: 3 });
        await expect(c.get("/v1/x")).rejects.toMatchObject({
          kind: "http",
          httpStatus: 409,
        });
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      });

      it("does not retry on 401", async () => {
        vi.mocked(fetch).mockResolvedValue(
          jsonResponse(errorResponses.http_401_body, 401, "Unauthorized"),
        );

        const c = new EFinancialsClient({ ...baseConfig, httpMaxRetries: 3 });
        await expect(c.get("/v1/x")).rejects.toMatchObject({ kind: "http", httpStatus: 401 });
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      });

      it("does not retry when HTTP 200 has non-zero response_code", async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse(errorResponses.api_business_error_body));

        const c = new EFinancialsClient({ ...baseConfig, httpMaxRetries: 3 });
        await expect(c.get("/v1/x")).rejects.toMatchObject({ kind: "api", apiCode: 7 });
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      });
    });
  });
});
