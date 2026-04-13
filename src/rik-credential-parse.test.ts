import { describe, expect, it } from "vitest";

import { parseRikAuthCredentialJson } from "./rik-credential-parse.js";

describe("parseRikAuthCredentialJson", () => {
  const validInner = {
    apiKeyId: "id",
    apiKeyPassword: "pw",
    apiKeyPublic: "pub",
  };

  it("parses with baseUrl in JSON when no column", () => {
    expect(
      parseRikAuthCredentialJson({ ...validInner, baseUrl: "https://rmp-api.rik.ee/" }, "k"),
    ).toEqual({
      ...validInner,
      baseUrl: "https://rmp-api.rik.ee",
    });
  });

  it("prefers baseUrlFromColumn over JSON baseUrl", () => {
    expect(
      parseRikAuthCredentialJson(
        { ...validInner, baseUrl: "https://demo-rmp-api.rik.ee/" },
        "k",
        "https://demo-rmp-api.rik.ee",
      ),
    ).toEqual({
      ...validInner,
      baseUrl: "https://demo-rmp-api.rik.ee",
    });
  });

  it("allows omitting baseUrl in JSON when column is set", () => {
    expect(parseRikAuthCredentialJson(validInner, "k", "https://demo-rmp-api.rik.ee")).toEqual({
      ...validInner,
      baseUrl: "https://demo-rmp-api.rik.ee",
    });
  });

  it("rejects non-object raw", () => {
    expect(() => parseRikAuthCredentialJson(null, "k")).toThrow(/must be a JSON object/);
    expect(() => parseRikAuthCredentialJson("x", "k")).toThrow(/must be a JSON object/);
  });

  it("rejects empty apiKeyId, password, public", () => {
    expect(() =>
      parseRikAuthCredentialJson({ ...validInner, apiKeyId: "" }, "k", "https://rmp-api.rik.ee"),
    ).toThrow(/apiKeyId/);
    expect(() =>
      parseRikAuthCredentialJson(
        { ...validInner, apiKeyPassword: "  " },
        "k",
        "https://rmp-api.rik.ee",
      ),
    ).toThrow(/apiKeyPassword/);
    expect(() =>
      parseRikAuthCredentialJson(
        { ...validInner, apiKeyPublic: "" },
        "k",
        "https://rmp-api.rik.ee",
      ),
    ).toThrow(/apiKeyPublic/);
  });

  it("rejects empty baseUrlFromColumn", () => {
    expect(() => parseRikAuthCredentialJson(validInner, "k", "  ")).toThrow(
      /baseUrl must be non-empty/,
    );
  });

  it("rejects missing baseUrl when no column", () => {
    expect(() => parseRikAuthCredentialJson(validInner, "k")).toThrow(/baseUrl/);
  });

  it("rejects disallowed base URL hostname", () => {
    expect(() =>
      parseRikAuthCredentialJson({ ...validInner, baseUrl: "https://evil.example/" }, "k"),
    ).toThrow(/hostname is not allowed/);
  });

  it("validates httpMaxRetries and httpRetryBaseMs", () => {
    expect(() =>
      parseRikAuthCredentialJson(
        { ...validInner, baseUrl: "https://rmp-api.rik.ee", httpMaxRetries: 1.5 },
        "k",
      ),
    ).toThrow(/httpMaxRetries/);
    expect(() =>
      parseRikAuthCredentialJson(
        { ...validInner, baseUrl: "https://rmp-api.rik.ee", httpMaxRetries: -1 },
        "k",
      ),
    ).toThrow(/httpMaxRetries/);
    expect(() =>
      parseRikAuthCredentialJson(
        { ...validInner, baseUrl: "https://rmp-api.rik.ee", httpRetryBaseMs: -1 },
        "k",
      ),
    ).toThrow(/httpRetryBaseMs/);
  });

  it("passes through optional retry fields", () => {
    expect(
      parseRikAuthCredentialJson(
        {
          ...validInner,
          baseUrl: "https://rmp-api.rik.ee",
          httpMaxRetries: 2,
          httpRetryBaseMs: 100,
        },
        "k",
      ),
    ).toEqual({
      ...validInner,
      baseUrl: "https://rmp-api.rik.ee",
      httpMaxRetries: 2,
      httpRetryBaseMs: 100,
    });
  });
});
