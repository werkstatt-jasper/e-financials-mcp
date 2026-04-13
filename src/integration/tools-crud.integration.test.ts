/**
 * Integration tests for write (CRUD) MCP tool handlers against the RIK demo API.
 * Each describe block creates entities, exercises the full lifecycle, then cleans up.
 *
 * Run: `npm run test:integration`
 */
import "dotenv/config";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAuthConfig } from "../auth.js";
import { EFinancialsClient } from "../client.js";
import { buildAllTools, type ToolRecord } from "../server-setup.js";

type ToolResult = { content: Array<{ type: string; text: string }> };

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/**
 * The RIK API returns `created_object_id` on POST success.
 * Some tool handlers wrap the response as `{ success, id, response }`;
 * others return the raw API response directly.
 */
function extractCreatedId(data: Record<string, unknown>): number {
  if (typeof data.created_object_id === "number") return data.created_object_id;
  if (typeof data.id === "number") return data.id;
  const nested = data.response as Record<string, unknown> | undefined;
  if (nested && typeof nested.created_object_id === "number") return nested.created_object_id;
  if (nested && typeof nested.id === "number") return nested.id;
  throw new Error(`Cannot extract created ID from: ${JSON.stringify(data).slice(0, 200)}`);
}

const TEST_PREFIX = "INTTEST";
const timestamp = Date.now();

describe("CRUD tool handlers (integration)", () => {
  let tools: ToolRecord;

  beforeAll(() => {
    const config = loadAuthConfig();
    const silentLogger = pino({ level: "silent" });
    const client = new EFinancialsClient(config, { logger: silentLogger });
    tools = buildAllTools(client);
  });

  // ── Client CRUD ────────────────────────────────────────────────────

  describe("client lifecycle", () => {
    let clientId: number;

    afterAll(async () => {
      if (!clientId) return;
      try {
        await tools.reactivate_client.handler({ id: clientId });
      } catch {
        /* may already be active */
      }
      try {
        await tools.delete_client.handler({ id: clientId });
      } catch {
        /* best-effort cleanup */
      }
    });

    it("create -> get -> update -> deactivate -> reactivate -> delete", async () => {
      const createResult = await tools.create_client.handler({
        name: `${TEST_PREFIX} Client ${timestamp}`,
        reg_code: `${timestamp}`.slice(-8),
        is_buyer: true,
        country_code: "FI",
      });
      const createData = parse(createResult);
      expect(createData.success).toBe(true);
      clientId = extractCreatedId(createData);
      expect(clientId).toBeGreaterThan(0);

      const getResult = await tools.get_client.handler({ id: clientId });
      const getClient = parse(getResult);
      expect(getClient.id).toBe(clientId);

      const updateResult = await tools.update_client.handler({
        id: clientId,
        email: "integration-test@example.com",
      });
      expect(parse(updateResult)).toBeDefined();

      const deactivateResult = await tools.deactivate_client.handler({ id: clientId });
      expect(parse(deactivateResult)).toBeDefined();

      const reactivateResult = await tools.reactivate_client.handler({ id: clientId });
      expect(parse(reactivateResult)).toBeDefined();

      const deleteResult = await tools.delete_client.handler({ id: clientId });
      expect(parse(deleteResult)).toBeDefined();
      clientId = 0;
    });
  });

  // ── Product CRUD ───────────────────────────────────────────────────

  describe("product lifecycle", () => {
    let productId: number;

    afterAll(async () => {
      if (!productId) return;
      try {
        await tools.reactivate_product.handler({ products_id: productId });
      } catch {
        /* may already be active */
      }
      try {
        await tools.delete_product.handler({ products_id: productId });
      } catch {
        /* best-effort cleanup */
      }
    });

    it("create -> get -> update -> deactivate -> reactivate -> delete", async () => {
      // Find a sale article that doesn't require a dimension (dimensions__id is null)
      const articlesResult = await tools.list_sale_articles.handler({});
      const articles = JSON.parse((articlesResult as ToolResult).content[0].text) as Array<{
        id: number;
        dimensions__id: number | null;
      }>;
      const noDimArticle = articles.find((a) => a.dimensions__id === null);
      expect(noDimArticle).toBeDefined();

      const createResult = await tools.create_product.handler({
        name: `${TEST_PREFIX} Product ${timestamp}`,
        code: `TST${timestamp}`.slice(0, 20),
        cl_sale_articles_id: noDimArticle?.id,
      });
      const createData = parse(createResult);
      productId = extractCreatedId(createData);
      expect(productId).toBeGreaterThan(0);

      const getResult = await tools.get_product.handler({ products_id: productId });
      const product = parse(getResult);
      expect(product.id).toBe(productId);

      const updateResult = await tools.update_product.handler({
        products_id: productId,
        name: `${TEST_PREFIX} Product Updated`,
        cl_sale_articles_id: noDimArticle?.id,
      });
      expect(parse(updateResult)).toBeDefined();

      const deactivateResult = await tools.deactivate_product.handler({ products_id: productId });
      expect(parse(deactivateResult)).toBeDefined();

      const reactivateResult = await tools.reactivate_product.handler({ products_id: productId });
      expect(parse(reactivateResult)).toBeDefined();

      const deleteResult = await tools.delete_product.handler({ products_id: productId });
      expect(parse(deleteResult)).toBeDefined();
      productId = 0;
    });
  });

  // ── Invoice Series CRUD ────────────────────────────────────────────

  describe("invoice series lifecycle", () => {
    let seriesId: number;

    afterAll(async () => {
      if (!seriesId) return;
      try {
        await tools.delete_invoice_series.handler({ invoice_series_id: seriesId });
      } catch {
        /* best-effort */
      }
    });

    it("create -> get -> update -> delete", async () => {
      const createResult = await tools.create_invoice_series.handler({
        is_active: true,
        is_default: false,
        number_prefix: `T${timestamp}`.slice(0, 10),
        number_start_value: 1,
        term_days: 14,
      });
      const createData = parse(createResult);
      seriesId = extractCreatedId(createData);
      expect(seriesId).toBeGreaterThan(0);

      const getResult = await tools.get_invoice_series.handler({ invoice_series_id: seriesId });
      const series = parse(getResult);
      expect(series.id).toBe(seriesId);

      const updateResult = await tools.update_invoice_series.handler({
        invoice_series_id: seriesId,
        term_days: 30,
      });
      expect(parse(updateResult)).toBeDefined();

      const deleteResult = await tools.delete_invoice_series.handler({
        invoice_series_id: seriesId,
      });
      expect(parse(deleteResult)).toBeDefined();
      seriesId = 0;
    });
  });

  // ── Bank Account CRUD ──────────────────────────────────────────────

  describe("bank account lifecycle", () => {
    let bankAccountId: number;

    afterAll(async () => {
      if (!bankAccountId) return;
      try {
        await tools.delete_bank_account.handler({ bank_accounts_id: bankAccountId });
      } catch {
        /* best-effort */
      }
    });

    it("create -> get -> update -> delete", async () => {
      // Discover a valid cl_banks_id from existing bank accounts
      const existingBanks = await tools.get_bank_accounts.handler({});
      const bankList = JSON.parse((existingBanks as ToolResult).content[0].text) as Array<{
        cl_banks_id?: number;
      }>;
      const clBanksId = bankList.find((b) => b.cl_banks_id)?.cl_banks_id;

      const createResult = await tools.create_bank_account.handler({
        account_name_est: `${TEST_PREFIX} Pangakonto ${timestamp}`,
        account_no: `EE${timestamp}`.slice(0, 20),
        iban_code: `EE00TEST${timestamp}`.slice(0, 20),
        swift_code: "TSTBEE2X",
        default_salary_account: false,
        show_in_sale_invoices: false,
        ...(clBanksId ? { cl_banks_id: clBanksId } : {}),
      });
      const createData = parse(createResult);
      bankAccountId = extractCreatedId(createData);
      expect(bankAccountId).toBeGreaterThan(0);

      const getResult = await tools.get_bank_account.handler({
        bank_accounts_id: bankAccountId,
      });
      const account = parse(getResult);
      expect(account.id).toBe(bankAccountId);

      const updateResult = await tools.update_bank_account.handler({
        bank_accounts_id: bankAccountId,
        account_name_eng: `${TEST_PREFIX} Bank Account`,
      });
      expect(parse(updateResult)).toBeDefined();

      const deleteResult = await tools.delete_bank_account.handler({
        bank_accounts_id: bankAccountId,
      });
      expect(parse(deleteResult)).toBeDefined();
      bankAccountId = 0;
    });
  });

  // ── Sales Invoice Lifecycle ────────────────────────────────────────

  describe("sales invoice lifecycle", () => {
    let invoiceId = 0;
    let testClientId = 0;

    beforeAll(async () => {
      const createResult = await tools.create_client.handler({
        name: `${TEST_PREFIX} Invoice Client ${timestamp}`,
        reg_code: `${timestamp}`.slice(-8),
        is_buyer: true,
        country_code: "FI",
      });
      testClientId = extractCreatedId(parse(createResult));
    });

    afterAll(async () => {
      if (invoiceId) {
        try {
          await tools.invalidate_sales_invoice.handler({ id: invoiceId });
        } catch {
          /* may not be registered */
        }
        try {
          await tools.delete_sales_invoice.handler({ id: invoiceId });
        } catch {
          /* best-effort */
        }
      }
      if (testClientId) {
        try {
          await tools.delete_client.handler({ id: testClientId });
        } catch {
          /* best-effort */
        }
      }
    });

    it("create draft -> get -> update -> delete", async () => {
      const createResult = await tools.create_sales_invoice.handler({
        clients_id: testClientId,
        invoice_date: "2025-06-15",
        due_date: "2025-06-30",
        rows: [{ description: "Test service", quantity: 1, unit_price: 100 }],
      });
      const createData = parse(createResult);
      invoiceId = extractCreatedId(createData);
      expect(invoiceId).toBeGreaterThan(0);

      const getResult = await tools.get_sales_invoice.handler({ id: invoiceId });
      const invoice = parse(getResult) as Record<string, unknown>;
      expect(invoice.clients_id).toBe(testClientId);

      const updateResult = await tools.update_sales_invoice.handler({
        id: invoiceId,
        description: "Updated notes",
      });
      const updateData = parse(updateResult);
      expect(updateData).toBeDefined();

      await tools.delete_sales_invoice.handler({ id: invoiceId });
      invoiceId = 0;
    });
  });

  // ── Purchase Invoice Lifecycle ─────────────────────────────────────

  describe("purchase invoice lifecycle", () => {
    let invoiceId: number;
    let testClientId: number;

    beforeAll(async () => {
      const createResult = await tools.create_client.handler({
        name: `${TEST_PREFIX} Supplier ${timestamp}`,
        reg_code: `${timestamp + 1}`.slice(-8),
        is_supplier: true,
        country_code: "FI",
      });
      testClientId = extractCreatedId(parse(createResult));
    });

    afterAll(async () => {
      if (invoiceId) {
        try {
          await tools.invalidate_purchase_invoice.handler({ id: invoiceId });
        } catch {
          /* may not be registered */
        }
        try {
          await tools.delete_purchase_invoice.handler({ id: invoiceId });
        } catch {
          /* best-effort */
        }
      }
      if (testClientId) {
        try {
          await tools.delete_client.handler({ id: testClientId });
        } catch {
          /* best-effort */
        }
      }
    });

    it("create draft -> get -> update -> register -> invalidate -> delete", async () => {
      const createResult = await tools.create_purchase_invoice.handler({
        clients_id: testClientId,
        client_name: `${TEST_PREFIX} Supplier ${timestamp}`,
        invoice_no: `PI-${timestamp}`,
        invoice_date: "2025-06-15",
        total_amount: 100.0,
      });
      const createData = parse(createResult);
      expect(createData.success).toBe(true);
      invoiceId = extractCreatedId(createData);
      expect(invoiceId).toBeGreaterThan(0);

      const getResult = await tools.get_purchase_invoice.handler({ id: invoiceId });
      expect(parse(getResult).id).toBe(invoiceId);

      const updateResult = await tools.update_purchase_invoice.handler({
        id: invoiceId,
        description: "Updated by integration test",
      });
      expect(parse(updateResult).success).toBe(true);

      const registerResult = await tools.register_purchase_invoice.handler({ id: invoiceId });
      expect(parse(registerResult)).toBeDefined();

      const invalidateResult = await tools.invalidate_purchase_invoice.handler({ id: invoiceId });
      expect(parse(invalidateResult)).toBeDefined();

      const deleteResult = await tools.delete_purchase_invoice.handler({ id: invoiceId });
      expect(parse(deleteResult)).toBeDefined();
      invoiceId = 0;
    });
  });

  // ── Journal Lifecycle ──────────────────────────────────────────────

  describe("journal lifecycle", () => {
    let journalId: number;

    afterAll(async () => {
      if (!journalId) return;
      try {
        await tools.invalidate_journal.handler({ journals_id: journalId });
      } catch {
        /* may not be registered */
      }
      try {
        await tools.delete_journal.handler({ journals_id: journalId });
      } catch {
        /* best-effort */
      }
    });

    it("create -> get -> update -> register -> invalidate -> delete", async () => {
      const dimResult = await tools.list_account_dimensions.handler({});
      const dimData = parse(dimResult) as {
        dimensions: Array<{ id: number; accounts_id: number }>;
      };
      expect(dimData.dimensions.length).toBeGreaterThanOrEqual(2);

      // Pick two dimensions with different accounts_id
      const seen = new Set<number>();
      const picks: Array<{ id: number; accounts_id: number }> = [];
      for (const d of dimData.dimensions) {
        if (!seen.has(d.accounts_id)) {
          seen.add(d.accounts_id);
          picks.push(d);
        }
        if (picks.length >= 2) break;
      }
      expect(picks.length).toBeGreaterThanOrEqual(2);

      const createResult = await tools.create_journal.handler({
        effective_date: "2025-06-15",
        title: `${TEST_PREFIX} Journal ${timestamp}`,
        postings: [
          {
            journals_id: 0,
            accounts_id: picks[0].accounts_id,
            accounts_dimensions_id: picks[0].id,
            type: "D",
            amount: 50.0,
            cl_currencies_id: "EUR",
          },
          {
            journals_id: 0,
            accounts_id: picks[1].accounts_id,
            accounts_dimensions_id: picks[1].id,
            type: "C",
            amount: 50.0,
            cl_currencies_id: "EUR",
          },
        ],
      });
      const createData = parse(createResult);
      journalId = extractCreatedId(createData);
      expect(journalId).toBeGreaterThan(0);

      const getResult = await tools.get_journal.handler({ journals_id: journalId });
      expect(parse(getResult).id).toBe(journalId);

      const updateResult = await tools.update_journal.handler({
        journals_id: journalId,
        title: `${TEST_PREFIX} Journal Updated`,
      });
      expect(parse(updateResult)).toBeDefined();

      const registerResult = await tools.register_journal.handler({ journals_id: journalId });
      expect(parse(registerResult)).toBeDefined();

      const invalidateResult = await tools.invalidate_journal.handler({ journals_id: journalId });
      expect(parse(invalidateResult)).toBeDefined();

      const deleteResult = await tools.delete_journal.handler({ journals_id: journalId });
      expect(parse(deleteResult)).toBeDefined();
      journalId = 0;
    });
  });

  // ── Transaction Lifecycle ──────────────────────────────────────────

  describe("transaction lifecycle", () => {
    let transactionId: number;

    afterAll(async () => {
      if (!transactionId) return;
      try {
        await tools.invalidate_transaction.handler({ id: transactionId });
      } catch {
        /* may not be registered */
      }
      try {
        await tools.delete_transaction.handler({ id: transactionId });
      } catch {
        /* best-effort */
      }
    });

    it("create draft -> get -> update -> delete", async () => {
      const dimResult = await tools.list_account_dimensions.handler({});
      const dimData = parse(dimResult) as { dimensions: Array<{ id: number }> };
      expect(dimData.dimensions.length).toBeGreaterThan(0);

      const createResult = await tools.create_transaction.handler({
        accounts_dimensions_id: dimData.dimensions[0].id,
        type: "D",
        amount: 25.5,
        cl_currencies_id: "EUR",
        date: "2025-06-15",
        description: `${TEST_PREFIX} Transaction ${timestamp}`,
      });
      const createData = parse(createResult);
      transactionId = extractCreatedId(createData);
      expect(transactionId).toBeGreaterThan(0);

      const getResult = await tools.get_transaction.handler({ id: transactionId });
      expect(parse(getResult).id).toBe(transactionId);

      const updateResult = await tools.update_transaction.handler({
        id: transactionId,
        description: `${TEST_PREFIX} Updated`,
      });
      expect(parse(updateResult).success).toBe(true);

      const deleteResult = await tools.delete_transaction.handler({ id: transactionId });
      expect(parse(deleteResult)).toBeDefined();
      transactionId = 0;
    });
  });
});
