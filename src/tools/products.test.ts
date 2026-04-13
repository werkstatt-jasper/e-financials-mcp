import { beforeEach, describe, expect, it, vi } from "vitest";
import productsFixture from "../__fixtures__/products.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import { createProductTools } from "./products.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

describe("product tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createProductTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createProductTools(client);
  });

  it("list_products returns items and pagination", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...productsFixture.list_paged } as never);

    const result = await tools.list_products.handler({
      page: 2,
      modified_since: "2024-01-01T00:00:00Z",
    });
    expect(client.get).toHaveBeenCalledWith("/v1/products", {
      page: 2,
      modified_since: "2024-01-01T00:00:00Z",
    });
    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toHaveLength(1);
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(3);
  });

  it("list_products defaults pagination when API omits fields", async () => {
    vi.mocked(client.get).mockResolvedValue({ items: [] } as never);
    const result = await tools.list_products.handler({});
    const data = parseToolJson(result) as { current_page: number; total_pages: number };
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(1);
  });

  it("list_products defaults items to empty array when API omits items", async () => {
    vi.mocked(client.get).mockResolvedValue({
      current_page: 2,
      total_pages: 5,
    } as never);
    const result = await tools.list_products.handler({});
    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toEqual([]);
    expect(data.current_page).toBe(2);
    expect(data.total_pages).toBe(5);
  });

  it("get_product fetches by products_id", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...productsFixture.single } as never);
    const result = await tools.get_product.handler({ products_id: 36166 });
    expect(client.get).toHaveBeenCalledWith("/v1/products/36166");
    expect(parseToolJson(result)).toEqual(productsFixture.single);
  });

  it("create_product posts body with OpenAPI field names", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...productsFixture.api_ok } as never);
    const result = await tools.create_product.handler({
      name: "Item A",
      code: "A1",
      sales_price: 9.99,
      price_currency: "EUR",
    });
    expect(client.post).toHaveBeenCalledWith("/v1/products", {
      name: "Item A",
      code: "A1",
      sales_price: 9.99,
      price_currency: "EUR",
    });
    expect(parseToolJson(result)).toEqual(productsFixture.api_ok);
  });

  it("update_product patches with only provided fields", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...productsFixture.api_ok } as never);
    const result = await tools.update_product.handler({
      products_id: 42,
      name: "Renamed",
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/products/42", { name: "Renamed" });
    expect(parseToolJson(result)).toEqual(productsFixture.api_ok);
  });

  it("delete_product calls DELETE", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);
    const result = await tools.delete_product.handler({ products_id: 7 });
    expect(client.delete).toHaveBeenCalledWith("/v1/products/7");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("deactivate_product patches deactivate path without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
    const result = await tools.deactivate_product.handler({ products_id: 7 });
    expect(client.patch).toHaveBeenCalledWith("/v1/products/7/deactivate");
    expect(client.patch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(client.patch).mock.calls[0];
    expect(call[1]).toBeUndefined();
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("reactivate_product patches reactivate path without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
    const result = await tools.reactivate_product.handler({ products_id: 8 });
    expect(client.patch).toHaveBeenCalledWith("/v1/products/8/reactivate");
    const call = vi.mocked(client.patch).mock.calls[0];
    expect(call[1]).toBeUndefined();
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });
});
