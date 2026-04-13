import { describe, expect, it } from "vitest";
import {
  clientFacingRequestLabel,
  createApiResponseError,
  createHttpJsonApiError,
  createNetworkApiError,
  EFinancialsApiError,
  isRetryableFetchFailure,
  throwNonOkResponse,
  truncateBodySnippet,
} from "./api-error.js";

describe("clientFacingRequestLabel", () => {
  it("returns method and pathname without origin or query", () => {
    expect(clientFacingRequestLabel("GET", "https://host.example/v1/a?x=1#h")).toBe("[GET /v1/a]");
  });

  it("returns method only when url is not parseable", () => {
    expect(clientFacingRequestLabel("POST", "not a url")).toBe("[POST]");
  });
});

describe("truncateBodySnippet", () => {
  it("returns text unchanged when within max length", () => {
    expect(truncateBodySnippet("short", 10)).toBe("short");
  });

  it("truncates when longer than max", () => {
    const long = "x".repeat(600);
    expect(truncateBodySnippet(long, 500)).toHaveLength(500);
  });
});

describe("isRetryableFetchFailure", () => {
  it("returns false for AbortError", () => {
    const err = new DOMException("Aborted", "AbortError");
    expect(isRetryableFetchFailure(err)).toBe(false);
  });

  it("returns true for other errors", () => {
    expect(isRetryableFetchFailure(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("createNetworkApiError", () => {
  it("stringifies non-Error cause", () => {
    const e = createNetworkApiError("GET", "https://example.com/x", "plain");
    expect(e.message).toContain("plain");
    expect(e.message).toContain("[GET /x]");
    expect(e.message).not.toContain("example.com");
  });
});

describe("EFinancialsApiError", () => {
  it("passes cause to Error when provided", () => {
    const inner = new Error("inner");
    const e = new EFinancialsApiError({
      kind: "network",
      message: "outer",
      method: "GET",
      url: "https://x",
      cause: inner,
    });
    expect(e.cause).toBe(inner);
  });

  it("omits cause option when undefined", () => {
    const e = new EFinancialsApiError({
      kind: "http",
      message: "m",
      method: "GET",
      url: "https://x",
    });
    expect(e.cause).toBeUndefined();
  });
});

describe("createHttpJsonApiError", () => {
  it("prefers response_message over other fields", () => {
    const e = createHttpJsonApiError({
      method: "GET",
      url: "https://x",
      httpStatus: 400,
      errorData: { response_message: "from-response", message: "from-message" },
    });
    expect(e.message).toContain("from-response");
    expect(e.message).not.toContain("from-message");
  });

  it("uses message when response_message is absent", () => {
    const e = createHttpJsonApiError({
      method: "GET",
      url: "https://x",
      httpStatus: 400,
      errorData: { message: "only" },
    });
    expect(e.message).toContain("only");
  });

  it("uses error string when standard message fields absent", () => {
    const e = createHttpJsonApiError({
      method: "GET",
      url: "https://x",
      httpStatus: 400,
      errorData: { error: "e1" },
    });
    expect(e.message).toContain("e1");
  });

  it("joins errors array when present", () => {
    const e = createHttpJsonApiError({
      method: "GET",
      url: "https://x",
      httpStatus: 422,
      errorData: { errors: ["a", "b"] },
    });
    expect(e.message).toContain("a, b");
  });

  it("falls back to JSON.stringify when no known message fields", () => {
    const e = createHttpJsonApiError({
      method: "GET",
      url: "https://x",
      httpStatus: 500,
      errorData: { unknown: true },
    });
    expect(e.message).toContain("unknown");
  });

  it("omits apiCode when raw code is not a finite number", () => {
    const e = createHttpJsonApiError({
      method: "GET",
      url: "https://x",
      httpStatus: 400,
      errorData: { message: "x", code: "E1" },
    });
    expect(e.apiCode).toBeUndefined();
  });

  it("uses pathname in message, not full URL", () => {
    const e = createHttpJsonApiError({
      method: "GET",
      url: "https://secret-host/v1/items?page=2",
      httpStatus: 500,
      errorData: { message: "oops" },
    });
    expect(e.message).toContain("[GET /v1/items]");
    expect(e.message).not.toContain("secret-host");
    expect(e.message).not.toContain("page=2");
    expect(e.url).toBe("https://secret-host/v1/items?page=2");
  });
});

describe("createApiResponseError", () => {
  it("includes empty suffix when response_message is undefined", () => {
    const e = createApiResponseError({
      method: "GET",
      url: "https://x",
      responseCode: 9,
      responseMessage: undefined,
    });
    expect(e.message).toBe("API Error 9: ");
  });

  it("includes response_message when set", () => {
    const e = createApiResponseError({
      method: "GET",
      url: "https://x",
      responseCode: 9,
      responseMessage: "oops",
    });
    expect(e.message).toBe("API Error 9: oops");
  });
});

describe("throwNonOkResponse", () => {
  it("uses plain HTTP error when body is not JSON", () => {
    const res = new Response("not-json", { status: 400, statusText: "Bad Request" });
    expect(() => throwNonOkResponse("GET", "https://rmp-api.rik.ee/v1/x", res, "not-json")).toThrow(
      EFinancialsApiError,
    );
  });

  it("uses plain HTTP error when JSON is a primitive", () => {
    const res = new Response("", { status: 400, statusText: "Bad Request" });
    expect(() => throwNonOkResponse("GET", "https://rmp-api.rik.ee/v1/x", res, "42")).toThrow(
      EFinancialsApiError,
    );
  });
});
