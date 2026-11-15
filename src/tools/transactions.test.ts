import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import transactionsFixture from "../__fixtures__/transactions.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import {
  createMockClient,
  mockTransactionLists,
  parseToolJson,
  transactionLists,
} from "./test-helpers.js";
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
    vi.mocked(client.getAllPages).mockResolvedValue([] as never);
    tools = createTransactionTools(client);
    vi.mocked(readFile).mockReset();
  });

  /** Chart rows that satisfy the cash/bank and currency check for the pay tool. */
  function paymentSources(currency: string) {
    return {
      dimensions: [
        {
          id: 41442,
          accounts_id: 1360,
          title_est: "Aruandvad isikud",
          title_eng: "Accountable persons",
          cl_currencies_id: currency,
        },
        {
          id: 1,
          accounts_id: 1360,
          title_est: "Aruandvad isikud",
          title_eng: "Accountable persons",
          cl_currencies_id: currency,
        },
      ],
      accounts: [
        { id: 1360, transaction_out_bindable: true, transaction_out_user_bindable: false },
      ],
    };
  }

  function routePaymentLists(
    transactions: (params?: Record<string, unknown>) => unknown,
    currency = "EUR",
  ) {
    const sources = paymentSources(currency);
    vi.mocked(client.getAllPages).mockImplementation(async (path: string, params) => {
      if (path === "/v1/account_dimensions") {
        return sources.dimensions as never;
      }
      if (path === "/v1/accounts") {
        return sources.accounts as never;
      }
      if (path === "/v1/bank_accounts") {
        return [] as never;
      }
      return transactions(params) as never;
    });
  }

  /** The created id is in that day's unfiltered list and not in the incoming filter. */
  function listOutgoingDraft(id: number, currency = "EUR") {
    routePaymentLists(transactionLists([{ id }], []), currency);
  }

  it("list_transactions type C pages RIK's incoming-rows filter", async () => {
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
        type: "D",
      }),
    );
    const data = parseToolJson(result) as {
      items: Array<{ type?: string }>;
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toEqual([{ id: 1, amount: 10, type: "C" }]);
    expect(data.current_page).toBe(2);
    expect(data.total_pages).toBe(5);
    expect(client.getAllPages).not.toHaveBeenCalled();
  });

  it("list_transactions type D lists everything else and pages locally", async () => {
    const rows = [
      { id: 1, date: "2026-10-01", status: "PROJECT" },
      { id: 2, date: "2026-10-02", status: "PROJECT" },
      { id: 3, date: "2026-10-03", status: "CONFIRMED" },
    ];
    mockTransactionLists(client, rows, [2]);

    const first = parseToolJson(
      await tools.list_transactions.handler({ type: "D", clients_id: 4 }),
    ) as { items: Array<{ id: number; type: string }>; current_page: number; total_pages: number };
    expect(first.items.map((row) => [row.id, row.type])).toEqual([
      [1, "D"],
      [3, "D"],
    ]);
    expect(first).toMatchObject({ current_page: 1, total_pages: 1 });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", { clients_id: 4 });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      clients_id: 4,
      type: "D",
    });
    expect(client.get).not.toHaveBeenCalled();

    const second = parseToolJson(await tools.list_transactions.handler({ type: "D", page: 2 })) as {
      items: unknown[];
      current_page: number;
    };
    expect(second).toMatchObject({ items: [], current_page: 2 });
  });

  it("list_transactions without type labels the page from incoming rows in its date range", async () => {
    const rows = [
      { id: 1, date: "2026-10-01", type: "C" },
      { id: 2, date: "2026-10-03", type: "C" },
    ];
    vi.mocked(client.get).mockResolvedValue({
      items: rows,
      current_page: 1,
      total_pages: 2,
    } as never);
    mockTransactionLists(client, rows, [2]);

    const data = parseToolJson(
      await tools.list_transactions.handler({ status: "PROJECT", page: 1 }),
    ) as { items: Array<{ id: number; type: string }>; total_pages: number };

    expect(data.items.map((row) => [row.id, row.type])).toEqual([
      [1, "D"],
      [2, "C"],
    ]);
    expect(data.total_pages).toBe(2);
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      status: "PROJECT",
      start_date: "2026-10-01",
      end_date: "2026-10-03",
      type: "D",
    });
  });

  it("list_transactions defaults items when response has no items key", async () => {
    vi.mocked(client.get).mockResolvedValue({} as never);
    const result = await tools.list_transactions.handler({});
    const data = parseToolJson(result) as { items: unknown[] };
    expect(data.items).toEqual([]);
    expect(client.getAllPages).not.toHaveBeenCalled();
  });

  it("list_transactions uses defaults when response omits pagination", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [{ id: 1, type: "C", date: "2026-10-01" }],
    } as never);

    const result = await tools.list_transactions.handler({});
    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toEqual([{ id: 1, type: "D", date: "2026-10-01" }]);
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(1);
  });

  it("get_transaction labels the row from that day's incoming rows", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...transactionsFixture.single } as never);
    mockTransactionLists(client, [{ id: 42 }], []);

    const outgoing = await tools.get_transaction.handler({ id: 42 });
    expect(client.get).toHaveBeenCalledWith("/v1/transactions/42");
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
    });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
      type: "D",
    });
    expect(parseToolJson(outgoing)).toEqual({
      id: 42,
      description: "Wire",
      type: "D",
      date: "2026-10-01",
      direction_confirmed: true,
    });

    mockTransactionLists(client, [{ id: 42 }], [42]);
    const incoming = await tools.get_transaction.handler({ id: 42 });
    expect(parseToolJson(incoming)).toMatchObject({
      id: 42,
      type: "C",
      direction_confirmed: true,
    });
  });

  it("get_transaction reports unknown when the row is not in that day's lists", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...transactionsFixture.single } as never);

    const missing = parseToolJson(await tools.get_transaction.handler({ id: 42 })) as {
      type: string | null;
      direction_confirmed: boolean;
    };
    expect(missing.type).toBeNull();
    expect(missing.direction_confirmed).toBe(false);

    vi.mocked(client.getAllPages).mockClear();
    vi.mocked(client.get).mockResolvedValue({ id: 42, description: "Wire", type: "C" } as never);
    const noDate = parseToolJson(await tools.get_transaction.handler({ id: 42 })) as {
      type: string | null;
      direction_confirmed: boolean;
    };
    expect(noDate.type).toBeNull();
    expect(noDate.direction_confirmed).toBe(false);
    expect(client.getAllPages).not.toHaveBeenCalled();
  });

  it("get_unprocessed_transactions returns empty when there are no drafts", async () => {
    const result = await tools.get_unprocessed_transactions.handler({});
    const data = parseToolJson(result) as { count: number; transactions: unknown[] };
    expect(data.count).toBe(0);
    expect(data.transactions).toEqual([]);
  });

  it("get_unprocessed_transactions returns empty when all rows have clients_id", async () => {
    mockTransactionLists(
      client,
      [{ id: 1, clients_id: 9, status: "PROJECT", amount: 1, description: "x" }],
      [],
    );
    const result = await tools.get_unprocessed_transactions.handler({});
    const data = parseToolJson(result) as { count: number };
    expect(data.count).toBe(0);
  });

  it("get_unprocessed_transactions treats undefined clients_id as unprocessed", async () => {
    mockTransactionLists(client, [{ id: 1, status: "PROJECT", amount: 1, description: "x" }], []);
    const result = await tools.get_unprocessed_transactions.handler({});
    const data = parseToolJson(result) as { count: number; transactions: { type: string }[] };
    expect(data.count).toBe(1);
    expect(data.transactions[0].type).toBe("D");
  });

  it("get_unprocessed_transactions treats clients_id zero as unassigned", async () => {
    mockTransactionLists(
      client,
      [{ id: 1, clients_id: 0, status: "PROJECT", amount: 1, description: "edge" }],
      [1],
    );
    const result = await tools.get_unprocessed_transactions.handler({});
    const data = parseToolJson(result) as { count: number; transactions: { id: number }[] };
    expect(data.count).toBe(1);
    expect(data.transactions[0].id).toBe(1);
  });

  it("get_unprocessed_transactions filters by direction and drops rows with clients_id", async () => {
    const drafts = [
      ...transactionsFixture.unprocessed_mixed.items,
      { id: 3, clients_id: null, status: "PROJECT", type: "C", amount: 3, description: "c" },
    ];
    mockTransactionLists(client, drafts, [1, 2]);

    const incoming = parseToolJson(
      await tools.get_unprocessed_transactions.handler({ type: "C", start_date: "2025-01-01" }),
    ) as { count: number; transactions: { id: number; type: string }[] };

    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      status: "PROJECT",
      start_date: "2025-01-01",
    });
    expect(incoming.transactions.map((row) => [row.id, row.type])).toEqual([[1, "C"]]);

    const outgoing = parseToolJson(
      await tools.get_unprocessed_transactions.handler({ type: "D" }),
    ) as { transactions: { id: number; type: string }[] };
    expect(outgoing.transactions.map((row) => [row.id, row.type])).toEqual([[3, "D"]]);
  });

  it("update_transaction patches and wraps success", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...transactionsFixture.patch_result } as never);

    const result = await tools.update_transaction.handler({
      id: 7,
      clients_id: 99,
      accounts_id: 12,
      description: "Updated",
    });

    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/7", {
      clients_id: 99,
      accounts_id: 12,
      description: "Updated",
    });
    const data = parseToolJson(result) as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toBe("Transaction 7 updated");
  });

  it("create_transaction posts money-out as RIK type C and returns type D", async () => {
    vi.mocked(client.post).mockResolvedValue({
      id: 1,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 1, type: "C", status: "PROJECT" } as never);
    listOutgoingDraft(1);

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
      type: "C",
      amount: 100,
      cl_currencies_id: "EUR",
      date: "2025-03-01",
      description: "Manual",
      clients_id: 19,
    });
    expect(client.patch).not.toHaveBeenCalled();
    expect(parseToolJson(result)).toMatchObject({
      id: 1,
      type: "D",
      rik_messages: ["Outgoing payment has been saved."],
      direction_confirmed: true,
    });
  });

  it("create_transaction posts money-in as RIK type D", async () => {
    vi.mocked(client.post).mockResolvedValue({
      id: 2,
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 2, type: "C", status: "PROJECT" } as never);
    mockTransactionLists(client, [{ id: 2 }], [2]);

    await tools.create_transaction.handler({
      accounts_dimensions_id: 1,
      type: "C",
      amount: 50,
      cl_currencies_id: "EUR",
      date: "2025-03-02",
    });

    expect(client.post).toHaveBeenCalledWith("/v1/transactions", {
      accounts_dimensions_id: 1,
      type: "D",
      amount: 50,
      cl_currencies_id: "EUR",
      date: "2025-03-02",
    });
  });

  it("create_transaction forwards remaining optional OpenAPI fields", async () => {
    vi.mocked(client.post).mockResolvedValue({
      id: 3,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 3, type: "C", status: "PROJECT" } as never);
    listOutgoingDraft(3);

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
      type: "C",
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

  it("register_transaction accepts purchase_invoices distribution rows", async () => {
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);

    const distributions = [{ related_table: "purchase_invoices", amount: 59.94, related_id: 123 }];
    await tools.register_transaction.handler({ id: 88, distributions });

    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/88/register", distributions);
  });

  it("register_transaction description maps UI add-row and related_table values", () => {
    const { description, inputSchema } = tools.register_transaction;
    expect(description).toMatch(/Add a row/i);
    expect(description).toMatch(/purchase_invoices/);
    expect(description).toMatch(/sale_invoices/);
    expect(description).toMatch(/clients_id/);
    const relatedTable = inputSchema.properties.distributions.items.properties.related_table;
    expect(relatedTable.description).toMatch(/purchase_invoices/);
  });

  it("update_transaction description clarifies metadata-only vs distributions", () => {
    expect(tools.update_transaction.description).toMatch(/Does not add or change distribution/i);
    expect(tools.update_transaction.description).toMatch(/register_transaction/);
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

  it("upload_transaction_file accepts inline base64 payload", async () => {
    vi.mocked(client.put).mockResolvedValue({ ...transactionsFixture.upload_put_ok } as never);
    const b64 = Buffer.from("%PDF-1.4").toString("base64");
    const result = await tools.upload_transaction_file.handler({
      id: 55,
      file_path: `base64:${b64}`,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(client.put).toHaveBeenCalledWith("/v1/transactions/55/document_user", {
      name: "upload.pdf",
      contents: b64,
    });
    const data = parseToolJson(result) as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toContain("upload.pdf");
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

  it("register_transaction distribution example does not hardcode a tenant dimension id", () => {
    const desc = tools.register_transaction.inputSchema.properties.distributions
      .description as string;
    expect(desc).toMatch(/list_account_dimensions/);
    expect(desc).not.toMatch(/12637323|6488057/);
    expect(desc).toMatch(/related_sub_id:456/);
  });

  it("propagates API errors from client", async () => {
    vi.mocked(client.get).mockRejectedValue(new Error("API Error 404: Not found"));

    await expect(tools.list_transactions.handler({})).rejects.toThrow("404");
  });

  it("update_transaction sets direction when RIK stores it", async () => {
    vi.mocked(client.patch).mockResolvedValue({
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 7, type: "C", date: "2026-10-01" } as never);
    listOutgoingDraft(7);

    const result = await tools.update_transaction.handler({ id: 7, type: "D" });

    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/7", { type: "C" });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
    });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
      type: "D",
    });
    expect(parseToolJson(result)).toMatchObject({
      success: true,
      type: "D",
      rik_messages: ["Outgoing payment has been saved."],
      direction_confirmed: true,
    });
  });

  it("update_transaction rejects a direction RIK does not store", async () => {
    vi.mocked(client.patch).mockResolvedValue({
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 7, type: "C", date: "2026-10-01" } as never);
    mockTransactionLists(client, [{ id: 7 }], [7]);

    await expect(tools.update_transaction.handler({ id: 7, type: "D" })).rejects.toThrow(
      "Transaction 7 was updated, but RIK still stores it as incoming, not type D (outgoing). RIK reported: Incoming payment has been saved.",
    );

    vi.mocked(client.patch).mockResolvedValue({} as never);
    vi.mocked(client.getAllPages).mockRejectedValue(new Error("HTTP 503"));
    const unconfirmed = parseToolJson(
      await tools.update_transaction.handler({ id: 7, type: "C" }),
    ) as { success: boolean; direction_confirmed: boolean };
    expect(unconfirmed.success).toBe(true);
    expect(unconfirmed.direction_confirmed).toBe(false);
  });

  it("update_transaction leaves the direction unconfirmed when the row is not listed", async () => {
    vi.mocked(client.patch).mockResolvedValue({} as never);
    vi.mocked(client.get).mockResolvedValue({ id: 7, type: "C", date: "2026-10-01" } as never);

    const missing = parseToolJson(await tools.update_transaction.handler({ id: 7, type: "D" })) as {
      success: boolean;
      direction_confirmed: boolean;
    };
    expect(missing.success).toBe(true);
    expect(missing.direction_confirmed).toBe(false);

    vi.mocked(client.getAllPages).mockClear();
    vi.mocked(client.get).mockResolvedValue({ id: 7, type: "C" } as never);
    const noDate = parseToolJson(await tools.update_transaction.handler({ id: 7, type: "C" })) as {
      direction_confirmed: boolean;
    };
    expect(noDate.direction_confirmed).toBe(false);
    expect(client.getAllPages).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice creates an outgoing payment and registers it", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1245",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 37.2,
        clients_id: 19,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      messages: ["Outgoing payment has been confirmed."],
    } as never);
    listOutgoingDraft(77);

    const result = await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 10,
      accounts_dimensions_id: 41442,
      date: "2026-10-01",
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({
        type: "C",
        amount: 37.2,
        clients_id: 19,
        description: "Ostuarve nr 1245 tasumine",
      }),
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/77/register", [
      { related_table: "purchase_invoices", related_id: 10, amount: 37.2 },
    ]);
    expect(parseToolJson(result)).toMatchObject({
      transaction_id: 77,
      type: "D",
      amount: 37.2,
      registered: true,
      direction_confirmed: true,
      payment_status: "PAID",
    });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      status: "PROJECT",
      clients_id: 19,
    });
  });

  it("pay_purchase_invoice keeps an unconfirmed draft without registering it", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1245",
        status: "CONFIRMED",
        payment_status: null,
        gross_price: 37.2,
        clients_id: 19,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 79, type: "C", status: "PROJECT" } as never);
    vi.mocked(client.post).mockResolvedValue({ id: 79, messages: ["Saved."] } as never);
    let transactionListsSeen = 0;
    routePaymentLists(() => {
      transactionListsSeen += 1;
      if (transactionListsSeen === 1) {
        return [];
      }
      throw new Error("HTTP 503");
    });

    const result = parseToolJson(
      await tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 41442,
        date: "2026-10-01",
      }),
    );

    expect(result).toMatchObject({
      registered: false,
      transaction_id: 79,
      type: "D",
      amount: 37.2,
      direction_confirmed: false,
      payment_status: "NOT_PAID",
      rik_messages: ["Saved."],
    });
    expect((result as { message: string }).message).toMatch(
      /draft 79 could not be confirmed as outgoing, so it was not registered against purchase invoice 10/,
    );
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice keeps a draft that is not in that day's lists", async () => {
    vi.mocked(client.get).mockResolvedValue({
      id: 10,
      number: "1245",
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 37.2,
      clients_id: 19,
      cl_currencies_id: "EUR",
    } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 81,
      messages: ["Outgoing payment has been saved."],
    } as never);
    routePaymentLists(() => []);

    const result = parseToolJson(
      await tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 41442,
        date: "2026-10-01",
      }),
    );

    expect(result).toMatchObject({
      registered: false,
      transaction_id: 81,
      direction_confirmed: false,
    });
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice refuses when the supplier has a matching draft", async () => {
    const invoice = {
      id: 10,
      number: "1245",
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 37.2,
      clients_id: 19,
      cl_currencies_id: "EUR",
    };
    vi.mocked(client.get).mockResolvedValueOnce(invoice as never);
    routePaymentLists(
      transactionLists(
        [
          {
            id: 70,
            status: "PROJECT",
            clients_id: 19,
            amount: 37.2,
            date: "2026-10-01",
            cl_currencies_id: "EUR",
            description: "Ostuarve nr 1245 tasumine",
          },
          { id: 71, status: "PROJECT", clients_id: 19, amount: 5, date: "2026-10-01" },
          {
            id: 72,
            status: "CONFIRMED",
            clients_id: 19,
            amount: 37.2,
            date: "2026-10-01",
            cl_currencies_id: "EUR",
            description: "Ostuarve nr 1245 tasumine",
          },
          {
            id: 73,
            status: "PROJECT",
            clients_id: 20,
            amount: 37.2,
            date: "2026-10-01",
            cl_currencies_id: "EUR",
            description: "Ostuarve nr 1245 tasumine",
          },
          { id: 74, status: "PROJECT", clients_id: 19, amount: "37.2", date: "2026-10-01" },
          {
            id: 75,
            status: "PROJECT",
            clients_id: 19,
            amount: 37.2,
            date: "2026-09-30",
            cl_currencies_id: "EUR",
            description: "Ostuarve nr 1245 tasumine",
          },
          {
            id: 76,
            status: "PROJECT",
            clients_id: 19,
            amount: 37.2,
            date: "2026-10-01",
            cl_currencies_id: "USD",
            description: "Ostuarve nr 1245 tasumine",
          },
          {
            id: 78,
            status: "PROJECT",
            clients_id: 19,
            amount: 37.2,
            date: "2026-10-01",
            cl_currencies_id: "EUR",
            description: "Ostuarve nr 1245 tasumine",
          },
        ],
        [78],
      ),
    );

    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 41442,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(
      "Possible duplicate payment for purchase invoice 10: transaction 70 matched as an outgoing PROJECT draft (PROJECT, 2026-10-01, 37.2; description contains invoice 1245). Register an existing draft with register_transaction, delete it with delete_transaction, or pass allow_duplicate=true to create another payment.",
    );
    expect(client.post).not.toHaveBeenCalled();

    vi.mocked(client.getAllPages).mockClear();
    vi.mocked(client.get)
      .mockResolvedValueOnce(invoice as never)
      .mockResolvedValueOnce({ id: 80, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 80,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(80);
    const paid = parseToolJson(
      await tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 41442,
        date: "2026-10-01",
        allow_duplicate: true,
      }),
    );
    expect(paid).toMatchObject({ transaction_id: 80, registered: true });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/account_dimensions");
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
    });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
      type: "D",
    });
    expect(client.getAllPages).not.toHaveBeenCalledWith("/v1/transactions", {
      status: "PROJECT",
      clients_id: 19,
    });
  });

  it("pay_purchase_invoice refuses a same-day confirmed payment of the invoice", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1245",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 37.2,
        clients_id: 19,
        cl_currencies_id: "EUR",
        transactions: [60, 61, 62],
      } as never)
      .mockResolvedValueOnce({
        id: 60,
        status: "CONFIRMED",
        date: "2026-10-02",
        amount: 5,
        cl_currencies_id: "EUR",
        description: "Ostuarve nr 1245 tasumine",
      } as never)
      .mockResolvedValueOnce({
        id: 61,
        status: "CONFIRMED",
        date: "2026-10-01",
        amount: 5,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({
        id: 62,
        status: "VOID",
        date: "2026-10-02",
        amount: 5,
        cl_currencies_id: "EUR",
      } as never);
    routePaymentLists(transactionLists([{ id: 60, date: "2026-10-02" }], []));

    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 41442,
        date: "2026-10-02",
        amount: 5,
      }),
    ).rejects.toThrow(
      /transaction 60 matched as an outgoing CONFIRMED payment \(CONFIRMED, 2026-10-02, 5; description contains invoice 1245\)/,
    );
    expect(client.get).toHaveBeenCalledWith("/v1/transactions/62");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice uses an explicit amount, description, and invoice_no", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 37.2,
        clients_id: 19,
        cl_currencies_id: "EUR",
        invoice_no: "F-9",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: null } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(77);

    const result = await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 10,
      accounts_dimensions_id: 1,
      date: "2026-10-02",
      amount: 5,
      description: "Paid from 1360",
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({
        amount: 5,
        cl_currencies_id: "EUR",
        description: "Paid from 1360",
      }),
    );
    expect(parseToolJson(result)).toMatchObject({ amount: 5, payment_status: null });
  });

  it("pay_purchase_invoice treats a blank payment status as unpaid and falls back to the id", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        status: "CONFIRMED",
        payment_status: "",
        gross_price: 4,
        clients_id: 3,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: "PARTIALLY_PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Väljaminev makse on salvestatud."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(77);

    await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 10,
      accounts_dimensions_id: 1,
      date: "2026-10-02",
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ description: "Ostuarve nr 10 tasumine", amount: 4 }),
    );
  });

  it("pay_purchase_invoice treats a null payment status as unpaid", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 11,
        status: "CONFIRMED",
        payment_status: null,
        gross_price: 8,
        clients_id: 3,
        cl_currencies_id: "EUR",
        number: "55",
      } as never)
      .mockResolvedValueOnce({ id: 78, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 11, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 78,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(78);

    await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 11,
      accounts_dimensions_id: 1,
      date: "2026-10-02",
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ amount: 8 }),
    );
  });

  it("pay_purchase_invoice rejects drafts, paid invoices, and missing amounts", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({ id: 10, status: "PROJECT" } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/only CONFIRMED/);

    vi.mocked(client.get).mockResolvedValueOnce({ id: 10, status: undefined } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/unknown/);

    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "PAID",
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/already paid/);

    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "PARTIALLY_PAID",
      gross_price: 10,
      clients_id: 1,
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/PARTIALLY_PAID/);

    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 10,
      clients_id: 1,
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
        amount: 0,
      }),
    ).rejects.toThrow(/greater than 0/);

    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: null,
      clients_id: 1,
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/no positive gross price/);

    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 0,
      clients_id: 1,
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/no positive gross price/);

    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 10,
      clients_id: 0,
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/no supplier/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice deletes the draft when register fails", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 3,
        clients_id: 4,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockRejectedValue(new Error("register no"));
    vi.mocked(client.delete).mockResolvedValue({} as never);
    listOutgoingDraft(77);

    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow("register no");
    expect(client.delete).toHaveBeenCalledWith("/v1/transactions/77");
  });

  it("pay_purchase_invoice reports a failed draft delete after a failed register", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 3,
        clients_id: 4,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockRejectedValue("register-string");
    vi.mocked(client.delete).mockRejectedValue(new Error("delete no"));
    listOutgoingDraft(77);

    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/register-string[\s\S]*delete no/);
  });

  it("pay_purchase_invoice still returns the transaction when the invoice re-read fails", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 3,
        clients_id: 4,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockRejectedValueOnce(new Error("read failed"));
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(77);

    const result = await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 10,
      accounts_dimensions_id: 1,
      date: "2026-10-01",
    });

    expect(parseToolJson(result)).toMatchObject({
      transaction_id: 77,
      registered: true,
      payment_status: null,
    });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice rejects an amount above the gross price", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "PARTIALLY_PAID",
      gross_price: 10,
      clients_id: 1,
      cl_currencies_id: "EUR",
    } as never);

    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
        amount: 11,
      }),
    ).rejects.toThrow(/gross price/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice sends a scaled base amount for a foreign-currency invoice", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "USD-1",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 100,
        base_gross_price: 90,
        currency_rate: 0.9,
        clients_id: 4,
        cl_currencies_id: "USD",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(77, "USD");

    await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 10,
      accounts_dimensions_id: 1,
      date: "2026-10-01",
      amount: 50,
    });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({
        cl_currencies_id: "USD",
        amount: 50,
        currency_rate: 0.9,
        base_amount: 45,
      }),
    );
  });

  it("pay_purchase_invoice requires a rate when a foreign invoice has none", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 10,
      clients_id: 1,
      cl_currencies_id: "USD",
    } as never);

    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/currency_rate is required/);

    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 10,
        clients_id: 1,
        cl_currencies_id: "USD",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(77, "USD");

    await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 10,
      accounts_dimensions_id: 1,
      date: "2026-10-01",
      currency_rate: 1.1,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ currency_rate: 1.1, base_amount: 11 }),
    );
  });

  it("pay_purchase_invoice rounds the posted amount and a foreign base amount", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1245",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 10.001,
        clients_id: 19,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(77);

    await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 10,
      accounts_dimensions_id: 1,
      date: "2026-10-01",
      amount: 10.004,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ amount: 10 }),
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/77/register", [
      { related_table: "purchase_invoices", related_id: 10, amount: 10 },
    ]);

    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 11,
        number: "USD-2",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 100,
        base_gross_price: 90,
        currency_rate: 0.9,
        clients_id: 4,
        cl_currencies_id: "USD",
      } as never)
      .mockResolvedValueOnce({ id: 78, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 11, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 78,
      messages: ["Outgoing payment has been saved."],
    } as never);
    listOutgoingDraft(78, "USD");

    await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 11,
      accounts_dimensions_id: 1,
      date: "2026-10-01",
      amount: 33.335,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ amount: 33.34, currency_rate: 0.9, base_amount: 30.01 }),
    );
  });

  it("pay_purchase_invoice allows an explicit amount when gross price is missing or zero", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: null,
        clients_id: 4,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    listOutgoingDraft(77);
    await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 10,
      accounts_dimensions_id: 1,
      date: "2026-10-01",
      amount: 3,
    });

    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 11,
        number: "2",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 0,
        clients_id: 4,
        cl_currencies_id: "EUR",
      } as never)
      .mockResolvedValueOnce({ id: 78, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 11, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 78,
      messages: ["Outgoing payment has been saved."],
    } as never);
    listOutgoingDraft(78);
    await tools.pay_purchase_invoice.handler({
      purchase_invoices_id: 11,
      accounts_dimensions_id: 1,
      date: "2026-10-01",
      amount: 3,
    });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ amount: 3 }),
    );
  });

  it("pay_purchase_invoice rejects an amount that rounds to zero", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 10,
      clients_id: 1,
      cl_currencies_id: "EUR",
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
        amount: 0.004,
      }),
    ).rejects.toThrow(/after rounding to 2 decimal places/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice refuses an invoice with no currency", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 4,
      clients_id: 3,
      cl_currencies_id: "  ",
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/has no currency/);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.getAllPages).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice refuses a dimension that is not cash or bank in the invoice currency", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      number: "1",
      status: "CONFIRMED",
      payment_status: "NOT_PAID",
      gross_price: 4,
      clients_id: 3,
      cl_currencies_id: "EUR",
    } as never);
    routePaymentLists(transactionLists([], []));
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 99,
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/accounts_dimensions_id 99 was not found/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice ignores an incoming same-day row linked to the invoice", async () => {
    vi.mocked(client.get)
      .mockResolvedValueOnce({
        id: 10,
        number: "1245",
        status: "CONFIRMED",
        payment_status: "NOT_PAID",
        gross_price: 37.2,
        clients_id: 19,
        cl_currencies_id: "EUR",
        transactions: [60],
      } as never)
      .mockResolvedValueOnce({
        id: 60,
        status: "CONFIRMED",
        date: "2026-10-01",
        amount: 37.2,
        cl_currencies_id: "EUR",
        description: "Ostuarve nr 1245 tasumine",
      } as never)
      .mockResolvedValueOnce({ id: 77, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 10, payment_status: "PAID" } as never);
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    routePaymentLists(transactionLists([{ id: 60 }, { id: 77 }], [60]));

    const result = parseToolJson(
      await tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 41442,
        date: "2026-10-01",
      }),
    );
    expect(result).toMatchObject({ transaction_id: 77, registered: true });
  });

  it("pay_purchase_invoice refuses a partly paid invoice when the remainder is unknown", async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "PARTIALLY_PAID",
      gross_price: 10,
      clients_id: 1,
      cl_currencies_id: "EUR",
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
        amount: 4,
      }),
    ).rejects.toThrow(/related settlements were not on the purchase invoice/);

    vi.mocked(client.get).mockResolvedValueOnce({
      id: 10,
      status: "CONFIRMED",
      payment_status: "PARTIALLY_PAID",
      gross_price: 10,
      clients_id: 1,
      cl_currencies_id: "EUR",
      settlements: [],
      transactions: [],
      paid_in_cash: false,
    } as never);
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
        amount: 4,
      }),
    ).rejects.toThrow(/no confirmed outgoing payment applied/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("pay_purchase_invoice caps a partly paid invoice at the readable remainder", async () => {
    const invoice = {
      id: 10,
      number: "1245",
      status: "CONFIRMED",
      payment_status: "PARTIALLY_PAID",
      gross_price: 10,
      clients_id: 19,
      cl_currencies_id: "EUR",
      settlements: [],
      paid_in_cash: false,
      transactions: [60],
    };
    const prior = {
      id: 60,
      status: "CONFIRMED",
      date: "2026-09-01",
      amount: 4,
      cl_currencies_id: "EUR",
      items: [
        {
          relation_table: "purchase_invoices",
          relation_id: 10,
          amount: 4,
          cl_currencies_id: "EUR",
        },
      ],
    };
    vi.mocked(client.get)
      .mockResolvedValueOnce(invoice as never)
      .mockResolvedValueOnce(prior as never);
    routePaymentLists(transactionLists([{ id: 60, date: "2026-09-01" }], []));
    await expect(
      tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
        amount: 7,
      }),
    ).rejects.toThrow(/unpaid remainder 6/);
    expect(client.post).not.toHaveBeenCalled();

    let invoiceReads = 0;
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/purchase_invoices/10") {
        invoiceReads += 1;
        return (
          invoiceReads === 1 ? invoice : { id: 10, payment_status: "PARTIALLY_PAID" }
        ) as never;
      }
      if (path === "/v1/transactions/60") {
        return prior as never;
      }
      if (path === "/v1/transactions/77") {
        return { id: 77, type: "C", status: "PROJECT" } as never;
      }
      throw new Error(path);
    });
    vi.mocked(client.post).mockResolvedValue({
      id: 77,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    routePaymentLists(transactionLists([{ id: 60, date: "2026-09-01" }, { id: 77 }], []));

    const result = parseToolJson(
      await tools.pay_purchase_invoice.handler({
        purchase_invoices_id: 10,
        accounts_dimensions_id: 1,
        date: "2026-10-01",
        amount: 6,
      }),
    );
    expect(result).toMatchObject({ transaction_id: 77, registered: true, amount: 6 });
    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ amount: 6 }),
    );
  });
});
