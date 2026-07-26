import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { createMockClient } from "../tools/test-helpers.js";
import type { PurchaseArticle } from "../types/accounts.js";
import {
  applyPurchaseVatDefaults,
  clearAllVatWarnings,
  clearVatWarnings,
  isCompanyVatRegistered,
} from "./purchase-vat-defaults.js";

function article(overrides: Partial<PurchaseArticle> = {}): PurchaseArticle {
  return {
    id: 1,
    level: 1,
    name_est: "Kontoritarbed",
    name_eng: "Office supplies",
    accounts_id: 4000,
    priority: 1,
    cl_account_groups: [],
    ...overrides,
  };
}

describe("isCompanyVatRegistered", () => {
  it("is true when vat_number is non-empty", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue({ vat_number: "EE123", tax_refnumber: "1" } as never);
    await expect(isCompanyVatRegistered(client)).resolves.toBe(true);
  });

  it("is false when vat_number is empty", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue({ vat_number: "  ", tax_refnumber: "1" } as never);
    await expect(isCompanyVatRegistered(client)).resolves.toBe(false);
  });
});

describe("applyPurchaseVatDefaults", () => {
  beforeEach(() => {
    clearAllVatWarnings();
  });

  it("uses selected article VAT fields when present", () => {
    const articles = [
      article({
        id: 39,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        vat_rate_dropdown: "24",
      }),
    ];
    const result = applyPurchaseVatDefaults(
      articles,
      { cl_purchase_articles_id: 39, vat_rate_dropdown: "24" },
      true,
    );
    expect(result.vat_accounts_id).toBe(1510);
    expect(result.cl_vat_articles_id).toBe(1);
  });

  it("matches article by rate when selected has no VAT ids", () => {
    const articles = [
      article({ id: 10 }),
      article({
        id: 20,
        name_est: "Teenused",
        vat_accounts_id: 1511,
        cl_vat_articles_id: 2,
        vat_rate: 9,
      }),
    ];
    const result = applyPurchaseVatDefaults(
      articles,
      { cl_purchase_articles_id: 10, vat_rate_dropdown: "9" },
      true,
    );
    expect(result.vat_accounts_id).toBe(1511);
    expect(result.cl_vat_articles_id).toBe(2);
  });

  it("matches käibemaks keyword for registered companies", () => {
    const articles = [
      article({
        id: 5,
        name_est: "Käibemaks 24%",
        name_eng: "VAT 24%",
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
      }),
    ];
    const result = applyPurchaseVatDefaults(articles, { cl_purchase_articles_id: 99 }, true);
    expect(result.vat_accounts_id).toBe(1510);
  });

  it("falls back to 1510/1 for registered with warning dedupe", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const result = applyPurchaseVatDefaults([], { cl_purchase_articles_id: 39 }, true);
    expect(result.vat_accounts_id).toBe(1510);
    expect(result.cl_vat_articles_id).toBe(1);
    applyPurchaseVatDefaults([], { cl_purchase_articles_id: 39 }, true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("defaults non-registered rate to '-'", () => {
    const result = applyPurchaseVatDefaults([], {}, false);
    expect(result.vat_rate_dropdown).toBe("-");
    expect(result.vat_accounts_id).toBeUndefined();
  });

  it("uses non-deductible article 11 when non-registered has a rate", () => {
    const result = applyPurchaseVatDefaults(
      [],
      { vat_rate_dropdown: "24", purchase_accounts_id: 4000 },
      false,
    );
    expect(result.cl_vat_articles_id).toBe(11);
    expect(result.vat_accounts_id).toBe(4000);
  });

  it("matches non-deduct keyword for non-registered", () => {
    const articles = [
      article({
        id: 7,
        name_eng: "Non-deductible VAT",
        vat_accounts_id: 4001,
        cl_vat_articles_id: 11,
      }),
    ];
    const result = applyPurchaseVatDefaults(articles, { vat_rate_dropdown: "24" }, false);
    expect(result.vat_accounts_id).toBe(4001);
    expect(result.cl_vat_articles_id).toBe(11);
  });

  it("clearVatWarnings scopes dedupe keys", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    clearVatWarnings("co-a");
    applyPurchaseVatDefaults([], {}, true);
    clearVatWarnings("co-b");
    applyPurchaseVatDefaults([], {}, true);
    clearVatWarnings();
    applyPurchaseVatDefaults([], {}, true);
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    warn.mockRestore();
  });

  it("skips registered keyword match when name is non-deductible VAT", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const result = applyPurchaseVatDefaults(
      [
        article({
          id: 1,
          name_est: "VAT non-deduct mahaarv",
          name_eng: "VAT non-deduct",
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
        }),
      ],
      { cl_purchase_articles_id: 99 },
      true,
    );
    expect(result.vat_accounts_id).toBe(1510);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("matches mitte keyword for non-registered", () => {
    expect(
      applyPurchaseVatDefaults(
        [
          article({
            id: 3,
            name_est: "Mitte kohustuslane",
            name_eng: "x",
            vat_accounts_id: 4002,
            cl_vat_articles_id: 11,
          }),
        ],
        { vat_rate_dropdown: "24" },
        false,
      ).vat_accounts_id,
    ).toBe(4002);
  });

  it("matches kaibemaks without umlaut and mahaarv for non-registered", () => {
    expect(
      applyPurchaseVatDefaults(
        [
          article({
            id: 1,
            name_est: "Kaibemaks",
            name_eng: "x",
            vat_accounts_id: 1510,
            cl_vat_articles_id: 1,
          }),
        ],
        { cl_purchase_articles_id: 99 },
        true,
      ).vat_accounts_id,
    ).toBe(1510);

    expect(
      applyPurchaseVatDefaults(
        [
          article({
            id: 2,
            name_est: "Mahaarvamata",
            name_eng: "x",
            vat_accounts_id: 4000,
            cl_vat_articles_id: 11,
          }),
        ],
        { vat_rate_dropdown: "24" },
        false,
      ).cl_vat_articles_id,
    ).toBe(11);
  });

  it("normalizes blank and junk vat_rate_dropdown strings", () => {
    const withBlank = applyPurchaseVatDefaults(
      [article({ id: 1, vat_accounts_id: 1, cl_vat_articles_id: 1, vat_rate_dropdown: "24" })],
      { vat_rate_dropdown: "   ", cl_purchase_articles_id: 99 },
      true,
    );
    expect(withBlank.vat_rate_dropdown).toBe("-");

    const withJunk = applyPurchaseVatDefaults(
      [article({ id: 2, vat_accounts_id: 9, cl_vat_articles_id: 1, vat_rate_dropdown: "xyz" })],
      { vat_rate_dropdown: "xyz", cl_purchase_articles_id: 2 },
      true,
    );
    expect(withJunk.vat_accounts_id).toBe(9);
  });

  it("preserves explicit caller vat account ids", () => {
    const result = applyPurchaseVatDefaults(
      [],
      { vat_rate_dropdown: "24", vat_accounts_id: 999, cl_vat_articles_id: 3 },
      true,
    );
    expect(result.vat_accounts_id).toBe(999);
    expect(result.cl_vat_articles_id).toBe(3);
  });
});
