import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import transactionsFixture from "../__fixtures__/transactions.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";
import { createTransactionTools } from "./transactions.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("transaction tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createTransactionTools>;

  beforeEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
    client = createMockClient();
    tools = createTransactionTools(client);
    vi.mocked(readFile).mockReset();
  });

  it("list_transactions passes filters and returns paginated shape", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...transactionsFixture.list_paginated } as never);

    const result = await tools.list_transactions.handler({
      page: 2,
      start_date: "2025-01-01",
      end_date: "2025-01-31",
      type: "C",
    });

    expect(client.get).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({
        page: 2,
        start_date: "2025-01-01",
        end_date: "2025-01-31",
        type: "C",
      }),
    );

    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toHaveLength(1);
    expect(data.current_page).toBe(2);
    expect(data.total_pages).toBe(5);
    expect(result.content[0].type).toBe("text");
  });

  it("list_transactions defaults items when response has no items key", async () => {
    vi.mocked(client.get).mockResolvedValue({} as never);
    const result = await tools.list_transactions.handler({});
    const data = parseToolJson(result) as { items: unknown[] };
    expect(data.items).toEqual([]);
  });

  it("list_transactions uses defaults when response omits pagination", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...transactionsFixture.list_empty } as never);

    const result = await tools.list_transactions.handler({});
    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toEqual([]);
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(1);
  });

  it("get_transaction fetches by id and returns JSON body", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...transactionsFixture.single } as never);

    const result = await tools.get_transaction.handler({ id: 42 });
    expect(client.get).toHaveBeenCalledWith("/v1/transactions/42");
    expect(parseToolJson(result)).toEqual({ id: 42, description: "Wire" });
  });

  it("get_unprocessed_transactions coalesces null items to an empty list", async () => {
    vi.mocked(client.get).mockResolvedValue({ items: null } as never);
    const result = await tools.get_unprocessed_transactions.handler({});
    const data = parseToolJson(result) as { count: number; transactions: unknown[] };
    expect(data.count).toBe(0);
    expect(data.transactions).toEqual([]);
  });

  it("get_unprocessed_transactions returns empty when all rows have clients_id", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [{ id: 1, clients_id: 9, status: "PROJECT", type: "C", amount: 1, description: "x" }],
    } as never);
    const result = await tools.get_unprocessed_transactions.handler({});
    const data = parseToolJson(result) as { count: number };
    expect(data.count).toBe(0);
  });

  it("get_unprocessed_transactions treats undefined clients_id as unprocessed", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [{ id: 1, status: "PROJECT", type: "C", amount: 1, description: "x" }],
    } as never);
    const result = await tools.get_unprocessed_transactions.handler({});
    const data = parseToolJson(result) as { count: number };
    expect(data.count).toBe(1);
  });

  it("get_unprocessed_transactions treats clients_id zero as unassigned", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [
        {
          id: 1,
          clients_id: 0,
          status: "PROJECT",
          type: "C",
          amount: 1,
          description: "edge",
        },
      ],
    } as never);
    const result = await tools.get_unprocessed_transactions.handler({});
    const data = parseToolJson(result) as { count: number; transactions: { id: number }[] };
    expect(data.count).toBe(1);
    expect(data.transactions[0].id).toBe(1);
  });

  it("get_unprocessed_transactions filters out rows with clients_id", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...transactionsFixture.unprocessed_mixed } as never);

    const result = await tools.get_unprocessed_transactions.handler({
      type: "C",
      start_date: "2025-01-01",
    });

    expect(client.get).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({
        status: "PROJECT",
        type: "C",
        start_date: "2025-01-01",
      }),
    );
    const data = parseToolJson(result) as { count: number; transactions: { id: number }[] };
    expect(data.count).toBe(1);
    expect(data.transactions[0].id).toBe(1);
  });

  it("update_transaction patches and wraps success", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...transactionsFixture.patch_result } as never);

    const result = await tools.update_transaction.handler({
      id: 7,
      clients_id: 99,
      description: "Updated",
    });

    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/7", {
      clients_id: 99,
      description: "Updated",
    });
    const data = parseToolJson(result) as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toBe("Transaction 7 updated");
  });

  it("create_transaction posts required and optional writable fields", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...transactionsFixture.http_post_created } as never);

    const result = await tools.create_transaction.handler({
      accounts_dimensions_id: 4,
      type: "D",
      amount: 100,
      cl_currencies_id: "EUR",
      date: "2025-03-01",
      description: "Manual",
      clients_id: 19,
    });

    expect(client.post).toHaveBeenCalledWith("/v1/transactions", {
      accounts_dimensions_id: 4,
      type: "D",
      amount: 100,
      cl_currencies_id: "EUR",
      date: "2025-03-01",
      description: "Manual",
      clients_id: 19,
    });
    expect(parseToolJson(result)).toEqual({ id: 1 });
  });

  it("create_transaction omits undefined optional fields", async () => {
    vi.mocked(client.post).mockResolvedValue({ response_code: 0, id: 2 } as never);

    await tools.create_transaction.handler({
      accounts_dimensions_id: 1,
      type: "C",
      amount: 50,
      cl_currencies_id: "EUR",
      date: "2025-03-02",
    });

    expect(client.post).toHaveBeenCalledWith("/v1/transactions", {
      accounts_dimensions_id: 1,
      type: "C",
      amount: 50,
      cl_currencies_id: "EUR",
      date: "2025-03-02",
    });
  });

  it("create_transaction forwards remaining optional OpenAPI fields", async () => {
    vi.mocked(client.post).mockResolvedValue({ id: 3 } as never);

    await tools.create_transaction.handler({
      accounts_dimensions_id: 2,
      type: "D",
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2025-03-03",
      ref_number: "REF-1",
      bank_account_name: "ACME Ltd",
      base_amount: 10,
      currency_rate: 1,
      transactions_files_id: 77,
      export_format: "xlsx",
    });

    expect(client.post).toHaveBeenCalledWith("/v1/transactions", {
      accounts_dimensions_id: 2,
      type: "D",
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2025-03-03",
      ref_number: "REF-1",
      bank_account_name: "ACME Ltd",
      base_amount: 10,
      currency_rate: 1,
      transactions_files_id: 77,
      export_format: "xlsx",
    });
  });

  it("delete_transaction calls DELETE and returns API JSON", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.delete_transaction.handler({ id: 55 });
    expect(client.delete).toHaveBeenCalledWith("/v1/transactions/55");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("register_transaction patches register with distributions array as body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const distributions = [
      { related_table: "accounts", amount: 100, related_id: 1010, related_sub_id: 4 },
    ];
    const result = await tools.register_transaction.handler({
      id: 88,
      distributions,
    });

    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/88/register", distributions);
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("invalidate_transaction patches invalidate without body", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const result = await tools.invalidate_transaction.handler({ id: 90 });
    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/90/invalidate");
    expect(parseToolJson(result)).toEqual({ response_code: 0 });
  });

  it("get_transaction_file returns ApiFile JSON", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...transactionsFixture.api_file } as never);
    const result = await tools.get_transaction_file.handler({ id: 12 });
    expect(client.get).toHaveBeenCalledWith("/v1/transactions/12/document_user");
    expect(parseToolJson(result)).toEqual(transactionsFixture.api_file);
  });

  it("upload_transaction_file reads file, encodes base64, and puts document", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("hello"));
    vi.mocked(client.put).mockResolvedValue({ ...transactionsFixture.upload_put_ok } as never);

    const result = await tools.upload_transaction_file.handler({
      id: 55,
      file_path: "/tmp/scan.pdf",
    });

    expect(readFile).toHaveBeenCalledWith("/tmp/scan.pdf");
    expect(client.put).toHaveBeenCalledWith("/v1/transactions/55/document_user", {
      name: "scan.pdf",
      contents: Buffer.from("hello").toString("base64"),
    });
    const data = parseToolJson(result) as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toContain("scan.pdf");
    expect(data.message).toContain("55");
  });

  it("delete_transaction_file deletes document_user", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);
    await tools.delete_transaction_file.handler({ id: 12 });
    expect(client.delete).toHaveBeenCalledWith("/v1/transactions/12/document_user");
  });

  it("propagates read errors from upload_transaction_file", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    await expect(
      tools.upload_transaction_file.handler({ id: 1, file_path: "/nope" }),
    ).rejects.toThrow("ENOENT");
  });

  it("propagates API errors from client", async () => {
    vi.mocked(client.get).mockRejectedValue(new Error("API Error 404: Not found"));

    await expect(tools.list_transactions.handler({})).rejects.toThrow("404");
  });
});
