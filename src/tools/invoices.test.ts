import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import invoicesFixture from "../__fixtures__/invoices.json" with { type: "json" };
import { createHttpJsonApiError } from "../api-error.js";
import type { EFinancialsClient } from "../client.js";
import { createInvoiceTools, mergePurchaseInvoiceItems } from "./invoices.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("invoice tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createInvoiceTools>;

  beforeEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
    client = createMockClient();
    tools = createInvoiceTools(client);
    vi.mocked(readFile).mockReset();
  });

  it("validate_invoice_data returns structured validity without API calls", async () => {
    const result = await tools.validate_invoice_data.handler({
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      items: [{ total_net_price: 100, vat_rate_dropdown: "24" }],
      invoice_date: "2025-08-01",
    });
    expect(client.get).not.toHaveBeenCalled();
    const data = parseToolJson(result) as { valid: boolean; errors: string[] };
    expect(data.valid).toBe(true);
    expect(data.errors).toEqual([]);
  });

  it("list_sales_invoices returns items and pagination", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...invoicesFixture.sales_list_paginated } as never);

    const result = await tools.list_sales_invoices.handler({ page: 1, status: "PROJECT" });
    expect(client.get).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ page: 1, status: "PROJECT" }),
    );
    const data = parseToolJson(result) as { items: unknown[]; current_page: number };
    expect(data.items).toHaveLength(1);
    expect(data.current_page).toBe(1);
  });

  it("list_sales_invoices passes modified_since", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...invoicesFixture.sales_empty_response } as never);
    await tools.list_sales_invoices.handler({ modified_since: "2026-10-01T00:00:00Z" });
    expect(client.get).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ modified_since: "2026-10-01T00:00:00Z" }),
    );
  });

  it("list_sales_invoices handles empty items", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...invoicesFixture.sales_empty_response } as never);
    const result = await tools.list_sales_invoices.handler({});
    const data = parseToolJson(result) as { items: unknown[] };
    expect(data.items).toEqual([]);
  });

  it("create_sales_invoice fetches defaults and posts full API payload", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [{ id: 1, is_default: true, number_prefix: "INV", number_start_value: 1001 }],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 5 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 42, name: "Service" }] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    const result = await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-15",
      rows: [{ description: "Line", quantity: 2, unit_price: 50 }],
    });

    expect(client.get).toHaveBeenCalledWith("/v1/invoice_series");
    expect(client.get).toHaveBeenCalledWith("/v1/templates");
    expect(client.get).toHaveBeenCalledWith("/v1/products");
    expect(client.post).toHaveBeenCalledWith("/v1/sale_invoices", {
      sale_invoice_type: "INVOICE",
      cl_templates_id: 5,
      clients_id: 1,
      cl_countries_id: "EST",
      number_prefix: "INV",
      number_suffix: "1001",
      create_date: "2025-06-01",
      journal_date: "2025-06-01",
      term_days: 14,
      cl_currencies_id: "EUR",
      show_client_balance: false,
      notes: undefined,
      items: [
        {
          custom_title: "Line",
          products_id: 42,
          amount: 2,
          unit_net_price: 50,
          total_net_price: 100,
          vat_accounts_id: undefined,
          sale_accounts_dimensions_id: undefined,
        },
      ],
    });
    const data = parseToolJson(result) as { success: boolean; id: number };
    expect(data.success).toBe(true);
    expect(data.id).toBe(200);
  });

  it("create_sales_invoice falls back to defaults when series/templates are empty", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({
        cl_templates_id: 1,
        number_suffix: "1",
        term_days: 0,
      }),
    );
  });

  it("create_sales_invoice uses non-default series when no default is flagged", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [{ id: 2, is_default: false, number_start_value: 500 }],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 7 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 10 }] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({
        cl_templates_id: 7,
        number_suffix: "500",
      }),
    );
    expect(vi.mocked(client.post).mock.calls[0]?.[1]).not.toHaveProperty("number_prefix");
  });

  it("create_sales_invoice increments suffix from a raw-array series and existing invoices", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce([
        { id: 1, is_default: true, number_prefix: "INV", number_start_value: 1 },
      ] as never)
      .mockResolvedValueOnce({ items: [{ id: 5 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 42 }] } as never);
    vi.mocked(client.getAllPages).mockResolvedValue([
      { number_prefix: "INV", number_suffix: "5" },
      { number_prefix: "OTH", number_suffix: "99" },
    ] as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
    });

    expect(client.getAllPages).toHaveBeenCalledWith("/v1/sale_invoices");
    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ number_suffix: "6" }),
    );
  });

  it("create_sales_invoice uses max suffix + 1 when series is empty", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ items: [{ id: 1 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 1 }] } as never);
    vi.mocked(client.getAllPages).mockResolvedValue([
      { number_prefix: "X", number_suffix: "1443" },
    ] as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ number_suffix: "1444" }),
    );
  });

  it("create_sales_invoice applies the default series prefix and ignores prefix-less suffixes (GitLab #240)", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [
          { id: 3, is_default: false, number_prefix: "NX", number_start_value: 1 },
          { id: 4, is_default: true, number_prefix: "2026", number_start_value: 1 },
        ],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 5 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 42 }] } as never);
    vi.mocked(client.getAllPages).mockResolvedValue([
      { number_prefix: "2026", number_suffix: "41" },
      { number_prefix: null, number_suffix: "7012" },
      { number_prefix: "", number_suffix: "7013" },
      { number_prefix: "NX", number_suffix: "900" },
    ] as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2026-01-10",
      due_date: "2026-01-24",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
    });

    const body = vi.mocked(client.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.number_prefix).toBe("2026");
    expect(body.number_suffix).toBe("42");
  });

  it("create_sales_invoice attaches the default series prefix to an explicit number_suffix (GitLab #240)", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [{ id: 4, is_default: true, number_prefix: "2026", number_start_value: 1 }],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 5 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 42 }] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2026-01-10",
      due_date: "2026-01-24",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
      number_suffix: "42",
    });

    expect(client.getAllPages).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ number_prefix: "2026", number_suffix: "42" }),
    );
  });

  it("create_sales_invoice uses an explicit number_prefix and continues that series", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [
          { id: 3, is_default: false, number_prefix: "NX", number_start_value: 500 },
          { id: 4, is_default: true, number_prefix: "2026", number_start_value: 1 },
        ],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 5 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 42 }] } as never);
    vi.mocked(client.getAllPages).mockResolvedValue([
      { number_prefix: "2026", number_suffix: "41" },
      { number_prefix: "NX", number_suffix: "503" },
    ] as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2026-01-10",
      due_date: "2026-01-24",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
      number_prefix: "NX",
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ number_prefix: "NX", number_suffix: "504" }),
    );
  });

  it("create_sales_invoice treats an empty number_prefix as omitted", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [{ id: 4, is_default: true, number_prefix: "2026", number_start_value: 7 }],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 5 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 42 }] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2026-01-10",
      due_date: "2026-01-24",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
      number_prefix: "",
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ number_prefix: "2026", number_suffix: "7" }),
    );
  });

  it("create_sales_invoice keeps an explicit number_suffix and skips listing invoices", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
      number_suffix: "2001",
    });

    expect(client.getAllPages).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ number_suffix: "2001" }),
    );
  });

  it("create_sales_invoice accepts explicit overrides for API fields", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
      sale_invoice_type: "CREDIT",
      cl_templates_id: 99,
      cl_countries_id: "FI",
      cl_currencies_id: "USD",
      show_client_balance: true,
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({
        sale_invoice_type: "CREDIT",
        cl_templates_id: 99,
        cl_countries_id: "FI",
        cl_currencies_id: "USD",
        show_client_balance: true,
      }),
    );
  });

  it("create_sales_invoice posts trade_secret when provided", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
      trade_secret: true,
    });

    const body = vi.mocked(client.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.trade_secret).toBe(true);
  });

  it("create_sales_invoice omits trade_secret when unset", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
    });

    const body = vi.mocked(client.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("trade_secret");
  });

  it("create_sales_invoice posts invoice_info and a distinct journal_date", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-08-20",
      due_date: "2025-09-03",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
      invoice_info: "1.osamakse",
      journal_date: "2025-07-31",
    });

    const body = vi.mocked(client.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.invoice_info).toBe("1.osamakse");
    expect(body.create_date).toBe("2025-08-20");
    expect(body.journal_date).toBe("2025-07-31");
  });

  it("create_sales_invoice omits invoice_info and copies invoice_date to journal_date", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10 }],
    });

    const body = vi.mocked(client.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("invoice_info");
    expect(body.journal_date).toBe("2025-06-01");
  });

  it("create_sales_invoice skips product lookup when all rows have products_id and unit", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [{ id: 1, is_default: true, number_start_value: 1 }],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 1 }] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10, products_id: 77, unit: "tk" }],
    });

    expect(client.get).not.toHaveBeenCalledWith("/v1/products");
    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({
        items: [expect.objectContaining({ products_id: 77, unit: "tk" })],
      }),
    );
  });

  it("create_sales_invoice copies product unit when products_id is set and unit is omitted", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [{ id: 1, is_default: true, number_start_value: 1 }],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 1 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 77, unit: "m3" }] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Vesi", quantity: 1, unit_price: 10, products_id: 77 }],
    });

    expect(client.get).toHaveBeenCalledWith("/v1/products");
    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({
        items: [expect.objectContaining({ products_id: 77, unit: "m3" })],
      }),
    );
  });

  it("create_sales_invoice fetches a missing product by id for unit fallback", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        items: [{ id: 1, is_default: true, number_start_value: 1 }],
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 1 }] } as never)
      .mockResolvedValueOnce({ items: [{ id: 1, unit: "tk" }] } as never)
      .mockResolvedValueOnce({ id: 77, unit: "m3" } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Vesi", quantity: 1, unit_price: 10, products_id: 77 }],
    });

    expect(client.get).toHaveBeenCalledWith("/v1/products/77");
    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({
        items: [expect.objectContaining({ products_id: 77, unit: "m3" })],
      }),
    );
  });

  it("create_sales_invoice posts an explicit row unit", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [] } as never)
      .mockResolvedValueOnce({ items: [{ id: 42, unit: "tk" }] } as never);
    vi.mocked(client.post).mockResolvedValue({ ...invoicesFixture.created_sales_invoice } as never);

    await tools.create_sales_invoice.handler({
      clients_id: 1,
      invoice_date: "2025-06-01",
      due_date: "2025-06-01",
      rows: [{ description: "Item", quantity: 1, unit_price: 10, unit: "m3" }],
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({
        items: [expect.objectContaining({ unit: "m3" })],
      }),
    );
  });

  it("update_sales_invoice remaps friendly rows to API items", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.sale_invoice_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 1 } as never);

    const newRows = [{ description: "R1", quantity: 2, unit_price: 5 }];
    await tools.update_sales_invoice.handler({
      id: 88,
      invoice_date: "2025-12-01",
      rows: newRows,
      cl_currencies_id: "GBP",
    });

    expect(client.patch).toHaveBeenCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({
        create_date: "2025-12-01",
        journal_date: "2025-01-01",
        items: [
          expect.objectContaining({
            custom_title: "R1",
            amount: 2,
            unit_net_price: 5,
            total_net_price: 10,
            products_id: 1,
          }),
        ],
        cl_currencies_id: "GBP",
      }),
    );
    const body = vi.mocked(client.patch).mock.calls[0]?.[1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]).not.toHaveProperty("description");
    expect(body.items[0]).not.toHaveProperty("quantity");
    expect(body.items[0]).not.toHaveProperty("unit_price");
  });

  it("update_sales_invoice skips product lookup when remapped rows already have unit", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.sale_invoice_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

    await tools.update_sales_invoice.handler({
      id: 88,
      rows: [{ description: "R1", quantity: 1, unit_price: 4, products_id: 77, unit: "m3" }],
    });

    expect(client.get).not.toHaveBeenCalledWith("/v1/products");
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({
        items: [expect.objectContaining({ custom_title: "R1", products_id: 77, unit: "m3" })],
      }),
    );
  });

  it("update_sales_invoice posts an explicit row unit and copies a product unit", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        ...invoicesFixture.sale_invoice_get_for_patch,
      } as never)
      .mockResolvedValueOnce({ items: [{ id: 77, unit: "krt." }] } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

    await tools.update_sales_invoice.handler({
      id: 88,
      rows: [
        { description: "A", quantity: 1, unit_price: 2, products_id: 77 },
        { description: "B", quantity: 1, unit_price: 3, products_id: 77, unit: "m3" },
      ],
    });

    const body = vi.mocked(client.patch).mock.calls[0]?.[1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]).toMatchObject({ custom_title: "A", unit: "krt." });
    expect(body.items[1]).toMatchObject({ custom_title: "B", unit: "m3" });
  });

  it("update_sales_invoice keeps current items when rows are omitted", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.sale_invoice_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

    await tools.update_sales_invoice.handler({
      id: 88,
      description: "New notes",
    });

    expect(client.get).not.toHaveBeenCalledWith("/v1/products");
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({
        items: invoicesFixture.sale_invoice_get_for_patch.items,
        notes: "New notes",
      }),
    );
  });

  it("update_sales_invoice fetches current invoice then patches merged payload", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.sale_invoice_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ ...invoicesFixture.patch_invoice_result } as never);

    const result = await tools.update_sales_invoice.handler({
      id: 88,
      description: "New notes",
    });

    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/88");
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({
        clients_id: 5,
        notes: "New notes",
      }),
    );
    const data = parseToolJson(result) as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toBe("Sales invoice 88 updated");
  });

  it("update_sales_invoice sets trade_secret and preserves it when omitted", async () => {
    vi.mocked(client.get).mockResolvedValue({
      ...invoicesFixture.sale_invoice_get_for_patch,
      trade_secret: false,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

    await tools.update_sales_invoice.handler({ id: 88, trade_secret: true });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({ trade_secret: true }),
    );

    await tools.update_sales_invoice.handler({ id: 88, description: "keep flag" });
    expect(client.patch).toHaveBeenLastCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({ trade_secret: false, notes: "keep flag" }),
    );
  });

  it("update_sales_invoice sets invoice_info and does not clobber journal_date", async () => {
    vi.mocked(client.get).mockResolvedValue({
      ...invoicesFixture.sale_invoice_get_for_patch,
      invoice_info: "old comment",
      journal_date: "2025-07-31",
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

    await tools.update_sales_invoice.handler({ id: 88, invoice_info: "new comment" });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({ invoice_info: "new comment", journal_date: "2025-07-31" }),
    );

    await tools.update_sales_invoice.handler({ id: 88, invoice_date: "2025-08-20" });
    expect(client.patch).toHaveBeenLastCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({
        create_date: "2025-08-20",
        journal_date: "2025-07-31",
        invoice_info: "old comment",
      }),
    );

    await tools.update_sales_invoice.handler({ id: 88, journal_date: "2025-06-15" });
    expect(client.patch).toHaveBeenLastCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({ journal_date: "2025-06-15" }),
    );
  });

  it("update_sales_invoice sets number_suffix and preserves it when omitted", async () => {
    vi.mocked(client.get).mockResolvedValue({
      ...invoicesFixture.sale_invoice_get_for_patch,
      number_suffix: "10",
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

    await tools.update_sales_invoice.handler({ id: 88, number_suffix: "11" });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({ number_suffix: "11" }),
    );

    await tools.update_sales_invoice.handler({ id: 88, description: "keep number" });
    expect(client.patch).toHaveBeenLastCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({ number_suffix: "10", notes: "keep number" }),
    );
  });

  describe("update_sales_invoice due_date", () => {
    const draft = () => ({
      ...invoicesFixture.sale_invoice_get_for_patch,
      id: 88,
      status: "PROJECT",
    });

    it("sends term_days from due_date and confirms it on read-back", async () => {
      vi.mocked(client.get)
        .mockResolvedValueOnce(draft() as never)
        .mockResolvedValueOnce({ ...draft(), term_days: 30 } as never);
      vi.mocked(client.patch).mockResolvedValue({
        ...invoicesFixture.patch_invoice_result,
      } as never);

      const result = await tools.update_sales_invoice.handler({ id: 88, due_date: "2025-01-31" });

      expect(client.patch).toHaveBeenCalledWith(
        "/v1/sale_invoices/88",
        expect.objectContaining({ create_date: "2025-01-01", term_days: 30 }),
      );
      expect(client.get).toHaveBeenNthCalledWith(2, "/v1/sale_invoices/88");
      const data = parseToolJson(result) as Record<string, unknown>;
      expect(data).toMatchObject({
        success: true,
        message: "Sales invoice 88 updated",
        due_date: "2025-01-31",
        due_date_applied: true,
      });
      expect(data).not.toHaveProperty("warnings");
    });

    it("counts term_days from a new invoice_date", async () => {
      vi.mocked(client.get)
        .mockResolvedValueOnce(draft() as never)
        .mockResolvedValueOnce({ ...draft(), create_date: "2025-02-10", term_days: 5 } as never);
      vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

      const result = await tools.update_sales_invoice.handler({
        id: 88,
        invoice_date: "2025-02-10",
        due_date: "2025-02-15",
      });

      expect(client.patch).toHaveBeenCalledWith(
        "/v1/sale_invoices/88",
        expect.objectContaining({ create_date: "2025-02-10", term_days: 5 }),
      );
      expect(parseToolJson(result)).toMatchObject({ due_date_applied: true });
    });

    it("warns when the API did not store the due date", async () => {
      vi.mocked(client.get)
        .mockResolvedValueOnce(draft() as never)
        .mockResolvedValueOnce(draft() as never);
      vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

      const result = await tools.update_sales_invoice.handler({ id: 88, due_date: "2025-01-31" });

      const data = parseToolJson(result) as {
        message: string;
        due_date: string | null;
        due_date_applied: boolean;
        warnings: string[];
      };
      expect(data.due_date_applied).toBe(false);
      expect(data.due_date).toBe("2025-01-15");
      expect(data.message).toBe("Sales invoice 88 updated, but due_date could not be confirmed");
      expect(data.warnings[0]).toContain("requested 2025-01-31, the API stored 2025-01-15");
    });

    it("warns when the read-back has no due date", async () => {
      vi.mocked(client.get)
        .mockResolvedValueOnce(draft() as never)
        .mockResolvedValueOnce({ id: 88 } as never);
      vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

      const result = await tools.update_sales_invoice.handler({ id: 88, due_date: "2025-01-31" });

      const data = parseToolJson(result) as { due_date: unknown; warnings: string[] };
      expect(data.due_date).toBeNull();
      expect(data.warnings[0]).toContain("the API stored no due date");
    });

    it("keeps the update result and warns when the read-back fails", async () => {
      vi.mocked(client.get)
        .mockResolvedValueOnce(draft() as never)
        .mockRejectedValueOnce(new Error("HTTP 503"));
      vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

      const result = await tools.update_sales_invoice.handler({ id: 88, due_date: "2025-01-31" });

      const data = parseToolJson(result) as {
        success: boolean;
        due_date_applied: boolean;
        warnings: string[];
      };
      expect(data.success).toBe(true);
      expect(data.due_date_applied).toBe(false);
      expect(data.warnings[0]).toContain("Could not read the invoice back");
      expect(data.warnings[0]).toContain("HTTP 503");
    });

    it("stringifies a non-Error read-back failure", async () => {
      vi.mocked(client.get)
        .mockResolvedValueOnce(draft() as never)
        .mockRejectedValueOnce("socket closed");
      vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

      const result = await tools.update_sales_invoice.handler({ id: 88, due_date: "2025-01-31" });
      const data = parseToolJson(result) as { warnings: string[] };
      expect(data.warnings[0]).toContain("socket closed");
    });

    it("rejects a due_date before the invoice date without patching", async () => {
      vi.mocked(client.get).mockResolvedValueOnce(draft() as never);

      await expect(
        tools.update_sales_invoice.handler({ id: 88, due_date: "2024-12-31" }),
      ).rejects.toThrow("due_date (2024-12-31) is before the invoice date (2025-01-01)");
      expect(client.patch).not.toHaveBeenCalled();
    });

    it("asks for invoice_date when the stored invoice has no create_date", async () => {
      vi.mocked(client.get).mockResolvedValueOnce({ ...draft(), create_date: null } as never);

      await expect(
        tools.update_sales_invoice.handler({ id: 88, due_date: "2025-01-31" }),
      ).rejects.toThrow("Pass invoice_date together with due_date");
      expect(client.patch).not.toHaveBeenCalled();
    });

    it("rejects an unparseable stored create_date", async () => {
      vi.mocked(client.get).mockResolvedValueOnce({ ...draft(), create_date: "n/a" } as never);

      await expect(
        tools.update_sales_invoice.handler({ id: 88, due_date: "2025-01-31" }),
      ).rejects.toThrow('invalid invoice date "n/a"');
      expect(client.patch).not.toHaveBeenCalled();
    });

    it("keeps term_days and skips the read-back when due_date is omitted", async () => {
      vi.mocked(client.get).mockResolvedValueOnce(draft() as never);
      vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

      const result = await tools.update_sales_invoice.handler({
        id: 88,
        invoice_date: "2025-03-01",
      });

      expect(client.patch).toHaveBeenCalledWith(
        "/v1/sale_invoices/88",
        expect.objectContaining({ create_date: "2025-03-01", term_days: 14 }),
      );
      expect(client.get).toHaveBeenCalledTimes(1);
      const data = parseToolJson(result) as Record<string, unknown>;
      expect(data).toEqual({
        success: true,
        message: "Sales invoice 88 updated",
        response: { id: 88 },
      });
    });
  });

  it("get_sales_invoice adds a derived due_date from create_date + term_days", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      id: 501,
      number: "TEST-0001",
      clients_id: 1,
      client_name: "Example Client OÜ",
      create_date: "2025-01-01",
      term_days: 14,
      status: "PROJECT",
      payment_status: null,
    } as never);

    const result = await tools.get_sales_invoice.handler({ id: 501 });
    const data = parseToolJson(result) as Record<string, unknown>;
    expect(data.due_date).toBe("2025-01-15");
    expect(data.term_days).toBe(14);
    expect(data.create_date).toBe("2025-01-01");
  });

  it("update_sales_invoice sets number_prefix and preserves a stored prefix when omitted", async () => {
    vi.mocked(client.get).mockResolvedValue({
      ...invoicesFixture.sale_invoice_get_for_patch,
      number_prefix: "2026",
      number_suffix: "42",
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

    await tools.update_sales_invoice.handler({ id: 88, number_prefix: "NX" });
    expect(client.patch).toHaveBeenLastCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({ number_prefix: "NX", number_suffix: "42" }),
    );

    await tools.update_sales_invoice.handler({ id: 88, description: "keep series" });
    expect(client.patch).toHaveBeenLastCalledWith(
      "/v1/sale_invoices/88",
      expect.objectContaining({ number_prefix: "2026", number_suffix: "42" }),
    );
  });

  it("update_sales_invoice leaves number_prefix out when none is stored or given", async () => {
    vi.mocked(client.get).mockResolvedValue({
      ...invoicesFixture.sale_invoice_get_for_patch,
      number_prefix: null,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 88 } as never);

    await tools.update_sales_invoice.handler({ id: 88, description: "no series" });
    expect(vi.mocked(client.patch).mock.calls[0]?.[1]).not.toHaveProperty("number_prefix");
  });

  it("delete_sales_invoice calls DELETE and returns API JSON", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.delete_sales_invoice.handler({ id: 55 });
    expect(client.delete).toHaveBeenCalledWith("/v1/sale_invoices/55");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("register_sales_invoice patches register without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.register_sales_invoice.handler({ id: 42 });
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/42/register");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("register_sales_invoice surfaces every 409 message with a hint", async () => {
    vi.mocked(client.patch).mockRejectedValue(
      createHttpJsonApiError({
        method: "PATCH",
        url: "https://rmp-api.rik.ee/v1/sale_invoices/42/register",
        httpStatus: 409,
        errorData: { code: 409, messages: ["Classifiers come from settings.", "Row 1: missing"] },
      }),
    );
    await expect(tools.register_sales_invoice.handler({ id: 42 })).rejects.toThrow(
      /Classifiers come from settings\.; Row 1: missing[\s\S]*Sales invoice 42 was not registered/,
    );
  });

  it("invalidate_sales_invoice patches invalidate without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.invalidate_sales_invoice.handler({ id: 90 });
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/90/invalidate");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("get_sales_invoice_xml returns ApiFile JSON", async () => {
    const apiFile = { name: "inv.xml", contents: "PD94bWw+" };
    vi.mocked(client.get).mockResolvedValue(apiFile as never);

    const result = await tools.get_sales_invoice_xml.handler({ id: 3 });
    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/3/xml");
    expect(parseToolJson(result)).toEqual(apiFile);
  });

  it("get_sales_invoice_pdf_system returns ApiFile JSON", async () => {
    const apiFile = { name: "inv.pdf", contents: "JVBERi0=" };
    vi.mocked(client.get).mockResolvedValue(apiFile as never);

    const result = await tools.get_sales_invoice_pdf_system.handler({ id: 4 });
    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/4/pdf_system");
    expect(parseToolJson(result)).toEqual(apiFile);
  });

  it("get_sales_invoice_user_file returns ApiFile JSON", async () => {
    const apiFile = { name: "attach.pdf", contents: "AA==" };
    vi.mocked(client.get).mockResolvedValue(apiFile as never);

    const result = await tools.get_sales_invoice_user_file.handler({ id: 5 });
    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/5/document_user");
    expect(parseToolJson(result)).toEqual(apiFile);
  });

  it("upload_sales_invoice_user_file reads file and puts document_user", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("x"));
    vi.mocked(client.put).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.upload_sales_invoice_user_file.handler({
      id: 6,
      file_path: "/tmp/note.pdf",
    });

    expect(readFile).toHaveBeenCalledWith("/tmp/note.pdf");
    expect(client.put).toHaveBeenCalledWith("/v1/sale_invoices/6/document_user", {
      name: "note.pdf",
      contents: Buffer.from("x").toString("base64"),
    });
    const data = parseToolJson(result) as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toContain("note.pdf");
  });

  it("delete_sales_invoice_user_file deletes document_user", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.delete_sales_invoice_user_file.handler({ id: 7 });
    expect(client.delete).toHaveBeenCalledWith("/v1/sale_invoices/7/document_user");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("get_sales_invoice_delivery_options GETs delivery_options", async () => {
    const opts = {
      can_send_einvoice: true,
      can_send_email: true,
      can_send_email_addresses: "a@b.c",
    };
    vi.mocked(client.get).mockResolvedValue(opts as never);

    const result = await tools.get_sales_invoice_delivery_options.handler({ id: 8 });
    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/8/delivery_options");
    expect(parseToolJson(result)).toEqual(opts);
  });

  it("deliver_sales_invoice patches deliver with body fields", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.deliver_sales_invoice.handler({
      id: 9,
      send_einvoice: false,
      send_email: true,
      email_addresses: "client@example.com",
      email_subject: "Invoice",
      email_body: "Please find attached.",
    });

    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/9/deliver", {
      send_einvoice: false,
      send_email: true,
      email_addresses: "client@example.com",
      email_subject: "Invoice",
      email_body: "Please find attached.",
    });
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("deliver_sales_invoice always sends both required flags, defaulting to false", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.deliver_sales_invoice.handler({ id: 10 });
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/10/deliver", {
      send_einvoice: false,
      send_email: false,
    });

    await tools.deliver_sales_invoice.handler({ id: 11, send_einvoice: true });
    expect(client.patch).toHaveBeenLastCalledWith("/v1/sale_invoices/11/deliver", {
      send_einvoice: true,
      send_email: false,
    });
  });

  it("deliver_sales_invoice defaults email_addresses from delivery options when send_email is set", async () => {
    vi.mocked(client.get).mockResolvedValue({
      can_send_einvoice: false,
      can_send_email: true,
      can_send_email_addresses: " billing@example.test ",
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.deliver_sales_invoice.handler({
      id: 21,
      send_email: true,
      email_subject: "Invoice",
    });

    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/21/delivery_options");
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/21/deliver", {
      send_einvoice: false,
      send_email: true,
      email_addresses: "billing@example.test",
      email_subject: "Invoice",
    });
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("deliver_sales_invoice sends explicit email_addresses unchanged without a lookup", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.deliver_sales_invoice.handler({
      id: 22,
      send_email: true,
      email_addresses: "other@example.test",
    });

    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/22/deliver", {
      send_einvoice: false,
      send_email: true,
      email_addresses: "other@example.test",
    });
  });

  it("deliver_sales_invoice does not look up addresses when send_email is not set", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.deliver_sales_invoice.handler({ id: 23, send_einvoice: true, send_email: false });

    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/23/deliver", {
      send_einvoice: true,
      send_email: false,
    });
  });

  /** Mocks GET by path: delivery options, the sale invoice, and the client card. */
  function mockDeliveryLookups(responses: {
    options?: unknown;
    invoice?: unknown;
    card?: unknown;
    fail?: "options" | "invoice" | "card";
  }) {
    vi.mocked(client.get).mockImplementation((async (path: string) => {
      if (path.endsWith("/delivery_options")) {
        if (responses.fail === "options") throw new Error("409 Conflict");
        return responses.options;
      }
      if (path.startsWith("/v1/sale_invoices/")) {
        if (responses.fail === "invoice") throw new Error("404 Not Found");
        return responses.invoice;
      }
      if (path.startsWith("/v1/clients/")) {
        if (responses.fail === "card") throw new Error("500 Internal Server Error");
        return responses.card;
      }
      throw new Error(`unexpected GET ${path}`);
    }) as never);
  }

  const noSuggestion = {
    can_send_einvoice: false,
    can_send_email: true,
    can_send_email_addresses: null,
  };

  it.each([
    ["null", noSuggestion],
    ["missing", { can_send_einvoice: false, can_send_email: true }],
    ["blank", { ...noSuggestion, can_send_email_addresses: "  " }],
    ["not a string", { ...noSuggestion, can_send_email_addresses: 5 }],
    ["a null response", null],
  ])("deliver_sales_invoice falls back to the client card email when the suggestion is %s", async (_label, options) => {
    mockDeliveryLookups({
      options,
      invoice: { id: 24, clients_id: 901 },
      card: { id: 901, name: "Demo Buyer OÜ", email: " buyer@example.test " },
    });
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.deliver_sales_invoice.handler({ id: 24, send_email: true });

    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/24/delivery_options");
    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/24");
    expect(client.get).toHaveBeenCalledWith("/v1/clients/901");
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/24/deliver", {
      send_einvoice: false,
      send_email: true,
      email_addresses: "buyer@example.test",
    });
  });

  it("deliver_sales_invoice does not read the client card when delivery options suggest an address", async () => {
    mockDeliveryLookups({
      options: { ...noSuggestion, can_send_email_addresses: "a@example.test" },
    });
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.deliver_sales_invoice.handler({ id: 26, send_email: true });

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/26/deliver", {
      send_einvoice: false,
      send_email: true,
      email_addresses: "a@example.test",
    });
  });

  it.each([
    [
      "the contact email when it is marked for invoices",
      {
        email: "contact@example.test",
        accounting_email: "books@example.test",
        send_invoice_to_email: true,
      },
      "contact@example.test",
    ],
    [
      "the accounting email when only it is marked for invoices",
      {
        email: "contact@example.test",
        accounting_email: "books@example.test",
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: true,
      },
      "books@example.test",
    ],
    [
      "both marked addresses, comma-separated",
      {
        email: "contact@example.test",
        accounting_email: "books@example.test",
        send_invoice_to_email: true,
        send_invoice_to_accounting_email: true,
      },
      "contact@example.test, books@example.test",
    ],
    [
      "one address when both marked fields are the same",
      {
        email: "same@example.test",
        accounting_email: "same@example.test",
        send_invoice_to_email: true,
        send_invoice_to_accounting_email: true,
      },
      "same@example.test",
    ],
    [
      "the contact email when nothing is marked",
      { email: "contact@example.test", accounting_email: "books@example.test" },
      "contact@example.test",
    ],
    [
      "the accounting email when the contact email is blank",
      { email: "", accounting_email: "books@example.test", send_invoice_to_email: true },
      "books@example.test",
    ],
  ])("deliver_sales_invoice uses %s from the client card", async (_label, card, expected) => {
    mockDeliveryLookups({
      options: noSuggestion,
      invoice: { id: 27, clients_id: 902 },
      card: { id: 902, name: "Demo Buyer OÜ", ...card },
    });
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.deliver_sales_invoice.handler({ id: 27, send_email: true });

    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/27/deliver", {
      send_einvoice: false,
      send_email: true,
      email_addresses: expected,
    });
  });

  it("deliver_sales_invoice throws a clear error when neither delivery options nor the client card has an email", async () => {
    mockDeliveryLookups({
      options: noSuggestion,
      invoice: { id: 28, clients_id: 903 },
      card: { id: 903, name: "Demo Buyer OÜ", email: null, accounting_email: "  " },
    });

    await expect(tools.deliver_sales_invoice.handler({ id: 28, send_email: true })).rejects.toThrow(
      "Buyer's e-mail address not found for sales invoice 28: delivery options suggest no address and client 903 has no email or accounting_email. Pass email_addresses, or add an e-mail to the client card.",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it.each([
    ["has no clients_id", { id: 29 }],
    ["is null", null],
  ])("deliver_sales_invoice throws the clear error when the invoice %s", async (_label, invoice) => {
    mockDeliveryLookups({ options: noSuggestion, invoice });

    await expect(tools.deliver_sales_invoice.handler({ id: 29, send_email: true })).rejects.toThrow(
      "Buyer's e-mail address not found for sales invoice 29: delivery options suggest no address and the buyer's client card has no email",
    );
    expect(client.get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/v1\/clients\//));
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("deliver_sales_invoice throws the clear error when the client card is null", async () => {
    mockDeliveryLookups({
      options: noSuggestion,
      invoice: { id: 30, clients_id: 904 },
      card: null,
    });

    await expect(tools.deliver_sales_invoice.handler({ id: 30, send_email: true })).rejects.toThrow(
      "client 904 has no email or accounting_email",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("deliver_sales_invoice uses the client card when the delivery options lookup fails", async () => {
    mockDeliveryLookups({
      fail: "options",
      invoice: { id: 31, clients_id: 905 },
      card: { id: 905, email: "buyer@example.test" },
    });
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.deliver_sales_invoice.handler({ id: 31, send_email: true });

    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/31/deliver", {
      send_einvoice: false,
      send_email: true,
      email_addresses: "buyer@example.test",
    });
  });

  it.each([
    [
      "delivery options",
      { fail: "options" as const, invoice: { id: 25, clients_id: 906 }, card: { id: 906 } },
    ],
    ["sale invoice", { fail: "invoice" as const, options: noSuggestion }],
    [
      "client card",
      { fail: "card" as const, options: noSuggestion, invoice: { id: 25, clients_id: 906 } },
    ],
  ])("deliver_sales_invoice keeps the RIK error when no address is found and the %s lookup fails", async (_label, lookups) => {
    mockDeliveryLookups(lookups);
    vi.mocked(client.patch).mockRejectedValue(new Error("Buyer's e-mail address not found"));

    await expect(tools.deliver_sales_invoice.handler({ id: 25, send_email: true })).rejects.toThrow(
      "Buyer's e-mail address not found",
    );

    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/25/deliver", {
      send_einvoice: false,
      send_email: true,
    });
  });

  it("upload_purchase_invoice_file uses Content-Disposition over download.aspx", async () => {
    const pdf = Buffer.from("%PDF-1.4");
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="Invoice-DFMZYDAL-0004.pdf"',
      }),
      arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(client.put).mockResolvedValue({ ...invoicesFixture.upload_put_ok } as never);

    try {
      await tools.upload_purchase_invoice_file.handler({
        invoice_id: 12,
        file_path:
          "https://my.microsoftpersonalcontent.com/personal/id/_layouts/15/download.aspx?share=abc",
      });
      expect(client.put).toHaveBeenCalledWith("/v1/purchase_invoices/12/document_user", {
        name: "Invoice-DFMZYDAL-0004.pdf",
        contents: pdf.toString("base64"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("upload_purchase_invoice_file prefers explicit filename over headers", async () => {
    const pdf = Buffer.from("%PDF-1.4");
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="from-header.pdf"',
      }),
      arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(client.put).mockResolvedValue({ ...invoicesFixture.upload_put_ok } as never);

    try {
      await tools.upload_purchase_invoice_file.handler({
        invoice_id: 12,
        file_path: "https://example.com/download.aspx",
        filename: "Invoice-6390.pdf",
      });
      expect(client.put).toHaveBeenCalledWith("/v1/purchase_invoices/12/document_user", {
        name: "Invoice-6390.pdf",
        contents: pdf.toString("base64"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("upload_purchase_invoice_file fetches an https URL", async () => {
    const pdf = Buffer.from("%PDF-1.4");
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(client.put).mockResolvedValue({ ...invoicesFixture.upload_put_ok } as never);

    try {
      const result = await tools.upload_purchase_invoice_file.handler({
        invoice_id: 12,
        file_path: "https://files.example.com/Invoice-DFMZYDAL-0004.pdf",
      });

      expect(readFile).not.toHaveBeenCalled();
      expect(client.put).toHaveBeenCalledWith("/v1/purchase_invoices/12/document_user", {
        name: "Invoice-DFMZYDAL-0004.pdf",
        contents: pdf.toString("base64"),
      });
      const data = parseToolJson(result) as { success: boolean };
      expect(data.success).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("upload_purchase_invoice_file reads file, encodes base64, and puts document", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("hello"));
    vi.mocked(client.put).mockResolvedValue({ ...invoicesFixture.upload_put_ok } as never);

    const result = await tools.upload_purchase_invoice_file.handler({
      invoice_id: 12,
      file_path: "/tmp/scan.pdf",
    });

    expect(readFile).toHaveBeenCalledWith("/tmp/scan.pdf");
    expect(client.put).toHaveBeenCalledWith("/v1/purchase_invoices/12/document_user", {
      name: "scan.pdf",
      contents: Buffer.from("hello").toString("base64"),
    });
    const data = parseToolJson(result) as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toContain("scan.pdf");
  });

  it("propagates API errors from client", async () => {
    vi.mocked(client.get).mockRejectedValue(new Error("API Error 404: Missing"));

    await expect(tools.get_sales_invoice.handler({ id: 1 })).rejects.toThrow("404");
  });

  it("propagates read errors from upload", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    await expect(
      tools.upload_purchase_invoice_file.handler({ invoice_id: 1, file_path: "/nope" }),
    ).rejects.toThrow("ENOENT");
  });

  it("propagates read errors from sales invoice user file upload", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    await expect(
      tools.upload_sales_invoice_user_file.handler({ id: 1, file_path: "/nope" }),
    ).rejects.toThrow("ENOENT");
  });

  it("list_purchase_invoices passes filters", async () => {
    vi.mocked(client.get).mockResolvedValue({
      ...invoicesFixture.purchases_list_paginated,
    } as never);
    await tools.list_purchase_invoices.handler({ page: 1, status: "PROJECT" });
    expect(client.get).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({ page: 1, status: "PROJECT" }),
    );
  });

  it("list_purchase_invoices coalesces null items and pagination fields", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: null,
      current_page: null,
      total_pages: null,
    } as never);
    const result = await tools.list_purchase_invoices.handler({});
    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toEqual([]);
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(1);
  });

  it("list_purchase_invoices passes modified_since and defaults pagination", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [],
      current_page: 0,
      total_pages: 0,
    } as never);
    const result = await tools.list_purchase_invoices.handler({
      modified_since: "2025-01-01T00:00:00Z",
    });
    expect(client.get).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({ modified_since: "2025-01-01T00:00:00Z" }),
    );
    const data = parseToolJson(result) as { current_page: number; total_pages: number };
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(1);
  });

  it("list_unpaid_invoices coalesces null items from API", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ items: null } as never)
      .mockResolvedValueOnce({ items: null } as never);
    const result = await tools.list_unpaid_invoices.handler({ type: "both" });
    const data = parseToolJson(result) as {
      sales_invoices: unknown[];
      purchase_invoices: unknown[];
    };
    expect(data.sales_invoices).toEqual([]);
    expect(data.purchase_invoices).toEqual([]);
  });

  it("list_unpaid_invoices fetches sales only", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...invoicesFixture.unpaid_sales_only } as never);
    const result = await tools.list_unpaid_invoices.handler({ type: "sales" });
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices", { payment_status: "NOT_PAID" });
    const data = parseToolJson(result) as { sales_invoices?: unknown[] };
    expect(data.sales_invoices).toHaveLength(1);
  });

  it("list_unpaid_invoices fetches purchase only", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...invoicesFixture.unpaid_purchases_only } as never);
    const result = await tools.list_unpaid_invoices.handler({ type: "purchase" });
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith("/v1/purchase_invoices", {
      payment_status: "NOT_PAID",
    });
    const data = parseToolJson(result) as { purchase_invoices?: unknown[] };
    expect(data.purchase_invoices).toHaveLength(1);
  });

  it("list_unpaid_invoices defaults to both types", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ ...invoicesFixture.unpaid_sales_only } as never)
      .mockResolvedValueOnce({ ...invoicesFixture.unpaid_purchases_only } as never);
    await tools.list_unpaid_invoices.handler({});
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("list_unpaid_invoices fetches both invoice types", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({ ...invoicesFixture.unpaid_sales_only } as never)
      .mockResolvedValueOnce({ ...invoicesFixture.unpaid_purchases_only } as never);
    const result = await tools.list_unpaid_invoices.handler({ type: "both" });
    expect(client.get).toHaveBeenCalledTimes(2);
    const data = parseToolJson(result) as {
      sales_invoices: unknown[];
      purchase_invoices: unknown[];
    };
    expect(data.sales_invoices).toHaveLength(1);
    expect(data.purchase_invoices).toHaveLength(1);
  });

  it("get_sales_invoice and get_purchase_invoice fetch by id", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.single_sales_detail,
    } as never);
    const r1 = await tools.get_sales_invoice.handler({ id: 9 });
    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices/9");
    expect(parseToolJson(r1)).toEqual(invoicesFixture.single_sales_detail);

    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.single_purchase_detail,
    } as never);
    const r2 = await tools.get_purchase_invoice.handler({ id: 11 });
    expect(client.get).toHaveBeenCalledWith("/v1/purchase_invoices/11");
    expect(parseToolJson(r2)).toEqual(invoicesFixture.single_purchase_detail);
  });

  function mockPurchaseCreateFlow(id = 99) {
    vi.mocked(client.getAllPages).mockResolvedValue([]);
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" } as never;
      }
      if (path.startsWith("/v1/purchase_invoices/")) {
        return {
          ...invoicesFixture.created_purchase_invoice,
          id,
          items: [{ total_net_price: 100, vat_amount: 20 }],
        } as never;
      }
      return {} as never;
    });
    vi.mocked(client.post).mockResolvedValue({
      ...invoicesFixture.created_purchase_invoice,
      id,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
  }

  it("create_purchase_invoice posts mapped payload with defaults", async () => {
    mockPurchaseCreateFlow();
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "INV-P",
      invoice_date: "2025-06-01",
      total_amount: 120,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({
        gross_price: 120,
        items: [
          expect.objectContaining({
            custom_title: "Purchase",
            cl_purchase_articles_id: 39,
          }),
        ],
      }),
    );
  });

  it("create_purchase_invoice uses description and VAT line fields when provided", async () => {
    mockPurchaseCreateFlow();
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "INV-P",
      invoice_date: "2025-06-01",
      total_amount: 122,
      vat_amount: 22,
      description: "Office chairs",
      cl_currencies_id: "USD",
      currency_rate: 0.9,
      term_days: 14,
      purchase_article_id: 23,
      purchase_accounts_dimensions_id: 99,
      vat_rate: 22,
      vat_accounts_id: 555,
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as {
      items: { custom_title: string; cl_vat_articles_id?: number; unit_net_price: number }[];
    };
    expect(body.items[0].custom_title).toBe("Office chairs");
    expect(body.items[0].cl_vat_articles_id).toBe(1);
    expect(body.items[0].unit_net_price).toBe(100);
  });

  it("create_purchase_invoice requires total_amount when items omitted", async () => {
    await expect(
      tools.create_purchase_invoice.handler({
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "INV-P",
        invoice_date: "2025-06-01",
      }),
    ).rejects.toThrow(/total_amount is required/);
  });

  it("create_purchase_invoice forwards reversed_vat_id to the line item", async () => {
    mockPurchaseCreateFlow();
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Cursor",
      invoice_no: "78992E48-0013",
      invoice_date: "2025-09-11",
      total_amount: 17.36,
      vat_rate: 0,
      purchase_article_id: 23,
      purchase_accounts_dimensions_id: 99,
      reversed_vat_id: 7,
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as {
      items: { reversed_vat_id?: number; vat_rate_dropdown?: string }[];
    };
    expect(body.items[0].reversed_vat_id).toBe(7);
    expect(body.items[0].vat_rate_dropdown).toBe("-");
  });

  it("create_purchase_invoice posts items[].cl_vat_articles_id without falling back to 1", async () => {
    mockPurchaseCreateFlow();
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Neste",
      invoice_no: "WZ216-ITEMS",
      invoice_date: "2025-06-01",
      items: [
        {
          custom_title: "Fuel",
          amount: 1,
          unit_net_price: 100,
          total_net_price: 100,
          cl_vat_articles_id: 16,
        },
      ],
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as {
      items: { cl_vat_articles_id?: number }[];
    };
    expect(body.items[0].cl_vat_articles_id).toBe(16);
  });

  it("create_purchase_invoice posts top-level cl_vat_articles_id on a single line", async () => {
    mockPurchaseCreateFlow();
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Snabb",
      invoice_no: "WZ216-TOP",
      invoice_date: "2025-06-01",
      total_amount: 124,
      vat_rate: 24,
      cl_vat_articles_id: 16,
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as {
      items: { cl_vat_articles_id?: number }[];
    };
    expect(body.items[0].cl_vat_articles_id).toBe(16);
  });

  it("create_purchase_invoice inputSchema advertises cl_vat_articles_id", () => {
    const props = tools.create_purchase_invoice.inputSchema.properties;
    expect(props.cl_vat_articles_id).toMatchObject({ type: "number" });
    expect(props.cl_vat_articles_id.description).toMatch(/sõiduauto 100%/);
    expect(props.items.items.properties.cl_vat_articles_id).toMatchObject({ type: "number" });
    expect(props.items.items.properties.cl_vat_articles_id.description).toMatch(/16/);
  });

  it("create_purchase_invoice forwards cash-payment fields", async () => {
    mockPurchaseCreateFlow();
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "INV-CASH",
      invoice_date: "2025-06-01",
      total_amount: 50,
      paid_in_cash: true,
      cash_accounts_id: 1360,
      cash_payment_date: "2025-06-01",
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({
        paid_in_cash: true,
        cash_accounts_id: 1360,
        cash_payment_date: "2025-06-01",
      }),
    );
    expect(vi.mocked(client.post).mock.calls[0][1]).not.toHaveProperty(
      "cash_accounts_dimensions_id",
    );
  });

  it("create_purchase_invoice rejects cash_accounts_dimensions_id", async () => {
    mockPurchaseCreateFlow();
    await expect(
      tools.create_purchase_invoice.handler({
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "INV-CASH-DIM",
        invoice_date: "2025-06-01",
        total_amount: 50,
        cash_accounts_dimensions_id: 407164,
      }),
    ).rejects.toThrow(/rejects cash_accounts_dimensions_id/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("create_purchase_invoice accepts term_days 0", async () => {
    mockPurchaseCreateFlow();
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "INV-P0",
      invoice_date: "2025-06-01",
      total_amount: 50,
      term_days: 0,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({ term_days: 0 }),
    );
  });

  it("create_purchase_invoice rejects negative term_days", async () => {
    await expect(
      tools.create_purchase_invoice.handler({
        clients_id: 1,
        client_name: "Sup",
        invoice_no: "INV-P",
        invoice_date: "2025-06-01",
        total_amount: 50,
        term_days: -1,
      }),
    ).rejects.toThrow(/term_days/);
  });

  it("create_purchase_invoice descriptions do not hardcode tenant dimension ids", () => {
    const dim = tools.create_purchase_invoice.inputSchema.properties.purchase_accounts_dimensions_id
      .description as string;
    const article = tools.create_purchase_invoice.inputSchema.properties.purchase_article_id
      .description as string;
    expect(dim).toMatch(/list_account_dimensions|list_purchase_articles/);
    expect(dim).not.toMatch(/6488057|12637323/);
    expect(article).toMatch(/list_purchase_articles/);
    expect(article).not.toMatch(/6488057/);
    const cashDim = tools.create_purchase_invoice.inputSchema.properties.cash_accounts_dimensions_id
      .description as string;
    expect(cashDim).toMatch(/rejects this field|web UI/);
  });

  it("update_purchase_invoice gets current then patches", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    const result = await tools.update_purchase_invoice.handler({
      id: 11,
      total_amount: 150,
    });

    expect(client.get).toHaveBeenCalledWith("/v1/purchase_invoices/11");
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/11",
      expect.objectContaining({ gross_price: 150 }),
    );
    const data = parseToolJson(result) as { success: boolean };
    expect(data.success).toBe(true);
  });

  it("update_purchase_invoice refuses CONFIRMED invoices before the PATCH", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
      status: "CONFIRMED",
    } as never);

    const call = tools.update_purchase_invoice.handler({
      id: 11,
      items: [{ id: 101, cl_vat_articles_id: 16 }],
    });

    await expect(call).rejects.toThrow(
      /Purchase invoice 11 is CONFIRMED\. Confirmed purchase invoice lines can't be changed through the API\. Take the invoice back to draft in the e-Financials UI.*There is no unregister API\./,
    );
    expect(client.get).toHaveBeenCalledWith("/v1/purchase_invoices/11");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice refuses header-only updates on CONFIRMED invoices", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
      status: "CONFIRMED",
    } as never);

    await expect(
      tools.update_purchase_invoice.handler({ id: 11, description: "x" }),
    ).rejects.toThrow(/no unregister API/);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice still patches PROJECT invoices", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
      status: "PROJECT",
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({
      id: 11,
      items: [{ id: 101, cl_vat_articles_id: 16 }],
    });

    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/11", expect.any(Object));
  });

  it("update_purchase_invoice description explains deletion, VAT rounding, and CONFIRMED refusal", () => {
    const description = tools.update_purchase_invoice.description;
    expect(description).toMatch(/^Update a purchase invoice draft \(PROJECT\)\./);
    expect(description).toMatch(/delete_item_ids/);
    expect(description).toMatch(/only the retained lines/);
    expect(description).toMatch(/no DELETE item endpoint/);
    expect(description).toMatch(/is_deleted is not a line field/);
    expect(description).toMatch(/base_document_files_id/);
    expect(description).toMatch(
      /upstream can compute VAT once from the invoice net rather than per line/,
    );
    expect(description).toMatch(
      /do not zero or delete a rounding line unless the user explicitly asks/,
    );
    expect(description).toMatch(/CONFIRMED invoices are refused before any PATCH/);
    expect(description).toMatch(/no unregister API/);
    const deleteIds = tools.update_purchase_invoice.inputSchema.properties.delete_item_ids;
    expect(deleteIds.type).toBe("array");
    expect(deleteIds.description).toMatch(/omission/);
    expect(deleteIds.description).toMatch(/invoice net rather than per line/);
    expect(deleteIds.description).toMatch(/unless the user explicitly asks/);
  });

  it("update_purchase_invoice applies reversed_vat_id to each existing item", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
      items: [
        { custom_title: "Line A", unit_net_price: 10 },
        { custom_title: "Line B", unit_net_price: 20, reversed_vat_id: 4 },
      ],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({ id: 11, reversed_vat_id: 7 });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ custom_title: "Line A", reversed_vat_id: 7 });
    expect(body.items[1]).toMatchObject({ custom_title: "Line B", reversed_vat_id: 7 });
  });

  it("update_purchase_invoice falls back to empty items when current has none", async () => {
    const { items: _discardedItems, ...currentWithoutItems } =
      invoicesFixture.purchase_get_for_patch;
    vi.mocked(client.get).mockResolvedValueOnce(currentWithoutItems as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({ id: 11, reversed_vat_id: 7 });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toEqual([]);
  });

  it("update_purchase_invoice leaves items untouched when reversed_vat_id omitted", async () => {
    const originalItems = [{ custom_title: "Line A", unit_net_price: 10 }];
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
      items: originalItems,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({ id: 11, total_amount: 150 });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toBe(originalItems);
  });

  it("update_purchase_invoice merges items by id and leaves sibling lines intact", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({
      id: 11,
      items: [
        {
          id: 101,
          products_id: 23864,
          purchase_accounts_dimensions_id: 709308,
          custom_title: "006 Prügivedu",
        },
      ],
    });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: 101,
      products_id: 23864,
      purchase_accounts_dimensions_id: 709308,
      custom_title: "006 Prügivedu",
      unit_net_price: 80,
      purchase_accounts_id: 9900,
    });
    expect(body.items[1]).toMatchObject({
      id: 102,
      custom_title: "Second line",
      unit_net_price: 20,
    });
  });

  it("update_purchase_invoice appends items without id", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({
      id: 11,
      items: [{ custom_title: "New line", amount: 1, unit_net_price: 5, products_id: 99 }],
    });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(3);
    expect(body.items[2]).toMatchObject({
      custom_title: "New line",
      amount: 1,
      unit_net_price: 5,
      products_id: 99,
    });
  });

  it("update_purchase_invoice rejects unknown item id", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);

    await expect(
      tools.update_purchase_invoice.handler({
        id: 11,
        items: [{ id: 999, products_id: 1 }],
      }),
    ).rejects.toThrow(/Unknown purchase invoice line id: 999/);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("mergePurchaseInvoiceItems keeps current lines that have no id", () => {
    const current = [{ custom_title: "orphan" }, { id: 1, custom_title: "named" }];
    const merged = mergePurchaseInvoiceItems(current, [{ id: 1, products_id: 5 }]);
    expect(merged).toEqual([
      { custom_title: "orphan" },
      { id: 1, custom_title: "named", products_id: 5 },
    ]);
  });

  it("update_purchase_invoice applies reversed_vat_id after items merge", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({
      id: 11,
      reversed_vat_id: 7,
      items: [{ id: 101, products_id: 23864 }],
    });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]).toMatchObject({
      id: 101,
      products_id: 23864,
      reversed_vat_id: 7,
    });
    expect(body.items[1]).toMatchObject({
      id: 102,
      custom_title: "Second line",
      reversed_vat_id: 7,
    });
  });

  it("update_purchase_invoice persists cl_vat_articles_id and cl_fringe_benefits_id", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({
      id: 11,
      items: [{ id: 101, cl_vat_articles_id: 16, cl_fringe_benefits_id: 1 }],
    });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]).toMatchObject({
      id: 101,
      cl_vat_articles_id: 16,
      cl_fringe_benefits_id: 1,
      unit_net_price: 80,
    });
  });

  it("update_purchase_invoice inputSchema advertises items[] line fields", () => {
    const items = tools.update_purchase_invoice.inputSchema.properties.items;
    expect(items.description).toMatch(/cl_vat_articles_id/);
    expect(items.description).toMatch(/is_deleted/);
    expect(items.description).toMatch(/delete_item_ids/);
    expect(items.items.additionalProperties).toBe(false);
    expect(items.items.properties).toMatchObject({
      id: { type: "number" },
      products_id: { type: "number" },
      cl_vat_articles_id: { type: "number" },
      cl_fringe_benefits_id: { type: "number" },
    });
    expect(
      tools.create_purchase_invoice.inputSchema.properties.items.items.properties
        .cl_vat_articles_id,
    ).toMatchObject({ type: "number" });
  });

  it("update_purchase_invoice forwards cash-payment fields", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);
    await tools.update_purchase_invoice.handler({
      id: 11,
      paid_in_cash: true,
      cash_accounts_id: 1360,
      cash_payment_date: "2025-06-02",
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/11",
      expect.objectContaining({
        paid_in_cash: true,
        cash_accounts_id: 1360,
        cash_payment_date: "2025-06-02",
      }),
    );
    expect(vi.mocked(client.patch).mock.calls[0][1]).not.toHaveProperty(
      "cash_accounts_dimensions_id",
    );
  });

  it("update_purchase_invoice rejects cash_accounts_dimensions_id", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);
    await expect(
      tools.update_purchase_invoice.handler({
        id: 11,
        cash_accounts_dimensions_id: 407164,
      }),
    ).rejects.toThrow(/rejects cash_accounts_dimensions_id/);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice refuses invoices that already have a cash dimension", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
      cash_accounts_dimensions_id: 41442,
    } as never);
    await expect(
      tools.update_purchase_invoice.handler({ id: 11, description: "x" }),
    ).rejects.toThrow(/already has cash_accounts_dimensions_id/);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice accepts term_days 0", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);

    await tools.update_purchase_invoice.handler({ id: 11, term_days: 0 });

    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/11",
      expect.objectContaining({ term_days: 0 }),
    );
  });

  it("update_purchase_invoice uses term_days and vat fallbacks from minimal current", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_minimal,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 11 } as never);

    await tools.update_purchase_invoice.handler({ id: 11 });

    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/11",
      expect.objectContaining({
        term_days: 0,
        vat_price: 0,
      }),
    );
    expect(vi.mocked(client.patch).mock.calls[0][1]).not.toHaveProperty("base_document_files_id");
  });

  function fakePurchaseDraft(
    items: Array<Record<string, unknown>>,
    header: Record<string, unknown> = {},
  ) {
    return {
      ...invoicesFixture.purchase_get_for_patch,
      client_name: "FAKE-SUPPLIER",
      status: "PROJECT",
      base_document_files_id: 900001,
      items,
      ...header,
    };
  }

  const fakeKeepA = {
    id: 501,
    custom_title: "FAKE-KEEP-A",
    amount: 1,
    unit_net_price: 10,
    total_net_price: 10,
    vat_amount: 2.4,
    project_no_vat_gross_price: 12.4,
    purchase_accounts_id: 4000,
    note_from_api: "FAKE-NOTE-A",
  };
  const fakeDrop = {
    id: 502,
    custom_title: "FAKE-DROP",
    amount: 1,
    unit_net_price: 3,
    total_net_price: 3,
    vat_amount: 0.72,
    project_no_vat_gross_price: 3.72,
    purchase_accounts_id: 4000,
  };
  const fakeKeepB = {
    id: 503,
    custom_title: "FAKE-KEEP-B",
    amount: 4,
    unit_net_price: 1,
    total_net_price: 4,
    vat_amount: 0.96,
    project_no_vat_gross_price: 4.96,
    purchase_accounts_id: 4000,
    note_from_api: "FAKE-NOTE-B",
  };

  function mockPurchasePatch(current: Record<string, unknown>) {
    vi.mocked(client.get).mockResolvedValueOnce(current as never);
    vi.mocked(client.patch).mockResolvedValue({
      ...invoicesFixture.patch_purchase_result,
    } as never);
  }

  it("update_purchase_invoice deletes one PROJECT line by sending only retained lines", async () => {
    const current = fakePurchaseDraft([fakeDrop, fakeKeepA, fakeKeepB]);
    mockPurchasePatch(current);

    await tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: [502] });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
      base_document_files_id: number;
      gross_price: number;
      vat_price: number;
      client_name: string;
    };
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/11", expect.any(Object));
    expect(body.items).toEqual([fakeKeepA, fakeKeepB]);
    expect(body.items[0]).toBe(fakeKeepA);
    expect(body.items[1]).toBe(fakeKeepB);
    expect(body.base_document_files_id).toBe(900001);
    expect(body.client_name).toBe("FAKE-SUPPLIER");
    expect(body.gross_price).toBe(100);
    expect(body.vat_price).toBe(0);
    expect(body).not.toHaveProperty("is_deleted");
    expect(JSON.stringify(body.items)).not.toContain("is_deleted");
  });

  it("update_purchase_invoice keeps a line that has no id when another line is deleted", async () => {
    const orphan = { custom_title: "FAKE-ORPHAN", amount: 1, unit_net_price: 1 };
    mockPurchasePatch(fakePurchaseDraft([orphan, fakeKeepA, fakeDrop]));

    await tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: [502, 502] });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toEqual([orphan, fakeKeepA]);
    expect(body.items[0]).toBe(orphan);
  });

  it("update_purchase_invoice patches a sibling and appends while deleting another line", async () => {
    mockPurchasePatch(fakePurchaseDraft([fakeKeepA, fakeDrop, fakeKeepB]));

    await tools.update_purchase_invoice.handler({
      id: 11,
      delete_item_ids: [502],
      total_amount: 14.4,
      vat_amount: 2.4,
      items: [
        { id: 501, custom_title: "FAKE-PATCHED" },
        { custom_title: "FAKE-NEW", amount: 1, unit_net_price: 7, products_id: 880001 },
      ],
    });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
      gross_price: number;
      vat_price: number;
      base_document_files_id: number;
    };
    expect(body.items.map((item) => item.id ?? item.custom_title)).toEqual([501, 503, "FAKE-NEW"]);
    expect(body.items[0]).toMatchObject({
      id: 501,
      custom_title: "FAKE-PATCHED",
      unit_net_price: 10,
      vat_amount: 2.4,
      note_from_api: "FAKE-NOTE-A",
    });
    expect(body.items[1]).toBe(fakeKeepB);
    expect(body.items[2]).toMatchObject({
      custom_title: "FAKE-NEW",
      amount: 1,
      unit_net_price: 7,
      products_id: 880001,
    });
    expect(body.gross_price).toBe(14.4);
    expect(body.vat_price).toBe(2.4);
    expect(body.base_document_files_id).toBe(900001);
  });

  it("update_purchase_invoice applies reversed_vat_id only to lines that remain", async () => {
    mockPurchasePatch(fakePurchaseDraft([fakeKeepA, fakeDrop]));

    await tools.update_purchase_invoice.handler({
      id: 11,
      delete_item_ids: [502],
      reversed_vat_id: 7,
    });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 501,
      custom_title: "FAKE-KEEP-A",
      vat_amount: 2.4,
      reversed_vat_id: 7,
    });
  });

  it("update_purchase_invoice sends an empty items array when the only line is deleted", async () => {
    mockPurchasePatch(fakePurchaseDraft([fakeDrop], { base_document_files_id: null }));

    await tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: [502] });

    const body = vi.mocked(client.patch).mock.calls[0][1] as Record<string, unknown>;
    expect(body.items).toEqual([]);
    expect(body.base_document_files_id).toBeNull();
    expect(body.clients_id).toBe(1);
    expect(body.number).toBe("P11");
  });

  it("update_purchase_invoice sends no lines when every id is deleted", async () => {
    mockPurchasePatch(fakePurchaseDraft([fakeKeepA, fakeDrop, fakeKeepB]));

    await tools.update_purchase_invoice.handler({
      id: 11,
      delete_item_ids: [503, 501, 502],
    });

    const body = vi.mocked(client.patch).mock.calls[0][1] as {
      items: unknown[];
      base_document_files_id: number;
    };
    expect(body.items).toEqual([]);
    expect(body.base_document_files_id).toBe(900001);
  });

  it("update_purchase_invoice treats an empty delete_item_ids list as no deletion", async () => {
    const current = fakePurchaseDraft([fakeKeepA, fakeDrop]);
    mockPurchasePatch(current);

    await tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: [] });

    const body = vi.mocked(client.patch).mock.calls[0][1] as { items: unknown };
    expect(body.items).toBe(current.items);
  });

  it("update_purchase_invoice treats null delete_item_ids as omitted", async () => {
    const originalItems = [{ id: 501, custom_title: "FAKE-KEEP-A" }];
    vi.mocked(client.get).mockResolvedValueOnce({
      ...invoicesFixture.purchase_get_for_patch,
      items: originalItems,
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ id: 11 } as never);

    await tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: null });

    const body = vi.mocked(client.patch).mock.calls[0][1] as { items: unknown };
    expect(body.items).toBe(originalItems);
  });

  it("update_purchase_invoice forwards base_document_files_id on a header-only update", async () => {
    mockPurchasePatch(fakePurchaseDraft([fakeKeepA], { base_document_files_id: 900002 }));

    await tools.update_purchase_invoice.handler({ id: 11, description: "FAKE-NOTE" });

    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/11",
      expect.objectContaining({
        notes: "FAKE-NOTE",
        base_document_files_id: 900002,
      }),
    );
    const body = vi.mocked(client.patch).mock.calls[0][1] as { items: unknown };
    expect(body.items).toEqual([fakeKeepA]);
  });

  it("update_purchase_invoice rejects unknown delete ids before the PATCH", async () => {
    vi.mocked(client.get).mockResolvedValueOnce(fakePurchaseDraft([fakeKeepA, fakeDrop]) as never);

    await expect(
      tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: [999, 998] }),
    ).rejects.toThrow("Unknown purchase invoice line id: 999, 998");
    expect(client.get).toHaveBeenCalledWith("/v1/purchase_invoices/11");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice rejects a delete id when the draft has no items array", async () => {
    const { items: _removed, ...withoutItems } = fakePurchaseDraft([]);
    vi.mocked(client.get).mockResolvedValueOnce(withoutItems as never);

    await expect(
      tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: [501] }),
    ).rejects.toThrow("Unknown purchase invoice line id: 501");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice rejects patching and deleting the same line", async () => {
    vi.mocked(client.get).mockResolvedValueOnce(fakePurchaseDraft([fakeKeepA, fakeDrop]) as never);

    await expect(
      tools.update_purchase_invoice.handler({
        id: 11,
        delete_item_ids: [502, 501],
        items: [
          { id: 501, amount: 9 },
          { id: 502, custom_title: "FAKE-ALSO" },
        ],
      }),
    ).rejects.toThrow(
      "Cannot patch and delete the same purchase invoice line (501, 502). Omit that id from items[] and pass it in delete_item_ids.",
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice rejects is_deleted on an item before any request", async () => {
    await expect(
      tools.update_purchase_invoice.handler({
        id: 11,
        items: [{ id: 501, is_deleted: true, mystery_flag: true }],
      }),
    ).rejects.toThrow(
      /items\.0: Unrecognized item field\(s\): "is_deleted", "mystery_flag"\. Unknown item fields are rejected and are not applied\. is_deleted does not delete a line\. To delete a line, pass delete_item_ids/,
    );
    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice rejects other unknown item fields before any request", async () => {
    await expect(
      tools.update_purchase_invoice.handler({
        id: 11,
        items: [{ id: 501, custom_title: "FAKE-KEEP-A", mystery_flag: 1 }],
      }),
    ).rejects.toThrow(
      /Unrecognized item field\(s\): "mystery_flag"\. Unknown item fields are rejected and are not applied\. To delete a line, pass delete_item_ids/,
    );
    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice rejects a non-object item before any request", async () => {
    await expect(
      tools.update_purchase_invoice.handler({
        id: 11,
        items: [null],
      }),
    ).rejects.toThrow(/items\.0/);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice rejects a non-numeric item amount before any request", async () => {
    await expect(
      tools.update_purchase_invoice.handler({
        id: 11,
        items: [{ id: 501, amount: "nope" }],
      }),
    ).rejects.toThrow(/items\.0\.amount/);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice rejects a non-positive delete_item_ids entry before any request", async () => {
    await expect(
      tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: [0] }),
    ).rejects.toThrow(/delete_item_ids/);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice refuses CONFIRMED invoices when delete_item_ids is set", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...fakePurchaseDraft([fakeKeepA, fakeDrop]),
      status: "CONFIRMED",
    } as never);

    await expect(
      tools.update_purchase_invoice.handler({ id: 11, delete_item_ids: [502] }),
    ).rejects.toThrow(/Purchase invoice 11 is CONFIRMED[\s\S]*no unregister API/);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("update_purchase_invoice prefers the CONFIRMED refusal over a patch-and-delete conflict", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      ...fakePurchaseDraft([fakeKeepA]),
      status: "CONFIRMED",
    } as never);

    await expect(
      tools.update_purchase_invoice.handler({
        id: 11,
        delete_item_ids: [501],
        items: [{ id: 501, amount: 2 }],
      }),
    ).rejects.toThrow(/no unregister API/);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("delete_purchase_invoice calls DELETE and returns API JSON", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.delete_purchase_invoice.handler({ id: 55 });
    expect(client.delete).toHaveBeenCalledWith("/v1/purchase_invoices/55");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("register_purchase_invoice repairs totals then registers", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      return {
        id: 42,
        vat_price: 0,
        gross_price: 100,
        items: [{ total_net_price: 100, vat_amount: 24 }],
      };
    });
    vi.mocked(client.patch).mockResolvedValue({ status: "CONFIRMED" } as never);

    const result = await tools.register_purchase_invoice.handler({ id: 42 });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/purchase_invoices/42",
      expect.objectContaining({ vat_price: 24, gross_price: 124 }),
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/42/register");
    expect(parseToolJson(result)).toEqual({
      success: true,
      id: 42,
      repaired: true,
      response: { status: "CONFIRMED" },
    });
  });

  it("register_purchase_invoice honors preserve_existing_totals", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/vat_info") {
        return { vat_number: "EE1", tax_refnumber: "1" };
      }
      return {
        id: 42,
        vat_price: 0,
        gross_price: 100,
        items: [{ total_net_price: 100, vat_amount: 24 }],
      };
    });
    vi.mocked(client.patch).mockResolvedValue({ status: "CONFIRMED" } as never);

    const result = await tools.register_purchase_invoice.handler({
      id: 42,
      preserve_existing_totals: true,
    });
    expect(client.patch).toHaveBeenCalledTimes(1);
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/42/register");
    expect((parseToolJson(result) as { repaired: boolean }).repaired).toBe(false);
  });

  it("validate_invoice_data maps null vat_rate_dropdown to undefined", async () => {
    const result = await tools.validate_invoice_data.handler({
      total_net: 10,
      total_vat: 0,
      total_gross: 10,
      items: [{ total_net_price: 10, vat_rate_dropdown: null }],
    });
    expect((parseToolJson(result) as { valid: boolean }).valid).toBe(true);
  });

  it("invalidate_purchase_invoice patches invalidate without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.invalidate_purchase_invoice.handler({ id: 90 });
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/90/invalidate");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("get_purchase_invoice_user_file returns ApiFile JSON", async () => {
    const apiFile = { name: "attach.pdf", contents: "AA==" };
    vi.mocked(client.get).mockResolvedValue(apiFile as never);

    const result = await tools.get_purchase_invoice_user_file.handler({ id: 5 });
    expect(client.get).toHaveBeenCalledWith("/v1/purchase_invoices/5/document_user");
    expect(parseToolJson(result)).toEqual(apiFile);
  });

  it("delete_purchase_invoice_user_file deletes document_user", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.delete_purchase_invoice_user_file.handler({ id: 7 });
    expect(client.delete).toHaveBeenCalledWith("/v1/purchase_invoices/7/document_user");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("upload_purchase_invoice_file uses octet-stream for unknown extension", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("x"));
    vi.mocked(client.put).mockResolvedValue({} as never);
    await tools.upload_purchase_invoice_file.handler({
      invoice_id: 3,
      file_path: "/data/file.unknownext",
    });
    expect(client.put).toHaveBeenCalledWith(
      "/v1/purchase_invoices/3/document_user",
      expect.objectContaining({ name: "file.unknownext" }),
    );
  });

  it("upload_purchase_invoice_file handles empty file extension segment", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("x"));
    vi.mocked(client.put).mockResolvedValue({} as never);
    await tools.upload_purchase_invoice_file.handler({
      invoice_id: 4,
      file_path: "/tmp/foo.",
    });
    expect(client.put).toHaveBeenCalledWith(
      "/v1/purchase_invoices/4/document_user",
      expect.objectContaining({ name: "foo." }),
    );
  });
});
