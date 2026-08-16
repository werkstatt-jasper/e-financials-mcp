import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createMockClient } from "../tools/test-helpers.js";
import { createPurchaseInvoiceWithRepair } from "./create-purchase-invoice.js";
import { clearAllVatWarnings } from "./purchase-vat-defaults.js";

describe("createPurchaseInvoiceWithRepair", () => {
  let client: EFinancialsClient;

  beforeEach(() => {
    clearAllVatWarnings();
    client = createMockClient();
    vi.mocked(client.getAllPages).mockResolvedValue([]);
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE123", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          id: 42,
          clients_id: 1,
          status: "PROJECT",
          payment_status: "NOT_PAID",
          cl_currencies_id: "EUR",
          gross_price: 0,
          vat_price: 0,
          items: [{ total_net_price: 100, vat_amount: 24 }],
        };
      }
      return {};
    });
    vi.mocked(client.post).mockResolvedValue({ id: 42 } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    vi.mocked(client.delete).mockResolvedValue({} as never);
  });

  it("posts draft then patches totals (create-then-repair)", async () => {
    const result = await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-1",
      invoice_date: "2025-06-01",
      total_amount: 120,
      vat_amount: 20,
      vat_rate: 24,
    });
    expect(result.id).toBe(42);
    expect(result.repaired).toBe(true);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({
        number: "P-1",
        items: [
          expect.objectContaining({
            cl_purchase_articles_id: 39,
            vat_rate_dropdown: "24",
          }),
        ],
      }),
    );
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({
        vat_price: 20,
        gross_price: 120,
        items: expect.arrayContaining([
          expect.objectContaining({ total_net_price: 100, vat_amount: 24 }),
        ]),
      }),
    );
  });

  it("skips totals repair when GET already has matching vat/gross", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE123", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          id: 42,
          clients_id: 1,
          status: "PROJECT",
          payment_status: "NOT_PAID",
          cl_currencies_id: "EUR",
          gross_price: 124,
          vat_price: 24,
          items: [{ total_net_price: 100, vat_amount: 24 }],
        };
      }
      return {};
    });
    const result = await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-skip",
      invoice_date: "2025-06-01",
      items: [{ custom_title: "A", total_net_price: 100, vat_rate: 24 }],
    });
    expect(result.repaired).toBe(false);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("requires currency_rate for non-EUR", async () => {
    await expect(
      createPurchaseInvoiceWithRepair(client, {
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "P-1",
        invoice_date: "2025-06-01",
        total_amount: 10,
        cl_currencies_id: "USD",
      }),
    ).rejects.toThrow(/currency_rate/);
  });

  it("derives header VAT from line rates when vat_amount is omitted", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-VAT",
      invoice_date: "2025-06-01",
      items: [{ custom_title: "Legal", total_net_price: 14.54, vat_rate: 22 }],
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({
        vat_price: 3.2,
        gross_price: 17.74,
      }),
    );
  });

  it("prefers derived line totals over a conflicting total_amount", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-CONFLICT",
      invoice_date: "2025-06-01",
      total_amount: 22,
      items: [{ custom_title: "Legal", total_net_price: 14.54, vat_rate: 22 }],
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({
        vat_price: 3.2,
        gross_price: 17.74,
      }),
    );
  });

  it("derives VAT from vat_rate on friendly params when vat_amount omitted", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-FRIENDLY-VAT",
      invoice_date: "2025-06-01",
      total_amount: 122,
      vat_rate: 22,
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as {
      vat_price: number;
      gross_price: number;
      items: { total_net_price: number }[];
    };
    expect(body.vat_price).toBe(22);
    expect(body.gross_price).toBe(122);
    expect(body.items[0].total_net_price).toBe(100);
  });

  it("posts cash-payment fields when provided", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-CASH",
      invoice_date: "2025-06-01",
      total_amount: 50,
      paid_in_cash: true,
      cash_accounts_id: 1360,
      cash_accounts_dimensions_id: 407164,
      cash_payment_date: "2025-06-01",
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({
        paid_in_cash: true,
        cash_accounts_id: 1360,
        cash_accounts_dimensions_id: 407164,
        cash_payment_date: "2025-06-01",
      }),
    );
  });

  it("supports multi-line items", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-2",
      invoice_date: "2025-06-01",
      items: [
        { custom_title: "A", total_net_price: 10, vat_rate: 24 },
        { custom_title: "B", total_net_price: 20, vat_rate: 24 },
      ],
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it("derives FX base_net when line base prices omitted", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-FX2",
      invoice_date: "2025-06-01",
      total_amount: 10,
      cl_currencies_id: "USD",
      currency_rate: 0.85,
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as {
      items: { base_net_price?: number }[];
    };
    expect(body.items[0].base_net_price).toBeGreaterThan(0);
  });

  it("repairs multi-line project_no_vat when explicit VAT differs", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          id: 42,
          items: [
            { total_net_price: 50, vat_amount: 12, project_no_vat_gross_price: 0 },
            { total_net_price: 50, vat_amount: 12, project_no_vat_gross_price: 0 },
          ],
        };
      }
      return {};
    });
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-ML",
      invoice_date: "2025-06-01",
      total_amount: 124.5,
      vat_amount: 24.5,
      explicit_totals: true,
      items: [
        { custom_title: "A", total_net_price: 50, vat_rate: 24 },
        { custom_title: "B", total_net_price: 50, vat_rate: 24 },
      ],
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({ items: expect.any(Array) }),
    );
  });

  it("explicit_totals without amounts falls back to item sums", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-E",
      invoice_date: "2025-06-01",
      explicit_totals: true,
      items: [{ custom_title: "A", total_net_price: 100, vat_rate: 24 }],
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({ vat_price: 24, gross_price: 124 }),
    );
  });

  it("uses vat_price field when vat_amount missing on fetched items", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          id: 42,
          items: [{ total_net_price: 100, vat_price: 24 }],
        };
      }
      return {};
    });
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-VP",
      invoice_date: "2025-06-01",
      items: [{ custom_title: "A", total_net_price: 100, vat_rate: 24 }],
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({ vat_price: 24 }),
    );
  });

  it("sums item VAT/net via alternate fields and ignores non-numbers", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          id: 42,
          items: [
            { net_price: 40, vat_price: 10 },
            { total_net_price: "bad", vat_amount: "bad" },
            {},
          ],
        };
      }
      return {};
    });
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-ALT",
      invoice_date: "2025-06-01",
      items: [{ custom_title: "A", total_net_price: 0, vat_rate: 24 }],
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({ vat_price: 10, gross_price: 50 }),
    );
  });

  it("derives totals when explicit_totals is false", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-D",
      invoice_date: "2025-06-01",
      items: [{ custom_title: "A", total_net_price: 40, vat_rate: 24 }],
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({ vat_price: 24, gross_price: 124 }),
    );
  });

  it("uses itemNet for non-VAT when total_amount omitted", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return { id: 9, items: [{ total_net_price: 33, vat_amount: 0 }] };
      }
      return {};
    });
    vi.mocked(client.post).mockResolvedValue({ id: 9 } as never);
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-NV2",
      invoice_date: "2025-06-01",
      items: [{ custom_title: "A", total_net_price: 33 }],
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/9",
      expect.objectContaining({ vat_price: 0, gross_price: 33 }),
    );
  });

  it("handles fetched invoice without items array", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return { id: 42, gross_price: 10 };
      }
      return {};
    });
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-empty",
      invoice_date: "2025-06-01",
      total_amount: 10,
      vat_amount: 0,
      explicit_totals: true,
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({ gross_price: 10, vat_price: 0, items: [] }),
    );
  });

  it("wraps non-Error throwables during cleanup", async () => {
    vi.mocked(client.patch).mockRejectedValueOnce("string-fail");
    await expect(
      createPurchaseInvoiceWithRepair(client, {
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "P-S",
        invoice_date: "2025-06-01",
        total_amount: 10,
      }),
    ).rejects.toThrow(/string-fail/);
  });

  it("non-VAT company keeps invoice vat_price 0", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          id: 7,
          items: [{ total_net_price: 50, vat_amount: 0 }],
        };
      }
      return {};
    });
    vi.mocked(client.post).mockResolvedValue({ id: 7 } as never);
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-3",
      invoice_date: "2025-06-01",
      total_amount: 50,
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/7",
      expect.objectContaining({ vat_price: 0 }),
    );
  });

  it("cleans up draft when repair patch fails", async () => {
    vi.mocked(client.patch).mockRejectedValueOnce(new Error("patch boom"));
    await expect(
      createPurchaseInvoiceWithRepair(client, {
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "P-4",
        invoice_date: "2025-06-01",
        total_amount: 10,
      }),
    ).rejects.toThrow(/cleaned up/);
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/42/invalidate");
  });

  it("reports orphaned id when cleanup also fails", async () => {
    vi.mocked(client.patch).mockImplementation(async (path: string) => {
      if (path.includes("/invalidate")) {
        throw new Error("invalidate fail");
      }
      throw new Error("patch boom");
    });
    vi.mocked(client.delete).mockRejectedValue(new Error("delete fail"));
    await expect(
      createPurchaseInvoiceWithRepair(client, {
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "P-5",
        invoice_date: "2025-06-01",
        total_amount: 10,
      }),
    ).rejects.toThrow(/cleanup also failed/);
  });

  it("includes FX base prices and currency_rate on post", async () => {
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-FX",
      invoice_date: "2025-06-01",
      total_amount: 10,
      cl_currencies_id: "USD",
      currency_rate: 0.9,
      base_gross_price: 9,
      base_vat_price: 0,
      base_net_price: 9,
      items: [
        {
          custom_title: "Line",
          total_net_price: 10,
          vat_rate: 0,
          base_net_price: 9,
          base_vat_price: 0,
          base_gross_price: 9,
        },
      ],
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({
        currency_rate: 0.9,
        base_gross_price: 9,
        items: [
          expect.objectContaining({
            base_net_price: 9,
            base_vat_price: 0,
            base_gross_price: 9,
          }),
        ],
      }),
    );
  });

  it("sets project_no_vat_gross_price for non-VAT company with a rate", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return { id: 8, items: [{ total_net_price: 100, vat_amount: 0 }] };
      }
      return {};
    });
    vi.mocked(client.post).mockResolvedValue({ id: 8 } as never);
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-NV",
      invoice_date: "2025-06-01",
      total_amount: 124,
      vat_rate: 24,
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as {
      items: { project_no_vat_gross_price?: number }[];
    };
    expect(body.items[0].project_no_vat_gross_price).toBeGreaterThan(0);
  });

  it("throws when API omits id and when total_amount missing without items", async () => {
    vi.mocked(client.post).mockResolvedValueOnce({} as never);
    await expect(
      createPurchaseInvoiceWithRepair(client, {
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "P-x",
        invoice_date: "2025-06-01",
        total_amount: 1,
      }),
    ).rejects.toThrow(/did not return an id/);

    await expect(
      createPurchaseInvoiceWithRepair(client, {
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "P-y",
        invoice_date: "2025-06-01",
      }),
    ).rejects.toThrow(/total_amount is required/);
  });

  it("falls back to delete when invalidate cleanup fails", async () => {
    vi.mocked(client.patch).mockImplementation(async (path: string) => {
      if (path.includes("/invalidate")) {
        throw new Error("no invalidate");
      }
      throw new Error("patch boom");
    });
    vi.mocked(client.delete).mockResolvedValue({} as never);
    await expect(
      createPurchaseInvoiceWithRepair(client, {
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "P-del",
        invoice_date: "2025-06-01",
        total_amount: 10,
      }),
    ).rejects.toThrow(/cleaned up/);
    expect(client.delete).toHaveBeenCalledWith("/v1/purchase_invoices/42");
  });

  it("applies rounding repair when explicit VAT differs from item VAT", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          id: 42,
          items: [{ total_net_price: 100, vat_amount: 24, project_no_vat_gross_price: 0 }],
        };
      }
      return {};
    });
    await createPurchaseInvoiceWithRepair(client, {
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "P-6",
      invoice_date: "2025-06-01",
      total_amount: 124.01,
      vat_amount: 24.01,
      vat_rate: 24,
      explicit_totals: true,
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ project_no_vat_gross_price: expect.any(Number) }),
        ]),
      }),
    );
  });
});
