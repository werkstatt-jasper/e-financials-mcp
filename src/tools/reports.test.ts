import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import clientsFixture from "../__fixtures__/clients.json" with { type: "json" };
import invoicesFixture from "../__fixtures__/invoices.json" with { type: "json" };
import transactionsFixture from "../__fixtures__/transactions.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import { createReportTools } from "./reports.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

describe("report tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createReportTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createReportTools(client);
  });

  it("reconciliation_report aggregates three GET responses", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return {
          items: [
            ...transactionsFixture.reconciliation_list.items,
            {
              id: 2,
              type: "D",
              amount: 25,
              status: "CONFIRMED",
              clients_id: 1,
              date: "2025-06-02",
              description: "Out",
            },
          ],
        } as never;
      }
      if (path === "/v1/sale_invoices") {
        return { ...invoicesFixture.reconciliation_sales_list } as never;
      }
      if (path === "/v1/purchase_invoices") {
        return { ...invoicesFixture.reconciliation_purchase_list } as never;
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await tools.reconciliation_report.handler({
      start_date: "2025-06-01",
      end_date: "2025-06-30",
    });

    expect(client.get).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ start_date: "2025-06-01", end_date: "2025-06-30" }),
    );
    expect(client.get).toHaveBeenCalledWith(
      "/v1/sale_invoices",
      expect.objectContaining({ start_date: "2025-06-01", end_date: "2025-06-30" }),
    );
    expect(client.get).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({ start_date: "2025-06-01", end_date: "2025-06-30" }),
    );

    const data = parseToolJson(result) as {
      transactions: { total: number; credits: { total: number }; debits: { total: number } };
      invoices: { sales: { unpaid: number }; purchase: { unpaid: number } };
    };
    expect(data.transactions.total).toBe(2);
    expect(data.transactions.credits.total).toBe(100);
    expect(data.transactions.debits.total).toBe(25);
    expect(data.invoices.sales.unpaid).toBe(1);
    expect(data.invoices.purchase.unpaid).toBe(0);
  });

  it("reconciliation_report coalesces null items arrays from API", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return { items: null } as never;
      }
      if (path === "/v1/sale_invoices") {
        return { items: null } as never;
      }
      if (path === "/v1/purchase_invoices") {
        return { items: null } as never;
      }
      throw new Error(path);
    });
    const result = await tools.reconciliation_report.handler({});
    const data = parseToolJson(result) as { transactions: { total: number } };
    expect(data.transactions.total).toBe(0);
  });

  it("reconciliation_report includes unpaid purchase action items", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return { items: [] } as never;
      }
      if (path === "/v1/sale_invoices") {
        return { items: [] } as never;
      }
      if (path === "/v1/purchase_invoices") {
        return { ...invoicesFixture.reconciliation_purchase_unpaid } as never;
      }
      throw new Error(path);
    });

    const result = await tools.reconciliation_report.handler({});
    const data = parseToolJson(result) as {
      action_items: { invoices_to_pay: { invoice_no: string }[] };
    };
    expect(data.action_items.invoices_to_pay).toHaveLength(1);
    expect(data.action_items.invoices_to_pay[0].invoice_no).toBe("P2");
  });

  it("financial_summary tolerates responses without items arrays", async () => {
    vi.mocked(client.get).mockResolvedValue({} as never);
    const result = await tools.financial_summary.handler({ month: "2025-01" });
    const data = parseToolJson(result) as {
      bank_transactions: { transaction_count: number };
      invoices: { sales_invoice_count: number };
    };
    expect(data.bank_transactions.transaction_count).toBe(0);
    expect(data.invoices.sales_invoice_count).toBe(0);
  });

  it("financial_summary uses month param for date range", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...transactionsFixture.list_empty } as never);

    await tools.financial_summary.handler({ month: "2024-03" });

    const txCall = vi.mocked(client.get).mock.calls.find((c) => c[0] === "/v1/transactions");
    expect(txCall).toBeDefined();
    const params = txCall?.[1] as { start_date: string; end_date: string };
    expect(params.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.start_date <= params.end_date).toBe(true);

    expect(client.get).toHaveBeenCalledWith("/v1/sale_invoices", params);
    expect(client.get).toHaveBeenCalledWith("/v1/purchase_invoices", params);
  });

  it("financial_summary sums gross_price from live API items and never emits null", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return { items: [] } as never;
      }
      if (path === "/v1/sale_invoices") {
        // Live API items: gross_price, no total_amount / invoice_date
        return {
          items: [
            { id: 1, gross_price: 100.5 },
            { id: 2, gross_price: null, total_amount: 25 },
            { id: 3 },
          ],
        } as never;
      }
      if (path === "/v1/purchase_invoices") {
        return {
          items: [
            { id: 4, gross_price: 10, journal_date: "2025-06-05" },
            { id: 5, gross_price: 5, create_date: "2025-06-06" },
            { id: 6, gross_price: 7 },
            { id: 7, gross_price: 999, journal_date: "2024-01-01" },
          ],
        } as never;
      }
      throw new Error(path);
    });

    const result = await tools.financial_summary.handler({ month: "2025-06" });
    const data = parseToolJson(result) as {
      period: { from: string; to: string };
      invoices: {
        sales_invoiced: number;
        purchases_invoiced: number;
        sales_invoice_count: number;
      };
    };
    // UTC month window regardless of process timezone
    expect(data.period.from).toBe("2025-06-01");
    expect(data.period.to).toBe("2025-06-30");
    expect(data.invoices.sales_invoiced).toBe(125.5);
    expect(data.invoices.sales_invoice_count).toBe(3);
    // journal_date/create_date in range or no date at all count; 2024 item is excluded
    expect(data.invoices.purchases_invoiced).toBe(22);
  });

  it("reconciliation_report maps live API fields into action items", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return { items: [] } as never;
      }
      if (path === "/v1/sale_invoices") {
        return {
          items: [
            {
              id: 1,
              payment_status: "NOT_PAID",
              number: "5",
              client_name: "Acme",
              gross_price: 60,
              create_date: "2025-06-01",
              term_days: 14,
            },
            { id: 3, payment_status: "NOT_PAID", client_name: "NoDates", gross_price: 5 },
          ],
        } as never;
      }
      if (path === "/v1/purchase_invoices") {
        return {
          items: [
            {
              id: 2,
              payment_status: "NOT_PAID",
              number: "P9",
              client_name: "Supplier OÜ",
              gross_price: 40,
              create_date: "2025-06-01",
            },
          ],
        } as never;
      }
      throw new Error(path);
    });

    const result = await tools.reconciliation_report.handler({});
    const data = parseToolJson(result) as {
      invoices: { sales: { unpaid_amount: number }; purchase: { unpaid_amount: number } };
      action_items: {
        invoices_to_collect: {
          invoice_no?: string;
          amount: number;
          due_date?: string;
        }[];
        invoices_to_pay: { invoice_no?: string; supplier?: string; due_date?: string }[];
      };
    };
    expect(data.invoices.sales.unpaid_amount).toBe(65);
    expect(data.invoices.purchase.unpaid_amount).toBe(40);
    expect(data.action_items.invoices_to_collect[0]).toMatchObject({
      invoice_no: "5",
      amount: 60,
      due_date: "2025-06-15",
    });
    // No dates at all: due_date omitted
    expect(data.action_items.invoices_to_collect[1].due_date).toBeUndefined();
    // Purchase invoices use client_name for the supplier; no term_days -> no due_date
    expect(data.action_items.invoices_to_pay[0].supplier).toBe("Supplier OÜ");
    expect(data.action_items.invoices_to_pay[0].due_date).toBeUndefined();
  });

  it("match_transaction_to_supplier loads description from transaction_id", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions/99") {
        return { ...transactionsFixture.txn_for_match } as never;
      }
      if (path === "/v1/clients") {
        return { ...clientsFixture.supplier_list_match } as never;
      }
      throw new Error(path);
    });

    const result = await tools.match_transaction_to_supplier.handler({ transaction_id: 99 });
    const data = parseToolJson(result) as { transaction_id: number; description: string };
    expect(data.transaction_id).toBe(99);
    expect(data.description).toBe("payment acme office");
  });

  it("match_transaction_to_supplier uses no-match note when nothing scores", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [{ id: 1, name: "Qwerty Corp" }],
    } as never);

    const result = await tools.match_transaction_to_supplier.handler({
      description: "zzzz no overlap",
    });
    const data = parseToolJson(result) as { note: string };
    expect(data.note).toContain("No matching suppliers");
  });

  it("match_transaction_to_supplier treats missing supplier list as empty", async () => {
    vi.mocked(client.get).mockResolvedValue({} as never);
    const result = await tools.match_transaction_to_supplier.handler({ description: "any text" });
    const data = parseToolJson(result) as { suggested_suppliers: unknown[] };
    expect(data.suggested_suppliers).toEqual([]);
  });

  it("financial_summary defaults to current month and aggregates totals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return { ...transactionsFixture.summary_txns } as never;
      }
      if (path === "/v1/sale_invoices") {
        return { ...invoicesFixture.summary_sales } as never;
      }
      if (path === "/v1/purchase_invoices") {
        return { ...invoicesFixture.summary_purchases } as never;
      }
      throw new Error(path);
    });

    const result = await tools.financial_summary.handler({});
    const data = parseToolJson(result) as {
      period: { month: string };
      bank_transactions: { income: number; expenses: number; unprocessed: number };
      invoices: { purchases_invoiced: number };
    };
    expect(data.period.month).toBe("2025-06");
    expect(data.bank_transactions.income).toBe(100);
    expect(data.bank_transactions.expenses).toBe(40);
    expect(data.bank_transactions.unprocessed).toBe(1);
    expect(data.invoices.purchases_invoiced).toBe(10);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("match_transaction_to_supplier ranks suppliers using description only", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...clientsFixture.supplier_list_match } as never);

    const result = await tools.match_transaction_to_supplier.handler({
      description: "Payment to acme office",
    });

    expect(client.get).toHaveBeenCalledWith("/v1/clients", { is_supplier: true });
    const data = parseToolJson(result) as {
      suggested_suppliers: { id: number; match_score: number }[];
    };
    expect(data.suggested_suppliers.length).toBeGreaterThan(0);
    expect(data.suggested_suppliers[0].id).toBe(1);
  });

  it("match_transaction_to_supplier sorts by match score descending", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [
        { id: 1, name: "Zeta acme extra words" },
        { id: 2, name: "acme" },
      ],
    } as never);

    const result = await tools.match_transaction_to_supplier.handler({
      description: "payment acme extra",
    });
    const data = parseToolJson(result) as {
      suggested_suppliers: { id: number; match_score: number }[];
    };
    expect(data.suggested_suppliers[0].match_score).toBeGreaterThanOrEqual(
      data.suggested_suppliers[1].match_score,
    );
  });

  it("match_transaction_to_supplier returns error when id and description missing", async () => {
    const result = await tools.match_transaction_to_supplier.handler({});

    expect(client.get).not.toHaveBeenCalled();
    const data = parseToolJson(result) as { error: string };
    expect(data.error).toContain("transaction_id or description");
  });

  it("propagates API errors from client", async () => {
    vi.mocked(client.get).mockRejectedValue(new Error("API Error 502: Bad gateway"));

    await expect(tools.reconciliation_report.handler({ start_date: "2025-01-01" })).rejects.toThrow(
      "502",
    );
  });
});
