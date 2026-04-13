import { beforeEach, describe, expect, it, vi } from "vitest";
import clientsFixture from "../__fixtures__/clients.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import { createClientTools } from "./clients.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

describe("client tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createClientTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createClientTools(client);
  });

  it("list_clients defaults pagination when response omits meta", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...clientsFixture.empty_object } as never);
    const result = await tools.list_clients.handler({});
    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toEqual([]);
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(1);
  });

  it("list_clients passes query params to the API", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...clientsFixture.list_paginated } as never);

    const result = await tools.list_clients.handler({
      page: 3,
      is_supplier: true,
      modified_since: "2025-01-01T00:00:00Z",
    });

    expect(client.get).toHaveBeenCalledWith(
      "/v1/clients",
      expect.objectContaining({
        page: 3,
        is_supplier: true,
        modified_since: "2025-01-01T00:00:00Z",
      }),
    );

    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toHaveLength(1);
    expect(data.current_page).toBe(3);
  });

  it("search_clients filters client list by query case-insensitively", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(
      clientsFixture.search_two_clients.items as never,
    );

    const result = await tools.search_clients.handler({ query: "alpha" });
    const data = parseToolJson(result) as { query: string; count: number; clients: unknown[] };
    expect(data.count).toBe(1);
    expect((data.clients as { id: number }[])[0].id).toBe(1);
  });

  it("search_clients passes is_supplier to list endpoint", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(
      clientsFixture.search_two_clients.items as never,
    );
    await tools.search_clients.handler({ query: "a", is_supplier: true });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/clients", { is_supplier: true });
  });

  it("search_clients returns empty matches when items missing", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue([]);

    const result = await tools.search_clients.handler({ query: "zzz" });
    const data = parseToolJson(result) as { count: number; clients: unknown[] };
    expect(data.count).toBe(0);
    expect(data.clients).toEqual([]);
  });

  it("create_client maps params and posts to API", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...clientsFixture.created_client } as never);

    const result = await tools.create_client.handler({
      name: "New Co",
      country_code: "EE",
      is_supplier: true,
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/clients",
      expect.objectContaining({
        name: "New Co",
        cl_code_country: "EST",
        is_supplier: true,
      }),
    );
    const data = parseToolJson(result) as { success: boolean; id: number };
    expect(data.success).toBe(true);
    expect(data.id).toBe(55);
  });

  it("list_suppliers calls clients API with is_supplier true", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...clientsFixture.suppliers_only } as never);
    const result = await tools.list_suppliers.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/clients", { is_supplier: true });
    expect(parseToolJson(result)).toEqual(clientsFixture.suppliers_only.items);
  });

  it("list_suppliers returns empty array when items missing", async () => {
    vi.mocked(client.get).mockResolvedValue({} as never);
    const result = await tools.list_suppliers.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("get_client fetches by id", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...clientsFixture.client_by_id } as never);
    const result = await tools.get_client.handler({ id: 7 });
    expect(client.get).toHaveBeenCalledWith("/v1/clients/7");
    expect(parseToolJson(result)).toEqual(clientsFixture.client_by_id);
  });

  it("create_client builds address_text from address parts", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...clientsFixture.created_client } as never);
    await tools.create_client.handler({
      name: "Addr Co",
      address: "St 1",
      city: "Tallinn",
      postal_code: "10111",
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/clients",
      expect.objectContaining({
        address_text: "St 1, Tallinn, 10111",
      }),
    );
  });

  it("create_client passes through unmapped country codes uppercased", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...clientsFixture.created_client } as never);
    await tools.create_client.handler({ name: "X", country_code: "zz" });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/clients",
      expect.objectContaining({ cl_code_country: "ZZ" }),
    );
  });

  it("propagates API errors from client", async () => {
    vi.mocked(client.get).mockRejectedValue(new Error("API Error 401: Unauthorized"));

    await expect(tools.list_clients.handler({})).rejects.toThrow("401");
  });

  it("update_client patches only supplied fields", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...clientsFixture.client_by_id } as never);

    await tools.update_client.handler({
      id: 7,
      email: "a@b.co",
      is_supplier: true,
    });

    expect(client.patch).toHaveBeenCalledWith("/v1/clients/7", {
      email: "a@b.co",
      is_supplier: true,
    });
  });

  it("update_client maps address parts to address_text", async () => {
    vi.mocked(client.patch).mockResolvedValue({} as never);
    await tools.update_client.handler({
      id: 3,
      address: "St 1",
      city: "Tartu",
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/clients/3", {
      address_text: "St 1, Tartu",
    });
  });

  it("update_client uses empty address_text when address fields are blank", async () => {
    vi.mocked(client.patch).mockResolvedValue({} as never);
    await tools.update_client.handler({
      id: 2,
      name: "OnlyName",
      address: "",
      city: "",
      postal_code: "",
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/clients/2", {
      name: "OnlyName",
      address_text: "",
    });
  });

  it("update_client omits cl_code_country when country_code is blank", async () => {
    vi.mocked(client.patch).mockResolvedValue({} as never);
    await tools.update_client.handler({
      id: 8,
      name: "X",
      country_code: "",
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/clients/8", { name: "X" });
  });

  it("update_client maps is_buyer, bank_account, and payment_term_days", async () => {
    vi.mocked(client.patch).mockResolvedValue({} as never);
    await tools.update_client.handler({
      id: 6,
      is_buyer: false,
      bank_account: "EE123",
      payment_term_days: 21,
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/clients/6", {
      is_client: false,
      bank_account_no: "EE123",
      invoice_days: 21,
    });
  });

  it("update_client maps reg_code, vat_no, phone, and country_code", async () => {
    vi.mocked(client.patch).mockResolvedValue({} as never);
    await tools.update_client.handler({
      id: 11,
      reg_code: "12345678",
      vat_no: "EE123",
      phone: "+3721",
      country_code: "EE",
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/clients/11", {
      code: "12345678",
      invoice_vat_no: "EE123",
      telephone: "+3721",
      cl_code_country: "EST",
    });
  });

  it("update_client rejects when no fields to change", async () => {
    await expect(tools.update_client.handler({ id: 1 })).rejects.toThrow(
      /at least one field to change/,
    );
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("delete_client calls DELETE path", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);
    const result = await tools.delete_client.handler({ id: 9 });
    expect(client.delete).toHaveBeenCalledWith("/v1/clients/9");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("deactivate_client patches deactivate path without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
    const result = await tools.deactivate_client.handler({ id: 4 });
    expect(client.patch).toHaveBeenCalledWith("/v1/clients/4/deactivate");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("reactivate_client patches reactivate path without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
    const result = await tools.reactivate_client.handler({ id: 5 });
    expect(client.patch).toHaveBeenCalledWith("/v1/clients/5/reactivate");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });
});
