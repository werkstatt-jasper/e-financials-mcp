import { beforeEach, describe, expect, it, vi } from "vitest";
import accountsFixture from "../__fixtures__/accounts.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import { createAccountTools } from "./accounts.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

describe("account tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createAccountTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createAccountTools(client);
  });

  it("list_accounts extracts items from paged response", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...accountsFixture.list_one_account } as never);

    const result = await tools.list_accounts.handler({ type: "ASSET" });
    expect(client.get).toHaveBeenCalledWith("/v1/accounts", { type: "ASSET" });
    const data = parseToolJson(result) as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
    expect((data[0] as { id: number }).id).toBe(100);
  });

  it("list_accounts returns empty array when no items", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...accountsFixture.list_empty } as never);
    const result = await tools.list_accounts.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("list_accounts returns empty array when response has no items key", async () => {
    vi.mocked(client.get).mockResolvedValue({ not_items: true } as never);
    const result = await tools.list_accounts.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("list_accounts handles API returning a bare array", async () => {
    vi.mocked(client.get).mockResolvedValue([...accountsFixture.chart_raw_array] as never);
    const result = await tools.list_accounts.handler({});
    expect(parseToolJson(result)).toEqual(accountsFixture.chart_raw_array);
  });

  it("get_bank_accounts returns extracted list", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [{ id: 1, account_name_est: "B1", account_no: "EE1" }],
    } as never);
    const result = await tools.get_bank_accounts.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/bank_accounts");
    expect(parseToolJson(result)).toEqual([{ id: 1, account_name_est: "B1", account_no: "EE1" }]);
  });

  it("get_bank_accounts handles null API body", async () => {
    vi.mocked(client.get).mockResolvedValue(null as never);
    const result = await tools.get_bank_accounts.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("get_vat_info returns raw response JSON", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...accountsFixture.vat_info } as never);
    const result = await tools.get_vat_info.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/vat_info");
    expect(parseToolJson(result)).toEqual(accountsFixture.vat_info);
  });

  it("list_projects extracts items", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...accountsFixture.projects_list } as never);
    const result = await tools.list_projects.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/projects");
    expect(parseToolJson(result)).toEqual(accountsFixture.projects_list.items);
  });

  it("list_purchase_articles extracts items", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...accountsFixture.purchase_articles_list } as never);
    const result = await tools.list_purchase_articles.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/purchase_articles");
    expect(parseToolJson(result)).toEqual(accountsFixture.purchase_articles_list.items);
  });

  it("list_account_dimensions filters by accounts_id when provided", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...accountsFixture.dimensions_two } as never);

    const result = await tools.list_account_dimensions.handler({ accounts_id: 1820 });
    const data = parseToolJson(result) as { count: number; dimensions: { id: number }[] };
    expect(data.count).toBe(1);
    expect(data.dimensions[0].id).toBe(1);
  });

  it("list_account_dimensions returns all dimensions when filter omitted", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...accountsFixture.dimensions_one } as never);

    const result = await tools.list_account_dimensions.handler({});
    const data = parseToolJson(result) as { filter: string; count: number };
    expect(data.filter).toBe("none");
    expect(data.count).toBe(1);
  });

  it("search_accounts matches name or id", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(
      accountsFixture.search_two_accounts.items as never,
    );

    const result = await tools.search_accounts.handler({ query: "teen" });
    const data = parseToolJson(result) as { count: number; accounts: { id: number }[] };
    expect(data.count).toBe(1);
    expect(data.accounts[0].id).toBe(6010);
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/accounts");
  });

  it("search_accounts matches numeric id substring", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(
      accountsFixture.search_two_accounts.items as never,
    );
    const result = await tools.search_accounts.handler({ query: "6010" });
    const data = parseToolJson(result) as { count: number };
    expect(data.count).toBe(1);
  });

  it("propagates API errors from client", async () => {
    vi.mocked(client.get).mockRejectedValue(new Error("API Error 500: Server error"));

    await expect(tools.get_bank_accounts.handler({})).rejects.toThrow("500");
  });

  it("create_bank_account posts OpenAPI body", async () => {
    vi.mocked(client.post).mockResolvedValue({ id: 16, response_code: 0 } as never);
    const result = await tools.create_bank_account.handler({
      account_name_est: "Main",
      account_no: "EE123",
      swift_code: "HABAEE2X",
    });
    expect(client.post).toHaveBeenCalledWith("/v1/bank_accounts", {
      account_name_est: "Main",
      account_no: "EE123",
      swift_code: "HABAEE2X",
    });
    expect(parseToolJson(result)).toEqual({ id: 16, response_code: 0 });
  });

  it("get_bank_account fetches by id", async () => {
    vi.mocked(client.get).mockResolvedValue({
      id: 16,
      account_name_est: "Main",
      account_no: "EE123",
    } as never);
    const result = await tools.get_bank_account.handler({ bank_accounts_id: 16 });
    expect(client.get).toHaveBeenCalledWith("/v1/bank_accounts/16");
    expect(parseToolJson(result)).toMatchObject({ id: 16, account_no: "EE123" });
  });

  it("update_bank_account patches partial body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
    const result = await tools.update_bank_account.handler({
      bank_accounts_id: 16,
      iban_code: "EE999",
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/bank_accounts/16", { iban_code: "EE999" });
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("delete_bank_account calls DELETE", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);
    const result = await tools.delete_bank_account.handler({ bank_accounts_id: 16 });
    expect(client.delete).toHaveBeenCalledWith("/v1/bank_accounts/16");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("propagates API errors from create_bank_account", async () => {
    vi.mocked(client.post).mockRejectedValue(new Error("API Error 409: Conflict"));
    await expect(
      tools.create_bank_account.handler({ account_name_est: "X", account_no: "Y" }),
    ).rejects.toThrow("409");
  });
});
