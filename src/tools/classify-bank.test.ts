import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createClassifyBankTools } from "./classify-bank.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: test JSON payloads vary by mode
function parsed(result: { content: Array<{ type: string; text: string }> }): any {
  return parseToolJson(result);
}

function projectTx(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    accounts_id: 100,
    accounts_dimensions_id: 10,
    clients_id: 20,
    bank_accounts_id: 1,
    bank_ref_number: "",
    bank_subtype: "",
    type: "D",
    bank_account_no: null,
    bank_account_name: "Notion Labs",
    ref_number: null,
    amount: 10,
    cl_currencies_id: "EUR",
    description: "Subscription",
    date: "2025-06-01",
    status: "PROJECT",
    is_deleted: false,
    currency_rate: 1,
    base_amount: 10,
    ...overrides,
  };
}

describe("classify_bank_transactions", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createClassifyBankTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createClassifyBankTools(client);
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({ id: 1 }),
          projectTx({ id: 2, amount: 10, date: "2025-05-01" }),
          projectTx({
            id: 3,
            type: "C",
            amount: 100,
            bank_account_name: "Buyer Co",
            ref_number: "R1",
            clients_id: 7,
          }),
          projectTx({
            id: 4,
            bank_account_name: "Swedbank",
            description: "Monthly bank fee",
            amount: 3,
            clients_id: 99,
          }),
          projectTx({
            id: 5,
            bank_account_name: "EMTA",
            description: "Tax payment",
            amount: 200,
          }),
          projectTx({ id: 99, status: "CONFIRMED", is_deleted: false }),
          projectTx({ id: 98, is_deleted: true }),
        ];
      }
      if (path === "/v1/sale_invoices") {
        return [
          {
            id: 90,
            clients_id: 7,
            client_name: "Buyer Co",
            gross_price: 100,
            bank_ref_number: "R1",
            status: "CONFIRMED",
            payment_status: "NOT_PAID",
            cl_currencies_id: "EUR",
          },
        ];
      }
      if (path === "/v1/purchase_invoices") {
        return [
          {
            id: 50,
            clients_id: 20,
            client_name: "Notion Labs",
            status: "CONFIRMED",
            payment_status: "PAID",
            cl_currencies_id: "EUR",
            create_date: "2025-04-01",
            gross_price: 10,
            vat_price: 0,
            items: [
              {
                cl_purchase_articles_id: 23,
                purchase_accounts_dimensions_id: 6488057,
                vat_rate_dropdown: "0",
              },
            ],
          },
        ];
      }
      return [];
    });
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      const id = Number(path.split("/").pop());
      if (id === 1 || id === 2 || id === 4) {
        return projectTx({ id });
      }
      if (id === 10) {
        return projectTx({ id: 10, status: "CONFIRMED" });
      }
      if (id === 11) {
        return projectTx({
          id: 11,
          cl_currencies_id: "USD",
          currency_rate: null,
          amount: 15,
        });
      }
      if (id === 12) {
        return projectTx({ id: 12 });
      }
      throw new Error(`missing ${path}`);
    });
    vi.mocked(client.post).mockResolvedValue({ id: 500 } as never);
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
  });

  it("classifies unmatched groups and excludes strong invoice matches", async () => {
    const result = parsed(await tools.classify_bank_transactions.handler({}));
    expect(result.mode).toBe("classify");
    expect(result.summary.excluded_invoice_matches).toBe(1);
    const groups = result.groups as Array<{
      counterparty: string;
      category: string;
      apply_mode: string;
    }>;
    const notion = groups.find((g) => g.counterparty === "notion labs");
    expect(notion?.category).toBe("saas_subscriptions");
    expect(notion?.apply_mode).toBe("purchase_invoice");
    const tax = groups.find((g) => g.counterparty === "emta");
    expect(tax?.apply_mode).toBe("review_only");
    const fee = groups.find((g) => g.counterparty === "swedbank");
    expect(fee?.category).toBe("bank_fees");
    expect(fee?.apply_mode).toBe("purchase_invoice");
  });

  it("filters by accounts_dimensions_id and dates", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({ id: 1, accounts_dimensions_id: 10 }),
          projectTx({ id: 2, accounts_dimensions_id: 99, bank_account_name: "Other Dim" }),
        ];
      }
      return [];
    });
    const result = parsed(
      await tools.classify_bank_transactions.handler({
        accounts_dimensions_id: 10,
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      }),
    );
    expect(client.getAllPages).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({
        status: "PROJECT",
        start_date: "2025-01-01",
        end_date: "2025-12-31",
      }),
    );
    const ids = (result.groups as Array<{ transaction_ids: number[] }>).flatMap(
      (g) => g.transaction_ids,
    );
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });

  it("dry_run_apply does not mutate", async () => {
    const result = parsed(
      await tools.classify_bank_transactions.handler({ mode: "dry_run_apply" }),
    );
    expect(result.mode).toBe("DRY_RUN");
    expect(result.summary.would_book).toBeGreaterThan(0);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("dry_run_apply with provided review_only groups skips booking", async () => {
    const result = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "dry_run_apply",
        groups: [
          {
            counterparty: "EMTA",
            apply_mode: "review_only",
            transaction_ids: [5],
          },
          {
            counterparty: "Broken",
            apply_mode: "purchase_invoice",
            transaction_ids: [1],
            suggested_booking: { clients_id: 1 },
          },
          {
            counterparty: "NoIds",
            apply_mode: "purchase_invoice",
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
            },
          },
        ],
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "review_only" }),
        expect.objectContaining({ reason: "missing_booking_fields" }),
      ]),
    );
    expect(result.summary.would_book).toBe(0);
  });

  it("execute_apply books purchase invoices and registers transactions", async () => {
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions/1") {
        return projectTx({ id: 1, clients_id: null, description: "" });
      }
      throw new Error(`missing ${path}`);
    });
    const result = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            counterparty: "notion labs",
            category: "saas_subscriptions",
            apply_mode: "purchase_invoice",
            transaction_ids: [1],
            suggested_booking: {
              clients_id: 20,
              client_name: "Notion Labs",
              purchase_article_id: 23,
              purchase_accounts_dimensions_id: 6488057,
              vat_rate: 0,
              vat_amount: 0,
            },
          },
        ],
      }),
    );
    expect(result.mode).toBe("EXECUTED");
    expect(result.summary.booked).toBe(1);
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({ clients_id: 20 }),
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/1", {
      clients_id: 20,
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/500/register");
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/transactions/1/register",
      expect.arrayContaining([
        expect.objectContaining({
          related_table: "purchase_invoices",
          related_id: 500,
        }),
      ]),
    );
  });

  it("execute_apply skips stale, currency without rate, and fetch failures", async () => {
    const result = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            transaction_ids: [10, 11, 999],
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
              vat_rate: 0,
              vat_amount: 0,
            },
          },
        ],
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "stale_or_confirmed" }),
        expect.objectContaining({ reason: "currency_rate_required" }),
        expect.objectContaining({ reason: "fetch_failed" }),
      ]),
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("execute_apply invalidates PI when txn goes stale after create", async () => {
    let getCount = 0;
    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions/12") {
        getCount += 1;
        if (getCount === 1) {
          return projectTx({ id: 12, clients_id: null });
        }
        return projectTx({ id: 12, status: "CONFIRMED" });
      }
      throw new Error("nope");
    });

    const result = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            counterparty: "X",
            transaction_ids: [12],
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
              vat_rate: 0,
              vat_amount: 0,
            },
          },
        ],
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "stale_after_invoice_create" })]),
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/500/invalidate");
  });

  it("execute_apply invalidates PI when txn is deleted after create", async () => {
    let getCount = 0;
    vi.mocked(client.get).mockImplementation(async () => {
      getCount += 1;
      if (getCount === 1) {
        return projectTx({ id: 13 });
      }
      return projectTx({ id: 13, is_deleted: true });
    });
    const result = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            counterparty: "FromGroup",
            category: "card_purchases",
            transaction_ids: [13],
            suggested_booking: {
              clients_id: 20,
              purchase_article_id: 23,
              vat_rate: 24,
              vat_amount: 2,
              vat_accounts_id: 5,
            },
          },
        ],
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "stale_after_invoice_create" })]),
    );
    expect(client.post).toHaveBeenCalledWith(
      "/v1/purchase_invoices",
      expect.objectContaining({
        client_name: "FromGroup",
        items: expect.arrayContaining([expect.objectContaining({ cl_vat_articles_id: 1 })]),
      }),
    );
  });

  it("execute_apply reports apply_failed and attempts invalidate", async () => {
    vi.mocked(client.post).mockRejectedValueOnce(new Error("boom"));
    const result = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            transaction_ids: [1],
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
              vat_rate: 0,
              vat_amount: 0,
            },
          },
        ],
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "apply_failed" })]),
    );
  });

  it("execute_apply cleans up when register fails after create", async () => {
    vi.mocked(client.patch).mockImplementation(async (path: string) => {
      if (path.includes("/register") && path.includes("purchase")) {
        return { response_code: 0 } as never;
      }
      if (path.includes("/transactions/1/register")) {
        throw new Error("register boom");
      }
      return { response_code: 0 } as never;
    });
    const result = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            transaction_ids: [1],
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
              vat_rate: 24,
              vat_amount: 2,
              vat_accounts_id: 5,
            },
          },
        ],
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "apply_failed" })]),
    );
    expect(client.patch).toHaveBeenCalledWith("/v1/purchase_invoices/500/invalidate");
  });

  it("covers not_project status branch", async () => {
    vi.mocked(client.get).mockImplementation(async () => {
      return { ...projectTx({ id: 77 }), status: "DRAFT" } as never;
    });

    const result = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            transaction_ids: [77],
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
              vat_rate: 0,
              vat_amount: 0,
            },
          },
        ],
      }),
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "not_project" })]),
    );
  });

  it("covers VOID skip and invalidate cleanup failure", async () => {
    vi.mocked(client.get).mockResolvedValueOnce(projectTx({ id: 1, status: "VOID" }) as never);
    const r1 = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            transaction_ids: [1],
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
              vat_rate: 0,
              vat_amount: 0,
            },
          },
        ],
      }),
    );
    expect(r1.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "stale_or_confirmed" })]),
    );

    vi.mocked(client.get).mockImplementation(async () => projectTx({ id: 1 }) as never);
    vi.mocked(client.post).mockResolvedValueOnce({ id: 501 } as never);
    vi.mocked(client.patch).mockImplementation(async (path: string) => {
      if (path.includes("purchase_invoices/501/register")) {
        return {} as never;
      }
      if (path.includes("transactions/1/register")) {
        throw new Error("fail");
      }
      if (path.includes("invalidate")) {
        throw new Error("invalidate fail");
      }
      return {} as never;
    });
    const r2 = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            transaction_ids: [1],
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
              vat_rate: 0,
              vat_amount: 0,
            },
          },
        ],
      }),
    );
    expect(r2.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "apply_failed" })]),
    );
  });

  it("covers description/client fallbacks, dissimilar amounts, and currency_rate 0", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 1,
            bank_account_name: "Mixed Amounts",
            amount: 10,
            clients_id: null,
          }),
          projectTx({
            id: 2,
            bank_account_name: "Mixed Amounts",
            amount: 100,
            clients_id: null,
            date: "2025-05-01",
          }),
          projectTx({
            id: 3,
            bank_account_name: "Swedbank",
            description: "kuutasu",
            amount: 2,
            clients_id: null,
          }),
        ];
      }
      return [];
    });
    const classified = parsed(await tools.classify_bank_transactions.handler({}));
    const mixed = (
      classified.groups as Array<{ counterparty: string; similar_amounts: boolean }>
    ).find((g) => g.counterparty === "mixed amounts");
    expect(mixed?.similar_amounts).toBe(false);

    vi.mocked(client.get).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions/1") {
        return projectTx({
          id: 1,
          description: "   ",
          cl_currencies_id: "",
          clients_id: 20,
        });
      }
      if (path === "/v1/transactions/8") {
        return projectTx({
          id: 8,
          cl_currencies_id: "USD",
          currency_rate: 0,
        });
      }
      throw new Error("missing");
    });

    const dry = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "dry_run_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            transaction_ids: [1],
            suggested_booking: {
              clients_id: 20,
              purchase_article_id: 23,
            },
          },
        ],
      }),
    );
    expect(
      (dry.results as Array<{ purchase_invoice: { client_name: string } }>)[0].purchase_invoice
        .client_name,
    ).toBe("Supplier");

    const cur = parsed(
      await tools.classify_bank_transactions.handler({
        mode: "execute_apply",
        groups: [
          {
            apply_mode: "purchase_invoice",
            transaction_ids: [8],
            suggested_booking: {
              clients_id: 20,
              client_name: "X",
              purchase_article_id: 23,
              vat_rate: 0,
              vat_amount: 0,
            },
          },
        ],
      }),
    );
    expect(cur.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "currency_rate_required" })]),
    );
  });

  it("saas without history becomes review_only", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 1,
            bank_account_name: "Unknown SaaS",
            clients_id: null,
            amount: 15,
          }),
          projectTx({
            id: 2,
            bank_account_name: "Unknown SaaS",
            clients_id: null,
            amount: 15,
            date: "2025-05-01",
          }),
        ];
      }
      if (path === "/v1/sale_invoices" || path === "/v1/purchase_invoices") {
        return [];
      }
      return [];
    });
    const result = parsed(await tools.classify_bank_transactions.handler({}));
    const g = (result.groups as Array<{ apply_mode: string; category: string }>)[0];
    expect(g.category).toBe("saas_subscriptions");
    expect(g.apply_mode).toBe("review_only");
  });
});
