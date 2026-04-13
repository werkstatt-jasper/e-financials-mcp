import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertAllowedRikBaseUrl,
  DEFAULT_ALLOWED_RIK_HOSTS,
  RikBaseUrlNotAllowedError,
} from "./rik-base-url.js";

describe("assertAllowedRikBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows default hosts with https", () => {
    assertAllowedRikBaseUrl("https://rmp-api.rik.ee");
    assertAllowedRikBaseUrl("https://demo-rmp-api.rik.ee/");
    assertAllowedRikBaseUrl("HTTPS://RMP-API.RIK.EE");
  });

  it("allows bare hostname by assuming https", () => {
    assertAllowedRikBaseUrl("demo-rmp-api.rik.ee");
  });

  it("rejects invalid URL", () => {
    expect(() => assertAllowedRikBaseUrl("not a url")).toThrow(RikBaseUrlNotAllowedError);
    expect(() => assertAllowedRikBaseUrl("not a url")).toThrow(/valid https URL/);
  });

  it("rejects http", () => {
    expect(() => assertAllowedRikBaseUrl("http://rmp-api.rik.ee")).toThrow(
      RikBaseUrlNotAllowedError,
    );
    expect(() => assertAllowedRikBaseUrl("http://rmp-api.rik.ee")).toThrow(/https/);
  });

  it("rejects non-allowlisted hostname", () => {
    expect(() => assertAllowedRikBaseUrl("https://evil.com")).toThrow(RikBaseUrlNotAllowedError);
    expect(() => assertAllowedRikBaseUrl("https://rmp-api.rik.ee.evil.com")).toThrow(
      RikBaseUrlNotAllowedError,
    );
  });

  it("rejects userinfo in URL", () => {
    expect(() => assertAllowedRikBaseUrl("https://user:pass@rmp-api.rik.ee")).toThrow(
      RikBaseUrlNotAllowedError,
    );
    expect(() => assertAllowedRikBaseUrl("https://169.254.169.254@rmp-api.rik.ee")).toThrow(
      RikBaseUrlNotAllowedError,
    );
  });

  describe("MCP_ALLOWED_RIK_HOSTS override", () => {
    beforeEach(() => {
      vi.stubEnv("MCP_ALLOWED_RIK_HOSTS", "custom-only.example");
    });

    it("replaces defaults entirely", () => {
      expect(() => assertAllowedRikBaseUrl("https://rmp-api.rik.ee")).toThrow(
        RikBaseUrlNotAllowedError,
      );
      assertAllowedRikBaseUrl("https://custom-only.example");
    });
  });

  it("trims and splits MCP_ALLOWED_RIK_HOSTS", () => {
    vi.stubEnv("MCP_ALLOWED_RIK_HOSTS", "  a.example , B.example , ");
    assertAllowedRikBaseUrl("https://a.example");
    assertAllowedRikBaseUrl("https://b.example");
    expect(() => assertAllowedRikBaseUrl("https://rmp-api.rik.ee")).toThrow(
      RikBaseUrlNotAllowedError,
    );
  });
});

describe("DEFAULT_ALLOWED_RIK_HOSTS", () => {
  it("lists official RIK hosts", () => {
    expect(DEFAULT_ALLOWED_RIK_HOSTS).toEqual(["rmp-api.rik.ee", "demo-rmp-api.rik.ee"]);
  });
});
