import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import invoicesFixture from "../__fixtures__/invoices.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import { createInvoiceTools } from "./invoices.js";
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
        number_suffix: expect.any(String),
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

  it("create_sales_invoice skips product lookup when all rows have products_id", async () => {
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
      rows: [{ description: "Item", quantity: 1, unit_price: 10, products_id: 77 }],
    });

    expect(client.get).not.toHaveBeenCalledWith("/v1/products");
    expect(client.post).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({
        items: [expect.objectContaining({ products_id: 77 })],
      }),
    );
  });

  it("update_sales_invoice applies invoice_date rows and currency overrides", async () => {
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
        journal_date: "2025-12-01",
        items: newRows,
        cl_currencies_id: "GBP",
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

  it("deliver_sales_invoice sends empty object when only id is provided", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.deliver_sales_invoice.handler({ id: 10 });
    expect(client.patch).toHaveBeenCalledWith("/v1/sale_invoices/10/deliver", {});
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

  it("create_purchase_invoice posts mapped payload with defaults", async () => {
    vi.mocked(client.post).mockResolvedValue({
      ...invoicesFixture.created_purchase_invoice,
    } as never);
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
            cl_vat_articles_id: undefined,
          }),
        ],
      }),
    );
  });

  it("create_purchase_invoice uses description and VAT line fields when provided", async () => {
    vi.mocked(client.post).mockResolvedValue({
      ...invoicesFixture.created_purchase_invoice,
    } as never);
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Sup",
      invoice_no: "INV-P",
      invoice_date: "2025-06-01",
      total_amount: 122,
      vat_amount: 22,
      description: "Office chairs",
      cl_currencies_id: "USD",
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

  it("create_purchase_invoice forwards reversed_vat_id to the line item", async () => {
    vi.mocked(client.post).mockResolvedValue({
      ...invoicesFixture.created_purchase_invoice,
    } as never);
    await tools.create_purchase_invoice.handler({
      clients_id: 1,
      client_name: "Cursor",
      invoice_no: "78992E48-0013",
      invoice_date: "2025-09-11",
      total_amount: 17.36,
      vat_rate: 0,
      purchase_article_id: 23,
      purchase_accounts_dimensions_id: 6488057,
      reversed_vat_id: 7,
    });
    const body = vi.mocked(client.post).mock.calls[0][1] as {
      items: { reversed_vat_id?: number }[];
    };
    expect(body.items[0].reversed_vat_id).toBe(7);
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
  });

  it("delete_purchase_invoice calls DELETE and returns API JSON", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.delete_purchase_invoice.handler({ id: 55 });
    expect(client.delete).toHaveBeenCalledWith("/v1/purchase_invoices/55");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("register_purchase_invoice patches register without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.register_purchase_invoice.handler({ id: 42 });
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/42/register");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
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
