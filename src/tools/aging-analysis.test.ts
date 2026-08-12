import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import type { PurchaseInvoice, SalesInvoice } from "../types/invoice.js";
import { createAgingAnalysisTools } from "./aging-analysis.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

const sales: SalesInvoice[] = [
  {
    id: 1,
    number: "S1",
    clients_id: 10,
    client_name: "Debtor",
    create_date: "2025-01-01",
    term_days: 0,
    gross_price: 100,
    base_gross_price: 100,
    cl_currencies_id: "EUR",
    status: "CONFIRMED",
    payment_status: "NOT_PAID",
  },
  {
    id: 2,
    number: "S2",
    clients_id: 10,
    client_name: "Debtor",
    create_date: "2025-03-01",
    term_days: 0,
    gross_price: 50,
    cl_currencies_id: "EUR",
    status: "CONFIRMED",
    payment_status: "PAID",
  },
];

const purchases: PurchaseInvoice[] = [
  {
    id: 20,
    number: "P1",
    clients_id: 30,
    client_name: "Supplier",
    create_date: "2025-02-01",
    term_days: 14,
    gross_price: 200,
    cl_currencies_id: "EUR",
    status: "CONFIRMED",
    payment_status: "PARTIALLY_PAID",
  },
];

describe("aging analysis tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createAgingAnalysisTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createAgingAnalysisTools(client);
  });

  it("compute_receivables_aging returns top_debtors", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(sales as never);
    const result = await tools.compute_receivables_aging.handler({
      as_of_date: "2025-04-01",
    });
    const data = parseToolJson(result) as {
      total_invoices: number;
      top_debtors: Array<{ clients_id: number; total: number }>;
      aging_buckets: Array<{ label: string }>;
    };
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/sale_invoices");
    expect(data.total_invoices).toBe(1);
    expect(data.top_debtors[0]?.clients_id).toBe(10);
    expect(data.top_debtors[0]?.total).toBe(100);
    expect(data.aging_buckets.length).toBeGreaterThan(0);
  });

  it("compute_payables_aging returns top_creditors and unmatched key", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(purchases as never);
    const result = await tools.compute_payables_aging.handler({
      as_of_date: "2025-04-01",
    });
    const data = parseToolJson(result) as {
      total_invoices: number;
      partially_paid_count: number;
      top_creditors: Array<{ clients_id: number }>;
      warnings: string[];
    };
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/purchase_invoices");
    expect(data.total_invoices).toBe(1);
    expect(data.partially_paid_count).toBe(1);
    expect(data.top_creditors[0]?.clients_id).toBe(30);
    expect(data.warnings.some((w) => w.includes("PARTIALLY_PAID"))).toBe(true);
  });

  it("defaults as_of_date when omitted for receivables and payables", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue([] as never);
    const recv = parseToolJson(await tools.compute_receivables_aging.handler({})) as {
      as_of_date: string;
    };
    const pay = parseToolJson(await tools.compute_payables_aging.handler({})) as {
      as_of_date: string;
    };
    expect(recv.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pay.as_of_date).toBe(recv.as_of_date);
  });

  it("rejects invalid as_of_date", async () => {
    await expect(
      tools.compute_receivables_aging.handler({ as_of_date: "not-a-date" }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("includes unmatched_supplier_invoices when clients_id null", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue([
      {
        ...purchases[0],
        clients_id: null as unknown as number,
      },
    ] as never);
    const result = await tools.compute_payables_aging.handler({ as_of_date: "2025-04-01" });
    const data = parseToolJson(result) as {
      unmatched_supplier_invoices: { count: number };
    };
    expect(data.unmatched_supplier_invoices.count).toBe(1);
  });
});
