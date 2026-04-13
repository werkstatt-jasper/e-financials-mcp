import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createInvoiceSettingsTools } from "./invoiceSettings.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

describe("invoice settings tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createInvoiceSettingsTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createInvoiceSettingsTools(client);
  });

  it("get_invoice_info calls GET /v1/invoice_info", async () => {
    const payload = { email: "a@b.ee", cl_templates_id: 1 };
    vi.mocked(client.get).mockResolvedValue(payload as never);

    const result = await tools.get_invoice_info.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/invoice_info");
    expect(parseToolJson(result)).toEqual(payload);
  });

  it("get_invoice_series calls GET with id", async () => {
    const payload = {
      id: 3,
      is_active: true,
      is_default: false,
      number_prefix: "NX",
      number_start_value: 1,
      term_days: 28,
    };
    vi.mocked(client.get).mockResolvedValue(payload as never);

    const result = await tools.get_invoice_series.handler({ invoice_series_id: 3 });
    expect(client.get).toHaveBeenCalledWith("/v1/invoice_series/3");
    expect(parseToolJson(result)).toEqual(payload);
  });

  it("list_invoice_series normalizes raw array response", async () => {
    const rows = [
      {
        id: 1,
        is_active: true,
        is_default: true,
        number_prefix: "A",
        number_start_value: 1,
        term_days: 14,
      },
    ];
    vi.mocked(client.get).mockResolvedValue(rows as never);

    const result = await tools.list_invoice_series.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/invoice_series");
    expect(parseToolJson(result)).toEqual(rows);
  });

  it("list_invoice_series normalizes { items } response", async () => {
    const rows = [
      {
        id: 2,
        is_active: true,
        is_default: false,
        number_prefix: "B",
        number_start_value: 10,
        term_days: 30,
      },
    ];
    vi.mocked(client.get).mockResolvedValue({ items: rows } as never);

    const result = await tools.list_invoice_series.handler({});
    expect(parseToolJson(result)).toEqual(rows);
  });

  it("list_invoice_series returns empty array for empty object", async () => {
    vi.mocked(client.get).mockResolvedValue({} as never);
    const result = await tools.list_invoice_series.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("list_invoice_series returns empty array when response is null", async () => {
    vi.mocked(client.get).mockResolvedValue(null as never);
    const result = await tools.list_invoice_series.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("list_invoice_series returns empty array when items is not an array", async () => {
    vi.mocked(client.get).mockResolvedValue({ items: null } as never);
    const result = await tools.list_invoice_series.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("create_invoice_series posts body without id", async () => {
    vi.mocked(client.post).mockResolvedValue({ response_code: 0, id: 99 } as never);

    await tools.create_invoice_series.handler({
      is_active: true,
      is_default: false,
      number_prefix: "NX",
      number_start_value: 1,
      term_days: 28,
      overdue_charge: 0.15,
    });

    expect(client.post).toHaveBeenCalledWith("/v1/invoice_series", {
      is_active: true,
      is_default: false,
      number_prefix: "NX",
      number_start_value: 1,
      term_days: 28,
      overdue_charge: 0.15,
    });
  });

  it("update_invoice_info sends only provided fields", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.update_invoice_info.handler({ email: "x@y.ee", phone: "123" });

    expect(client.patch).toHaveBeenCalledWith("/v1/invoice_info", {
      email: "x@y.ee",
      phone: "123",
    });
  });

  it("update_invoice_series sends only provided fields", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    await tools.update_invoice_series.handler({
      invoice_series_id: 5,
      term_days: 60,
    });

    expect(client.patch).toHaveBeenCalledWith("/v1/invoice_series/5", {
      term_days: 60,
    });
  });

  it("delete_invoice_series calls DELETE", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);

    await tools.delete_invoice_series.handler({ invoice_series_id: 7 });
    expect(client.delete).toHaveBeenCalledWith("/v1/invoice_series/7");
  });
});
