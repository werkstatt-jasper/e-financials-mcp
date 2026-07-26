import { describe, expect, it } from "vitest";
import { looksLikeBankFee } from "./fee-patterns.js";

describe("fee-patterns", () => {
  it("detects fee keywords under 50 EUR", () => {
    expect(looksLikeBankFee("Monthly bank fee", 3)).toBe(true);
    expect(looksLikeBankFee("teenustasu", 10)).toBe(true);
    expect(looksLikeBankFee("Salary", 10)).toBe(false);
    expect(looksLikeBankFee("bank fee", 51)).toBe(false);
    expect(looksLikeBankFee(null, 5)).toBe(false);
  });
});
