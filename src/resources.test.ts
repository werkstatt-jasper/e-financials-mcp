import { describe, expect, it } from "vitest";
import {
  DEDUCTION_AND_LIMIT_RULES,
  REDUCED_VAT_RATES,
  STANDARD_VAT_RATE_TIMELINE,
} from "./estonian-vat.js";
import {
  buildAllResources,
  EFINANCIALS_URI_SCHEME,
  matchUriTemplate,
  TAX_RULES_URI,
} from "./resources.js";

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
  it("registers server_info and tax_rules under efinancials:// scheme", () => {
    const registry = buildAllResources();
    expect(registry.resources.server_info.uri).toBe(`${EFINANCIALS_URI_SCHEME}server_info`);
    expect(registry.resources.tax_rules.uri).toBe(TAX_RULES_URI);
    expect(TAX_RULES_URI).toBe("efinancials://tax_rules");
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

  it("tax_rules read returns P0.4 statutory data with advisory non-goals", () => {
    const result = buildAllResources().resources.tax_rules.read();
    expect(result.uri).toBe(TAX_RULES_URI);
    expect(result.mimeType).toBe("application/json");
    const parsed = JSON.parse(result.text) as {
      advisory: boolean;
      uriScheme: string;
      disclaimer: string;
      nonGoals: string[];
      standardVatRateTimeline: unknown;
      reducedVatRates: unknown;
      deductionAndLimitRules: unknown;
    };
    expect(parsed.advisory).toBe(true);
    expect(parsed.uriScheme).toBe(EFINANCIALS_URI_SCHEME);
    expect(parsed.disclaimer.toLowerCase()).toContain("advisory");
    expect(parsed.disclaimer.toLowerCase()).toContain("not legal");
    expect(parsed.nonGoals.some((item) => /kmd|vat return/i.test(item))).toBe(true);
    expect(parsed.nonGoals.some((item) => /emta prepayment/i.test(item))).toBe(true);
    expect(parsed.standardVatRateTimeline).toEqual(STANDARD_VAT_RATE_TIMELINE);
    expect(parsed.reducedVatRates).toEqual(REDUCED_VAT_RATES);
    expect(parsed.deductionAndLimitRules).toEqual(DEDUCTION_AND_LIMIT_RULES);
    expect(STANDARD_VAT_RATE_TIMELINE).toEqual([
      { from: "2009-07-01", to: "2023-12-31", rate: 20 },
      { from: "2024-01-01", to: "2025-06-30", rate: 22 },
      { from: "2025-07-01", to: null, rate: 24 },
    ]);
  });
});
