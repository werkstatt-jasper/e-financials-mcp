import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createMockClient } from "../tools/test-helpers.js";
import { registerPurchaseInvoiceWithRepair } from "./register-purchase-invoice.js";

describe("registerPurchaseInvoiceWithRepair", () => {
  let client: EFinancialsClient;

  beforeEach(() => {
    client = createMockClient();
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          id: 42,
          vat_price: 0,
          gross_price: 100,
          items: [{ total_net_price: 100, vat_amount: 24 }],
        };
      }
      return {};
    });
    vi.mocked(client.patch).mockResolvedValue({ status: "CONFIRMED" } as never);
  });

  it("repairs drifted totals then registers", async () => {
    const result = await registerPurchaseInvoiceWithRepair(client, { id: 42 });
    expect(result.repaired).toBe(true);
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/42", {
      vat_price: 24,
      gross_price: 124,
      items: [{ total_net_price: 100, vat_amount: 24 }],
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/42/register");
  });

  it("skips repair when totals already match", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      return {
        id: 42,
        vat_price: 24,
        gross_price: 124,
        items: [{ total_net_price: 100, vat_amount: 24 }],
      };
    });
    const result = await registerPurchaseInvoiceWithRepair(client, { id: 42 });
    expect(result.repaired).toBe(false);
    expect(client.patch).toHaveBeenCalledTimes(1);
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/42/register");
  });

  it("non-VAT company sets vat_price 0 and gross from item nets + item VAT", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "", tax_refnumber: "1" };
      }
      return {
        id: 7,
        vat_price: 10,
        gross_price: 50,
        items: [{ total_net_price: 50, vat_amount: 12 }],
      };
    });
    const result = await registerPurchaseInvoiceWithRepair(client, { id: 7 });
    expect(result.repaired).toBe(true);
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/7", {
      vat_price: 0,
      gross_price: 62,
      items: [{ total_net_price: 50, vat_amount: 12 }],
    });
  });

  it("preserve_existing_totals skips repair when gross and vat present", async () => {
    const result = await registerPurchaseInvoiceWithRepair(client, {
      id: 42,
      preserve_existing_totals: true,
    });
    expect(result.repaired).toBe(false);
    expect(client.patch).toHaveBeenCalledTimes(1);
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/42/register");
  });

  it("preserve_existing_totals still repairs when gross missing", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      return {
        id: 42,
        vat_price: 24,
        gross_price: null,
        items: [{ total_net_price: 100, vat_amount: 24 }],
      };
    });
    const result = await registerPurchaseInvoiceWithRepair(client, {
      id: 42,
      preserve_existing_totals: true,
    });
    expect(result.repaired).toBe(true);
  });

  it("uses vat_price / net_price fallbacks on items", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      return {
        id: 3,
        vat_price: 0,
        gross_price: 10,
        items: [{ net_price: 100, vat_price: 24 }],
      };
    });
    await registerPurchaseInvoiceWithRepair(client, { id: 3 });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/3",
      expect.objectContaining({ vat_price: 24, gross_price: 124 }),
    );
  });

  it("ignores non-numeric item vat/net when summing", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      return {
        id: 4,
        vat_price: 0,
        gross_price: 10,
        items: [
          { total_net_price: "bad", vat_amount: "bad" },
          {},
          { total_net_price: 100, vat_amount: 24 },
        ],
      };
    });
    await registerPurchaseInvoiceWithRepair(client, { id: 4 });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/4",
      expect.objectContaining({ vat_price: 24, gross_price: 124 }),
    );
  });

  it("treats non-array items as empty", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" } as never;
      }
      return { id: 11, vat_price: 0, gross_price: 10, items: null } as never;
    });
    const result = await registerPurchaseInvoiceWithRepair(client, { id: 11 });
    expect(result.repaired).toBe(false);
  });

  it("registers without repair when invoice has no items", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      return { id: 9, vat_price: 0, gross_price: 10 };
    });
    const result = await registerPurchaseInvoiceWithRepair(client, { id: 9 });
    expect(result.repaired).toBe(false);
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/9/register");
  });

  it("non-VAT preserve skips when gross present even without vat_price", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "  ", tax_refnumber: "1" };
      }
      return {
        id: 8,
        vat_price: null,
        gross_price: 50,
        items: [{ total_net_price: 50, vat_amount: 0 }],
      };
    });
    const result = await registerPurchaseInvoiceWithRepair(client, {
      id: 8,
      preserve_existing_totals: true,
    });
    expect(result.repaired).toBe(false);
    expect(client.patch).toHaveBeenCalledTimes(1);
  });
});
