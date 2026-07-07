import { describe, expect, it } from "vitest";
import { buildAllResources, EFINANCIALS_URI_SCHEME, matchUriTemplate } from "./resources.js";

describe("matchUriTemplate", () => {
  it("captures single variable", () => {
    expect(matchUriTemplate("efinancials://items/{id}", "efinancials://items/42")).toEqual({
      id: "42",
    });
  });

  it("captures multiple variables", () => {
    expect(matchUriTemplate("efinancials://{kind}/{id}", "efinancials://invoices/abc-123")).toEqual(
      {
        kind: "invoices",
        id: "abc-123",
      },
    );
  });

  it("returns null when URI does not match", () => {
    expect(matchUriTemplate("efinancials://items/{id}", "efinancials://other/42")).toBeNull();
    expect(matchUriTemplate("efinancials://items/{id}", "efinancials://items/42/extra")).toBeNull();
  });

  it("decodes percent-encoded segments", () => {
    expect(
      matchUriTemplate("efinancials://docs/{name}", "efinancials://docs/hello%20world"),
    ).toEqual({ name: "hello world" });
  });

  it("matches literal templates without variables", () => {
    expect(matchUriTemplate("efinancials://fixed", "efinancials://fixed")).toEqual({});
    expect(matchUriTemplate("efinancials://fixed", "efinancials://other")).toBeNull();
  });

  it("escapes regex metacharacters in literal template segments", () => {
    expect(matchUriTemplate("efinancials://v1.0/{id}", "efinancials://v1.0/42")).toEqual({
      id: "42",
    });
    expect(matchUriTemplate("efinancials://v1.0/{id}", "efinancials://vX0/42")).toBeNull();
  });
});

describe("buildAllResources", () => {
  it("registers server_info under efinancials:// scheme", () => {
    const registry = buildAllResources();
    expect(registry.resources.server_info.uri).toBe(`${EFINANCIALS_URI_SCHEME}server_info`);
    expect(registry.templates).toEqual({});
  });

  it("server_info read returns JSON metadata", () => {
    const result = buildAllResources().resources.server_info.read();
    expect(result.mimeType).toBe("application/json");
    const parsed = JSON.parse(result.text) as {
      name: string;
      version: string;
      capabilities: string[];
    };
    expect(parsed.name).toBe("e-financials");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.capabilities).toEqual(["tools", "prompts", "resources"]);
  });
});
