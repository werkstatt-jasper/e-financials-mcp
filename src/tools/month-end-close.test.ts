import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { JOURNAL_LIST_MAX_PAGES } from "../financial-statements/load-journals.js";
import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import type { Journal } from "../types/journal.js";
import type { Transaction } from "../types/transaction.js";
import { createMonthEndCloseTools, monthToDateRange } from "./month-end-close.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

function sale(
  overrides: Partial<SalesInvoice> & Pick<SalesInvoice, "id" | "status">,
): SalesInvoice {
  return {
    clients_id: 1,
    client_name: "Client",
    cl_currencies_id: "EUR",
    payment_status: "NOT_PAID",
    create_date: "2025-01-01",
    term_days: 0,
    gross_price: 100,
    number: `S${overrides.id}`,
    ...overrides,
  };
}

function purchase(
  overrides: Partial<PurchaseInvoice> & Pick<PurchaseInvoice, "id" | "status">,
): PurchaseInvoice {
  return {
    clients_id: 2,
    client_name: "Supplier",
    cl_currencies_id: "EUR",
    payment_status: "NOT_PAID",
    create_date: "2025-01-01",
    term_days: 0,
    gross_price: 50,
    number: `P${overrides.id}`,
    ...overrides,
  };
}

function journal(overrides: Partial<Journal> & Pick<Journal, "effective_date">): Journal {
  return {
    id: 1,
    registered: false,
    is_deleted: false,
    title: "Draft journal",
    postings: [],
    ...overrides,
  };
}

function tx(overrides: Partial<Transaction> & Pick<Transaction, "id" | "date">): Transaction {
  return {
    accounts_id: 1,
    accounts_dimensions_id: 1,
    clients_id: null,
    bank_accounts_id: 1,
    bank_ref_number: "",
    bank_subtype: "",
    type: "C",
    bank_account_no: null,
    bank_account_name: null,
    ref_number: null,
    amount: 10,
    cl_currencies_id: "EUR",
    description: "Bank tx",
    status: "PROJECT",
    is_deleted: false,
    currency_rate: 1,
    base_amount: 10,
    ...overrides,
  };
}

function mockChecklist(
  client: EFinancialsClient,
  data: {
    journals?: Journal[];
    transactions?: Transaction[];
    sales?: SalesInvoice[];
    purchases?: PurchaseInvoice[];
  },
) {
  const journals = data.journals ?? [];
  const transactions = data.transactions ?? [];
  const sales = data.sales ?? [];
  const purchases = data.purchases ?? [];

  vi.mocked(client.get).mockImplementation(async (path) => {
    if (path === "/v1/journals") {
      return { items: journals, current_page: 1, total_pages: 1 } as never;
    }
    throw new Error(`unexpected get ${path}`);
  });
  vi.mocked(client.getAllPages).mockImplementation(async (path) => {
    if (path === "/v1/transactions") {
      return transactions as never;
    }
    if (path === "/v1/sale_invoices") {
      return sales as never;
    }
    if (path === "/v1/purchase_invoices") {
      return purchases as never;
    }
    throw new Error(`unexpected getAllPages ${path}`);
  });
}

describe("monthToDateRange", () => {
  it("expands calendar months including February and leap years", () => {
    expect(monthToDateRange("2025-02")).toEqual({
      dateFrom: "2025-02-01",
      dateTo: "2025-02-28",
    });
    expect(monthToDateRange("2024-02")).toEqual({
      dateFrom: "2024-02-01",
      dateTo: "2024-02-29",
    });
    expect(monthToDateRange("2025-06")).toEqual({
      dateFrom: "2025-06-01",
      dateTo: "2025-06-30",
    });
  });
});

describe("month_end_close_checklist", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createMonthEndCloseTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createMonthEndCloseTools(client);
  });

  it("rejects missing or invalid month", async () => {
    await expect(tools.month_end_close_checklist.handler({})).rejects.toThrow(/month/);
    await expect(tools.month_end_close_checklist.handler({ month: "2025" })).rejects.toThrow(
      /YYYY-MM/,
    );
  });

  it("returns empty ready-to-close checklist for a clean month", async () => {
    mockChecklist(client, {});
    const result = await tools.month_end_close_checklist.handler({ month: "2025-06" });
    const data = parseToolJson(result) as {
      period: { from: string; to: string };
      summary: { issues_found: number; ready_to_close: boolean };
      unconfirmed_journals: { count: number };
      overdue_receivables: { count: number };
    };
    expect(data.period).toEqual({ from: "2025-06-01", to: "2025-06-30" });
    expect(data.summary).toEqual({ issues_found: 0, ready_to_close: true });
    expect(data.unconfirmed_journals.count).toBe(0);
    expect(data.overdue_receivables.count).toBe(0);
  });

  it("aggregates mixed-status blockers and overdue items", async () => {
    mockChecklist(client, {
      journals: [
        journal({ id: 10, effective_date: "2025-06-05", registered: false, title: "Open" }),
        journal({ id: 11, effective_date: "2025-06-06", registered: true }),
        journal({
          id: 12,
          effective_date: "2025-06-07",
          registered: false,
          is_deleted: true,
        }),
        journal({ id: 13, effective_date: "2025-05-01", registered: false }),
      ],
      transactions: [
        tx({ id: 20, date: "2025-06-10", description: "Open tx" }),
        tx({ id: 21, date: "2025-06-11", status: "CONFIRMED" }),
        tx({ id: 22, date: "2025-06-12", is_deleted: true }),
        tx({ id: 23, date: "2025-05-01" }),
      ],
      sales: [
        sale({
          id: 30,
          status: "PROJECT",
          journal_date: "2025-06-15",
          gross_price: 80,
        }),
        sale({
          id: 31,
          status: "CONFIRMED",
          journal_date: "2025-06-15",
          create_date: "2025-05-01",
          term_days: 0,
          gross_price: 200,
        }), // overdue vs 2025-06-30
        sale({
          id: 32,
          status: "CONFIRMED",
          create_date: "2025-06-30",
          term_days: 0,
          gross_price: 15,
        }), // due on month-end → not overdue
        sale({
          id: 33,
          status: "VOID",
          journal_date: "2025-06-01",
          gross_price: 9,
        }),
        sale({
          id: 34,
          status: "PROJECT",
          journal_date: "2025-05-01",
          gross_price: 9,
        }),
        sale({
          id: 35,
          status: "CONFIRMED",
          payment_status: "PAID",
          create_date: "2025-01-01",
          gross_price: 9,
        }),
      ],
      purchases: [
        purchase({
          id: 40,
          status: "PROJECT",
          journal_date: "2025-06-20",
          gross_price: 40,
        }),
        purchase({
          id: 41,
          status: "CONFIRMED",
          create_date: "2025-04-01",
          term_days: 0,
          payment_status: "PARTIALLY_PAID",
          gross_price: 60,
        }),
      ],
    });

    const result = await tools.month_end_close_checklist.handler({ month: "2025-06" });
    const data = parseToolJson(result) as {
      unconfirmed_journals: { count: number; items: Array<{ id: number }> };
      unconfirmed_transactions: { count: number; items: Array<{ id: number }> };
      unconfirmed_sale_invoices: { count: number; items: Array<{ id: number }> };
      unconfirmed_purchase_invoices: { count: number; items: Array<{ id: number }> };
      overdue_receivables: { count: number; total: number; items: Array<{ id: number }> };
      overdue_payables: { count: number; total: number };
      summary: { issues_found: number; ready_to_close: boolean };
      warnings: string[];
    };

    expect(data.unconfirmed_journals.count).toBe(1);
    expect(data.unconfirmed_journals.items[0]?.id).toBe(10);
    expect(data.unconfirmed_transactions.count).toBe(1);
    expect(data.unconfirmed_transactions.items[0]?.id).toBe(20);
    expect(data.unconfirmed_sale_invoices.count).toBe(1);
    expect(data.unconfirmed_sale_invoices.items[0]?.id).toBe(30);
    expect(data.unconfirmed_purchase_invoices.count).toBe(1);
    expect(data.unconfirmed_purchase_invoices.items[0]?.id).toBe(40);

    expect(data.overdue_receivables.count).toBe(1);
    expect(data.overdue_receivables.total).toBe(200);
    expect(data.overdue_receivables.items[0]?.id).toBe(31);
    expect(data.overdue_payables.count).toBe(1);
    expect(data.overdue_payables.total).toBe(60);

    // 4 unconfirmed + 2 overdue
    expect(data.summary.issues_found).toBe(6);
    expect(data.summary.ready_to_close).toBe(false);
    expect(data.warnings.some((w) => w.includes("PARTIALLY_PAID"))).toBe(true);
  });

  it("allows ready_to_close when only overdue issues remain", async () => {
    mockChecklist(client, {
      sales: [
        sale({
          id: 1,
          status: "CONFIRMED",
          create_date: "2025-01-01",
          term_days: 0,
          gross_price: 100,
        }),
      ],
    });
    const result = await tools.month_end_close_checklist.handler({ month: "2025-06" });
    const data = parseToolJson(result) as {
      summary: { issues_found: number; ready_to_close: boolean };
      overdue_receivables: { count: number };
    };
    expect(data.overdue_receivables.count).toBe(1);
    expect(data.summary.ready_to_close).toBe(true);
    expect(data.summary.issues_found).toBe(1);
  });

  it("caps overdue item samples at 10 while preserving full count", async () => {
    const sales = Array.from({ length: 12 }, (_, i) =>
      sale({
        id: i + 1,
        status: "CONFIRMED",
        create_date: "2025-01-01",
        term_days: 0,
        gross_price: i + 1,
        clients_id: i + 1,
      }),
    );
    mockChecklist(client, { sales });
    const result = await tools.month_end_close_checklist.handler({ month: "2025-06" });
    const data = parseToolJson(result) as {
      overdue_receivables: { count: number; items: unknown[] };
    };
    expect(data.overdue_receivables.count).toBe(12);
    expect(data.overdue_receivables.items).toHaveLength(10);
  });

  it("passes date filters to journal and transaction fetches", async () => {
    mockChecklist(client, {});
    await tools.month_end_close_checklist.handler({ month: "2025-02" });
    expect(client.get).toHaveBeenCalledWith(
      "/v1/journals",
      expect.objectContaining({
        start_date: "2025-02-01",
        end_date: "2025-02-28",
        page: 1,
      }),
    );
    expect(client.getAllPages).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({
        status: "PROJECT",
        start_date: "2025-02-01",
        end_date: "2025-02-28",
      }),
    );
  });

  it("returns structured error when journal list is truncated", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue([] as never);
    let page = 0;
    vi.mocked(client.get).mockImplementation(async (path) => {
      if (path === "/v1/journals") {
        page += 1;
        return {
          items: [journal({ id: page, effective_date: "2025-06-01" })],
          current_page: page,
          total_pages: JOURNAL_LIST_MAX_PAGES + 1,
        } as never;
      }
      throw new Error(`unexpected get ${path}`);
    });

    const result = await tools.month_end_close_checklist.handler({ month: "2025-06" });
    const data = parseToolJson(result) as { error: string; month: string };
    expect(data.error).toBe("journal_list_truncated");
    expect(data.month).toBe("2025-06");
  });

  it("rethrows unexpected errors", async () => {
    vi.mocked(client.getAllPages).mockRejectedValue(new Error("boom"));
    vi.mocked(client.get).mockResolvedValue({
      items: [],
      current_page: 1,
      total_pages: 1,
    } as never);
    await expect(tools.month_end_close_checklist.handler({ month: "2025-06" })).rejects.toThrow(
      "boom",
    );
  });

  it("handles invoices with missing journal_date and null optional fields", async () => {
    mockChecklist(client, {
      journals: [journal({ id: undefined, effective_date: "2025-06-01", title: undefined })],
      sales: [
        sale({
          id: 1,
          status: "PROJECT",
          journal_date: null,
          number: null,
          client_name: undefined as unknown as string,
          payment_status: null,
          gross_price: null,
          base_gross_price: null,
        }),
        sale({
          id: 5,
          status: "PROJECT",
          journal_date: "2025-06-10",
          number: null,
          client_name: undefined as unknown as string,
          payment_status: null,
          gross_price: 12,
        }),
      ],
      purchases: [
        purchase({
          id: 2,
          status: "PROJECT",
          journal_date: "",
          payment_status: null,
        }),
      ],
      transactions: [
        tx({
          id: 3,
          date: "2025-06-01",
          description: undefined as unknown as string,
          base_amount: undefined as unknown as number,
          amount: 7,
        }),
      ],
    });
    const result = await tools.month_end_close_checklist.handler({ month: "2025-06" });
    const data = parseToolJson(result) as {
      unconfirmed_journals: { items: Array<{ id: null; title: null }> };
      unconfirmed_sale_invoices: {
        count: number;
        items: Array<{ number: null; client: null; payment_status: string }>;
      };
      unconfirmed_purchase_invoices: { count: number };
      unconfirmed_transactions: { items: Array<{ amount: number; description: null }> };
    };
    expect(data.unconfirmed_journals.items[0]?.id).toBeNull();
    expect(data.unconfirmed_journals.items[0]?.title).toBeNull();
    expect(data.unconfirmed_sale_invoices.count).toBe(1);
    expect(data.unconfirmed_sale_invoices.items[0]).toMatchObject({
      number: null,
      client: null,
      payment_status: "NOT_PAID",
    });
    expect(data.unconfirmed_purchase_invoices.count).toBe(0);
    expect(data.unconfirmed_transactions.items[0]?.amount).toBe(7);
    expect(data.unconfirmed_transactions.items[0]?.description).toBeNull();
  });
});
