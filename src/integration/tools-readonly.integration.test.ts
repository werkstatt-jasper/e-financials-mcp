/**
 * Integration tests for all read-only MCP tool handlers against the RIK demo API.
 * Exercises list/get/search tools across every module through the actual handler functions.
 *
 * Issue #40: VAT-related demo coverage uses `get_vat_info` (`/v1/vat_info`); there is no
 * separate `list_vat_rates` MCP tool. Sales-invoice lifecycle integration lives in
 * `tools-crud.integration.test.ts`.
 *
 * Run: `npm run test:integration`
 */
import "dotenv/config";

import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAuthConfig } from "../auth.js";
import { EFinancialsClient } from "../client.js";
import { buildAllTools, type ToolRecord } from "../server-setup.js";

type ToolResult = { content: Array<{ type: string; text: string }> };

function parse(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("read-only tool handlers (integration)", () => {
  let tools: ToolRecord;

  beforeAll(() => {
    const config = loadAuthConfig();
    const silentLogger = pino({ level: "silent" });
    const client = new EFinancialsClient(config, { logger: silentLogger });
    tools = buildAllTools(client);
  });

  // ── Reference ──────────────────────────────────────────────────────

  describe("reference", () => {
    it("list_currencies returns an array", async () => {
      const result = await tools.list_currencies.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });

    it("list_sale_articles returns an array", async () => {
      const result = await tools.list_sale_articles.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });

    it("list_templates returns an array", async () => {
      const result = await tools.list_templates.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });
  });

  // ── Accounts ───────────────────────────────────────────────────────

  describe("accounts", () => {
    it("list_accounts returns an array", async () => {
      const result = await tools.list_accounts.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });

    it("get_bank_accounts returns an array", async () => {
      const result = await tools.get_bank_accounts.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });

    it("get_vat_info returns object", async () => {
      const result = await tools.get_vat_info.handler({});
      const data = parse(result);
      expect(data).toBeDefined();
      expect(typeof data === "object").toBe(true);
    });

    it("list_projects returns an array", async () => {
      const result = await tools.list_projects.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });

    it("search_accounts finds results for a broad query", async () => {
      const result = await tools.search_accounts.handler({ query: "kassa" });
      const data = parse(result) as { query: string; count: number; accounts: unknown[] };
      expect(data.query).toBe("kassa");
      expect(typeof data.count).toBe("number");
      expect(Array.isArray(data.accounts)).toBe(true);
    });

    it("list_account_dimensions returns structured response", async () => {
      const result = await tools.list_account_dimensions.handler({});
      const data = parse(result) as { filter: string; count: number; dimensions: unknown[] };
      expect(data.filter).toBe("none");
      expect(typeof data.count).toBe("number");
      expect(Array.isArray(data.dimensions)).toBe(true);
    });

    it("list_purchase_articles returns an array", async () => {
      const result = await tools.list_purchase_articles.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });
  });

  // ── Clients ────────────────────────────────────────────────────────

  describe("clients", () => {
    it("list_clients returns paginated response", async () => {
      const result = await tools.list_clients.handler({});
      const data = parse(result) as {
        items: unknown[];
        current_page: number;
        total_pages: number;
      };
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.current_page).toBeGreaterThanOrEqual(1);
      expect(data.total_pages).toBeGreaterThanOrEqual(1);
    });

    it("list_suppliers returns an array", async () => {
      const result = await tools.list_suppliers.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });

    it("get_client returns a client when given a valid ID", async () => {
      const listResult = await tools.list_clients.handler({});
      const listData = parse(listResult) as { items: Array<{ id: number }> };
      if (listData.items.length === 0) return; // skip if no clients in demo

      const firstId = listData.items[0].id;
      const result = await tools.get_client.handler({ id: firstId });
      const client = parse(result) as { id: number };
      expect(client.id).toBe(firstId);
    });

    it("search_clients returns structured results", async () => {
      const result = await tools.search_clients.handler({ query: "test" });
      const data = parse(result) as { query: string; count: number; clients: unknown[] };
      expect(data.query).toBe("test");
      expect(typeof data.count).toBe("number");
      expect(Array.isArray(data.clients)).toBe(true);
    });
  });

  // ── Products ───────────────────────────────────────────────────────

  describe("products", () => {
    it("list_products returns paginated response", async () => {
      const result = await tools.list_products.handler({});
      const data = parse(result) as {
        items: unknown[];
        current_page: number;
        total_pages: number;
      };
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.current_page).toBeGreaterThanOrEqual(1);
    });

    it("get_product returns a product when given a valid ID", async () => {
      const listResult = await tools.list_products.handler({});
      const listData = parse(listResult) as { items: Array<{ id: number }> };
      if (listData.items.length === 0) return;

      const firstId = listData.items[0].id;
      const result = await tools.get_product.handler({ products_id: firstId });
      const product = parse(result) as { id: number };
      expect(product.id).toBe(firstId);
    });
  });

  // ── Transactions ───────────────────────────────────────────────────

  describe("transactions", () => {
    it("list_transactions returns paginated response", async () => {
      const result = await tools.list_transactions.handler({});
      const data = parse(result) as {
        items: unknown[];
        current_page: number;
        total_pages: number;
      };
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.current_page).toBeGreaterThanOrEqual(1);
    });

    it("get_transaction returns a transaction when given a valid ID", async () => {
      const listResult = await tools.list_transactions.handler({});
      const listData = parse(listResult) as { items: Array<{ id: number }> };
      if (listData.items.length === 0) return;

      const firstId = listData.items[0].id;
      const result = await tools.get_transaction.handler({ id: firstId });
      const txn = parse(result) as { id: number };
      expect(txn.id).toBe(firstId);
    });

    it("get_unprocessed_transactions returns structured response", async () => {
      const result = await tools.get_unprocessed_transactions.handler({});
      const data = parse(result) as { count: number; transactions: unknown[] };
      expect(typeof data.count).toBe("number");
      expect(Array.isArray(data.transactions)).toBe(true);
    });
  });

  // ── Invoices ───────────────────────────────────────────────────────

  describe("invoices", () => {
    it("list_sales_invoices returns paginated response", async () => {
      const result = await tools.list_sales_invoices.handler({});
      const data = parse(result) as {
        items: unknown[];
        current_page: number;
        total_pages: number;
      };
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.current_page).toBeGreaterThanOrEqual(1);
    });

    it("list_purchase_invoices returns paginated response", async () => {
      const result = await tools.list_purchase_invoices.handler({});
      const data = parse(result) as {
        items: unknown[];
        current_page: number;
        total_pages: number;
      };
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.current_page).toBeGreaterThanOrEqual(1);
    });

    it("list_unpaid_invoices returns categorized response", async () => {
      const result = await tools.list_unpaid_invoices.handler({});
      const data = parse(result) as {
        sales_invoices?: unknown[];
        purchase_invoices?: unknown[];
      };
      expect(data).toBeDefined();
    });

    it("get_sales_invoice returns an invoice when given a valid ID", async () => {
      const listResult = await tools.list_sales_invoices.handler({});
      const listData = parse(listResult) as { items: Array<{ id: number }> };
      if (listData.items.length === 0) return;

      const firstId = listData.items[0].id;
      const result = await tools.get_sales_invoice.handler({ id: firstId });
      const invoice = parse(result) as { id: number };
      expect(invoice.id).toBe(firstId);
    });

    it("get_purchase_invoice returns an invoice when given a valid ID", async () => {
      const listResult = await tools.list_purchase_invoices.handler({});
      const listData = parse(listResult) as { items: Array<{ id: number }> };
      if (listData.items.length === 0) return;

      const firstId = listData.items[0].id;
      const result = await tools.get_purchase_invoice.handler({ id: firstId });
      const invoice = parse(result) as { id: number };
      expect(invoice.id).toBe(firstId);
    });

    it("get_sales_invoice_delivery_options returns data for a valid invoice", async () => {
      const listResult = await tools.list_sales_invoices.handler({
        status: "CONFIRMED",
      });
      const listData = parse(listResult) as { items: Array<{ id: number }> };
      if (listData.items.length === 0) return;

      const firstId = listData.items[0].id;
      const result = await tools.get_sales_invoice_delivery_options.handler({
        id: firstId,
      });
      const data = parse(result);
      expect(data).toBeDefined();
    });
  });

  // ── Invoice Settings ───────────────────────────────────────────────

  describe("invoice settings", () => {
    it("get_invoice_info returns company invoice settings", async () => {
      const result = await tools.get_invoice_info.handler({});
      const data = parse(result);
      expect(data).toBeDefined();
      expect(typeof data === "object").toBe(true);
    });

    it("list_invoice_series returns an array", async () => {
      const result = await tools.list_invoice_series.handler({});
      const items = parse(result);
      expect(Array.isArray(items)).toBe(true);
    });

    it("get_invoice_series returns a series when given a valid ID", async () => {
      const listResult = await tools.list_invoice_series.handler({});
      const items = parse(listResult) as Array<{ id: number }>;
      if (items.length === 0) return;

      const firstId = items[0].id;
      const result = await tools.get_invoice_series.handler({
        invoice_series_id: firstId,
      });
      const series = parse(result) as { id: number };
      expect(series.id).toBe(firstId);
    });
  });

  // ── Journals ───────────────────────────────────────────────────────

  describe("journals", () => {
    it("list_journals returns paginated response", async () => {
      const result = await tools.list_journals.handler({});
      const data = parse(result) as {
        items: unknown[];
        current_page: number;
        total_pages: number;
      };
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.current_page).toBeGreaterThanOrEqual(1);
    });

    it("get_journal returns a journal when given a valid ID", async () => {
      const listResult = await tools.list_journals.handler({});
      const listData = parse(listResult) as { items: Array<{ id: number }> };
      if (listData.items.length === 0) return;

      const firstId = listData.items[0].id;
      const result = await tools.get_journal.handler({ journals_id: firstId });
      const journal = parse(result) as { id: number };
      expect(journal.id).toBe(firstId);
    });
  });

  // ── Reports ────────────────────────────────────────────────────────

  describe("reports", () => {
    it("reconciliation_report returns structured report", async () => {
      const result = await tools.reconciliation_report.handler({
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      });
      const data = parse(result) as {
        period: { from: string; to: string };
        transactions: { total: number };
        invoices: object;
        action_items: object;
      };
      expect(data.period.from).toBe("2025-01-01");
      expect(data.period.to).toBe("2025-12-31");
      expect(typeof data.transactions.total).toBe("number");
      expect(data.invoices).toBeDefined();
      expect(data.action_items).toBeDefined();
    });

    it("financial_summary returns structured summary", async () => {
      const result = await tools.financial_summary.handler({ month: "2025-06" });
      const data = parse(result) as {
        period: { month: string };
        bank_transactions: { income: number; expenses: number };
        invoices: object;
      };
      expect(data.period.month).toBe("2025-06");
      expect(typeof data.bank_transactions.income).toBe("number");
      expect(typeof data.bank_transactions.expenses).toBe("number");
      expect(data.invoices).toBeDefined();
    });

    it("match_transaction_to_supplier returns suggestions", async () => {
      const result = await tools.match_transaction_to_supplier.handler({
        description: "Office supplies purchase",
      });
      const data = parse(result) as {
        description: string;
        suggested_suppliers: unknown[];
      };
      expect(data.description).toBe("Office supplies purchase");
      expect(Array.isArray(data.suggested_suppliers)).toBe(true);
    });
  });
});
