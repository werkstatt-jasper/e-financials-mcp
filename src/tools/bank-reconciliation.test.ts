import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createBankReconciliationTools } from "./bank-reconciliation.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

function projectTx(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    accounts_id: 100,
    accounts_dimensions_id: 10,
    clients_id: null,
    bank_accounts_id: 1,
    bank_ref_number: "",
    bank_subtype: "",
    type: "C",
    bank_account_no: null,
    bank_account_name: null,
    ref_number: null,
    amount: 100,
    cl_currencies_id: "EUR",
    description: "",
    date: "2025-06-01",
    status: "PROJECT",
    is_deleted: false,
    currency_rate: 1,
    base_amount: 100,
    ...overrides,
  };
}

describe("bank reconciliation tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createBankReconciliationTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createBankReconciliationTools(client);
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 1,
            type: "C",
            amount: 100,
            ref_number: "R1",
            bank_account_name: "Buyer Co",
          }),
          projectTx({
            id: 2,
            type: "D",
            amount: 5,
            description: "Monthly bank fee",
            accounts_dimensions_id: 10,
          }),
          projectTx({
            id: 3,
            type: "D",
            amount: 50,
            bank_account_no: "EE22",
            accounts_dimensions_id: 10,
          }),
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
        return [];
      }
      if (path === "/v1/bank_accounts") {
        return [
          { account_name_est: "Main", account_no: "1", iban_code: "EE11" },
          { account_name_est: "Other", account_no: "2", iban_code: "EE22" },
        ];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      if (path === "/v1/journals") {
        return [];
      }
      if (path === "/v1/clients") {
        return [{ id: 1, name: "Demo Company" }];
      }
      return [];
    });
    vi.mocked(client.get).mockResolvedValue({ company_name: "Demo Company" } as never);
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);
  });

  it("handles invoice_info failure and filters deleted/non-project rows", async () => {
    vi.mocked(client.get).mockRejectedValue(new Error("no info"));
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({ id: 1, type: "C", amount: 1, is_deleted: true }),
          projectTx({ id: 2, type: "C", amount: 1, status: "CONFIRMED" }),
          projectTx({ id: 3, type: "C", amount: 1, accounts_dimensions_id: 99 }),
          projectTx({
            id: 4,
            type: "C",
            amount: 9,
            bank_account_name: "payment from Demo Company OÜ",
          }),
        ];
      }
      return [];
    });
    const data = parseToolJson(
      await tools.analyze_unconfirmed_transactions.handler({ accounts_dimensions_id: 10 }),
    ) as { total_unconfirmed: number; suggestions: Array<{ suggested_action: string }> };
    expect(data.total_unconfirmed).toBe(1);
    expect(data.suggestions[0].suggested_action).toBe("manual_review");
  });

  it("auto_confirm skips consumed invoice and cross-currency base-only", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 1,
            type: "C",
            amount: 100,
            ref_number: "S",
            clients_id: 1,
            bank_account_name: "Same Client Name",
          }),
          projectTx({
            id: 2,
            type: "C",
            amount: 100,
            ref_number: "S",
            clients_id: 1,
            bank_account_name: "Same Client Name",
          }),
          projectTx({
            id: 3,
            type: "C",
            amount: 110,
            base_amount: 100,
            ref_number: "FX",
            clients_id: 1,
            bank_account_name: "Fx Client Namexx",
          }),
        ];
      }
      if (path === "/v1/sale_invoices") {
        return [
          {
            id: 1,
            clients_id: 1,
            client_name: "Same Client Name",
            gross_price: 100,
            bank_ref_number: "S",
            status: "CONFIRMED",
            payment_status: "NOT_PAID",
            cl_currencies_id: "EUR",
          },
          {
            id: 3,
            clients_id: 1,
            client_name: "Fx Client Namexx",
            gross_price: 100,
            base_amount: 100,
            bank_ref_number: "FX",
            status: "CONFIRMED",
            payment_status: "NOT_PAID",
            cl_currencies_id: "USD",
          },
        ];
      }
      return [];
    });
    const data = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "auto_confirm", execute: false }),
    ) as { errors: Array<{ reason: string }>; results: unknown[] };
    expect(data.results.length).toBe(1);
    expect(data.errors.some((e) => e.reason === "invoice_already_consumed")).toBe(true);
    expect(data.errors.some((e) => e.reason === "cross_currency_base_only")).toBe(true);
  });

  it("analyze_unconfirmed_transactions suggests invoice, fee, and inter-account", async () => {
    const result = await tools.analyze_unconfirmed_transactions.handler({ min_confidence: 40 });
    const data = parseToolJson(result) as {
      total_unconfirmed: number;
      summary: Record<string, number>;
      suggestions: Array<{ suggested_action: string; transaction_id: number }>;
    };
    expect(data.total_unconfirmed).toBe(3);
    expect(data.suggestions.some((s) => s.suggested_action === "confirm_invoice")).toBe(true);
    expect(data.suggestions.some((s) => s.suggested_action === "confirm_expense")).toBe(true);
    expect(data.suggestions.some((s) => s.suggested_action === "inter_account")).toBe(true);
  });

  it("analyze ignores unregistered journals", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [projectTx({ id: 5, amount: 33, date: "2025-06-02", type: "D" })];
      }
      if (path === "/v1/journals") {
        return [
          {
            id: 500,
            effective_date: "2025-06-02",
            registered: false,
            postings: [{ accounts_id: 100, accounts_dimensions_id: 10, amount: 33, type: "D" }],
          },
        ];
      }
      return [];
    });
    const data = parseToolJson(await tools.analyze_unconfirmed_transactions.handler({})) as {
      suggestions: Array<{ suggested_action: string }>;
    };
    expect(data.suggestions[0].suggested_action).not.toBe("reimport_duplicate");
  });

  it("analyze detects journal duplicates", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 5,
            amount: 33,
            date: "2025-06-02",
            bank_ref_number: "DUP1",
            type: "D",
          }),
          projectTx({
            id: 6,
            amount: 34,
            date: "2025-06-03",
            bank_ref_number: "",
            type: "D",
          }),
        ];
      }
      if (path === "/v1/journals") {
        return [
          {
            id: 500,
            effective_date: "2025-06-02",
            registered: true,
            document_number: "DUP1",
            postings: [{ accounts_id: 100, accounts_dimensions_id: 10, amount: 33, type: "D" }],
          },
          {
            id: 501,
            effective_date: "2025-06-03",
            registered: true,
            postings: [{ accounts_id: 100, accounts_dimensions_id: 10, amount: 34 }],
          },
        ];
      }
      if (path === "/v1/sale_invoices" || path === "/v1/purchase_invoices") return [];
      if (path === "/v1/bank_accounts") return [];
      if (path === "/v1/account_dimensions") return [];
      return [];
    });
    const data = parseToolJson(await tools.analyze_unconfirmed_transactions.handler({})) as {
      suggestions: Array<{ suggested_action: string; confidence: number }>;
    };
    expect(data.suggestions[0].suggested_action).toBe("reimport_duplicate");
    expect(data.suggestions[1].suggested_action).toBe("likely_duplicate");
    expect(data.suggestions[1].confidence).toBe(70);
  });

  it("analyze inter-account without dimension binding omits distribution", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 3,
            type: "D",
            amount: 50,
            bank_account_no: "EE99",
            accounts_dimensions_id: 10,
          }),
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [{ account_name_est: "Zulu", account_no: "9", iban_code: "EE99" }];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      return [];
    });
    const data = parseToolJson(await tools.analyze_unconfirmed_transactions.handler({})) as {
      suggestions: Array<{ distribution?: unknown }>;
    };
    expect(data.suggestions[0].distribution).toBeUndefined();
  });

  it("reconcile match mode returns scored candidates", async () => {
    const parsed = parseToolJson(await tools.reconcile_bank_transactions.handler({})) as {
      mode: string;
      matches: Array<{ best_match: { invoice_id: number } | null; distribution?: unknown }>;
    };
    expect(parsed.mode).toBe("match");
    const hit = parsed.matches.find((m) => m.best_match?.invoice_id === 90);
    expect(hit?.distribution).toBeTruthy();
  });

  it("match mode marks partially-paid as manual review without distribution", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 1,
            type: "C",
            amount: 100,
            ref_number: "R1",
            clients_id: 7,
            bank_account_name: "Buyer Co",
          }),
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
            payment_status: "PARTIALLY_PAID",
            cl_currencies_id: "EUR",
          },
        ];
      }
      return [];
    });
    const data = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "match" }),
    ) as {
      matches: Array<{ distribution?: unknown; manual_review_required?: boolean }>;
    };
    expect(data.matches[0].distribution).toBeUndefined();
    expect(data.matches[0].manual_review_required).toBe(true);

    const analyzed = parseToolJson(
      await tools.analyze_unconfirmed_transactions.handler({ min_confidence: 40 }),
    ) as { suggestions: Array<{ distribution?: unknown; manual_review_required?: boolean }> };
    expect(analyzed.suggestions[0].distribution).toBeUndefined();
  });

  it("auto_confirm dry-run does not mutate", async () => {
    const data = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "auto_confirm" }),
    ) as { mode: string; results: Array<{ status: string }> };
    expect(data.mode).toBe("DRY_RUN");
    expect(data.results.some((r) => r.status === "would_confirm")).toBe(true);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("auto_confirm execute registers with distribution array", async () => {
    await tools.reconcile_bank_transactions.handler({ mode: "auto_confirm", execute: true });
    expect(client.patch).toHaveBeenCalled();
    const registerCall = vi
      .mocked(client.patch)
      .mock.calls.find((c) => String(c[0]).includes("/register"));
    expect(registerCall?.[1]).toEqual([
      { related_table: "sale_invoices", related_id: 90, amount: 100 },
    ]);
  });

  it("auto_confirm skips ambiguous invoice candidates", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [projectTx({ id: 1, type: "C", amount: 100, ref_number: "SAME", clients_id: 1 })];
      }
      if (path === "/v1/sale_invoices") {
        return [
          {
            id: 1,
            clients_id: 1,
            client_name: "A",
            gross_price: 100,
            bank_ref_number: "SAME",
            status: "CONFIRMED",
            payment_status: "NOT_PAID",
            cl_currencies_id: "EUR",
          },
          {
            id: 2,
            clients_id: 1,
            client_name: "B",
            gross_price: 100,
            bank_ref_number: "SAME",
            status: "CONFIRMED",
            payment_status: "NOT_PAID",
            cl_currencies_id: "EUR",
          },
        ];
      }
      if (
        path.includes("purchase") ||
        path.includes("bank") ||
        path.includes("account") ||
        path.includes("journal") ||
        path.includes("client")
      ) {
        return [];
      }
      return [];
    });
    const data = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "auto_confirm", execute: true }),
    ) as { errors: Array<{ reason: string }> };
    expect(data.errors.some((e) => e.reason === "ambiguous_or_missing")).toBe(true);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("transfers dry-run and execute confirm+delete pair", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 11,
            type: "D",
            amount: 80,
            accounts_dimensions_id: 10,
            bank_account_no: "EE22",
            date: "2025-06-01",
          }),
          projectTx({
            id: 12,
            type: "C",
            amount: 80,
            accounts_dimensions_id: 20,
            bank_account_no: "EE11",
            date: "2025-06-01",
          }),
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [
          { account_name_est: "Main", account_no: "1", iban_code: "EE11" },
          { account_name_est: "Other", account_no: "2", iban_code: "EE22" },
        ];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      return [];
    });

    const dry = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "transfers" }),
    ) as { mode: string; pairs: Array<{ status: string }> };
    expect(dry.mode).toBe("DRY_RUN");
    expect(dry.pairs[0]?.status).toBe("would_confirm");
    expect(client.patch).not.toHaveBeenCalled();

    await tools.reconcile_bank_transactions.handler({ mode: "transfers", execute: true });
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/transactions/11/register",
      expect.arrayContaining([
        expect.objectContaining({ related_table: "accounts", related_sub_id: 20 }),
      ]),
    );
    expect(client.delete).toHaveBeenCalledWith("/v1/transactions/12");
  });

  it("filters by accounts_dimensions_id", async () => {
    await tools.analyze_unconfirmed_transactions.handler({ accounts_dimensions_id: 10 });
    expect(client.getAllPages).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ status: "PROJECT" }),
    );
  });

  it("analyze likely_duplicate, company-name inter-account, and manual_review", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 1,
            amount: 10,
            date: "2025-06-01",
            type: "D",
            bank_ref_number: "",
          }),
          projectTx({
            id: 2,
            amount: 11,
            date: "2025-06-03",
            type: "C",
            bank_account_name: "payment from Demo Company OÜ",
          }),
          projectTx({
            id: 3,
            amount: 12,
            date: "2025-06-04",
            type: "C",
            description: "mystery",
          }),
        ];
      }
      if (path === "/v1/journals") {
        return [
          {
            id: 1,
            effective_date: "2025-06-01",
            registered: true,
            postings: [{ accounts_id: 100, accounts_dimensions_id: 10, amount: 10, type: "D" }],
          },
          {
            id: 2,
            effective_date: "2025-06-01",
            registered: true,
            postings: [{ accounts_id: 100, accounts_dimensions_id: 10, amount: 10, type: "D" }],
          },
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [
          { account_name_est: "Main", account_no: "1", iban_code: "EE11" },
          { account_name_est: "Other", account_no: "2", iban_code: "EE22" },
        ];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      return [];
    });
    vi.mocked(client.get).mockResolvedValue({ company_name: "Demo Company" } as never);
    const data = parseToolJson(await tools.analyze_unconfirmed_transactions.handler({})) as {
      suggestions: Array<{ suggested_action: string; confidence: number }>;
    };
    const dup = data.suggestions.find((s) => s.suggested_action === "likely_duplicate");
    expect(dup?.confidence).toBe(55);
    const inter = data.suggestions.find((s) => s.suggested_action === "inter_account");
    expect(inter?.confidence).toBe(80);
    expect(data.suggestions.some((s) => s.suggested_action === "manual_review")).toBe(true);
  });

  it("company-name inter-account uses confidence 60 with one bank dimension", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 2,
            amount: 11,
            date: "2025-06-03",
            type: "C",
            bank_account_name: "payment from Demo Company OÜ",
          }),
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [{ account_name_est: "Main", account_no: "1", iban_code: "EE11" }];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
        ];
      }
      return [];
    });
    vi.mocked(client.get).mockResolvedValue({ company_name: "Demo Company" } as never);
    const data = parseToolJson(await tools.analyze_unconfirmed_transactions.handler({})) as {
      suggestions: Array<{ confidence: number }>;
    };
    expect(data.suggestions[0].confidence).toBe(60);
  });

  it("auto_confirm skips partially paid and register failures", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 1,
            type: "C",
            amount: 100,
            ref_number: "P1",
            clients_id: 9,
            bank_account_name: "Partial Client",
          }),
          projectTx({ id: 2, type: "C", amount: 200, ref_number: "P2", clients_id: 9 }),
        ];
      }
      if (path === "/v1/sale_invoices") {
        return [
          {
            id: 1,
            clients_id: 9,
            client_name: "Partial Client",
            gross_price: 100,
            bank_ref_number: "P1",
            status: "CONFIRMED",
            payment_status: "PARTIALLY_PAID",
            cl_currencies_id: "EUR",
          },
          {
            id: 2,
            clients_id: 9,
            client_name: "Y",
            gross_price: 200,
            bank_ref_number: "P2",
            status: "CONFIRMED",
            payment_status: "NOT_PAID",
            cl_currencies_id: "EUR",
          },
        ];
      }
      return [];
    });
    vi.mocked(client.patch).mockImplementation(async (path: string) => {
      if (String(path).includes("/register")) {
        throw "boom";
      }
      return { response_code: 0 } as never;
    });
    const data = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "auto_confirm", execute: true }),
    ) as { errors: Array<{ reason: string; message?: string }> };
    expect(data.errors.some((e) => e.reason === "partially_paid")).toBe(true);
    expect(data.errors.some((e) => e.reason === "register_failed" && e.message === "boom")).toBe(
      true,
    );
  });

  it("transfers execute sets clients_id and handles orphan delete", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 11,
            type: "D",
            amount: 80,
            accounts_dimensions_id: 10,
            bank_account_no: "EE22",
            date: "2025-06-01",
            clients_id: null,
          }),
          projectTx({
            id: 12,
            type: "C",
            amount: 80,
            accounts_dimensions_id: 20,
            bank_account_no: "EE11",
            date: "2025-06-01",
          }),
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [
          { account_name_est: "Main", account_no: "1", iban_code: "EE11" },
          { account_name_est: "Other", account_no: "2", iban_code: "EE22" },
        ];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      if (path === "/v1/clients") {
        return [{ id: 55, name: "Demo Company OÜ" }];
      }
      if (path === "/v1/journals") return [];
      return [];
    });
    vi.mocked(client.get).mockResolvedValue({ company_name: "Demo Company" } as never);
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
    vi.mocked(client.delete).mockRejectedValue(new Error("locked"));

    const data = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "transfers", execute: true }),
    ) as {
      pairs: Array<{ incoming_action: string }>;
    };
    expect(data.pairs.some((p) => p.incoming_action === "orphan")).toBe(true);
    expect(client.patch).toHaveBeenCalledWith(
      "/v1/transactions/11",
      expect.objectContaining({ clients_id: 55 }),
    );
  });

  it("transfers dry-run one-sided and execute failure / already journalized", async () => {
    const bankPages = async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 13,
            type: "D",
            amount: 15,
            accounts_dimensions_id: 10,
            bank_account_no: "EE22",
            date: "2025-06-05",
            clients_id: 1,
          }),
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [
          { account_name_est: "Main", account_no: "1", iban_code: "EE11" },
          { account_name_est: "Other", account_no: "2", iban_code: "EE22" },
        ];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      if (path === "/v1/journals") {
        return [
          {
            effective_date: "2025-06-05",
            registered: true,
            postings: [
              { accounts_id: 100, accounts_dimensions_id: 10, amount: 15, type: "D" },
              { accounts_id: 200, accounts_dimensions_id: 20, amount: 15, type: "C" },
            ],
          },
        ];
      }
      return [];
    };
    vi.mocked(client.getAllPages).mockImplementation(bankPages);
    const handled = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "transfers", execute: true }),
    ) as { already_handled: unknown[] };
    expect(handled.already_handled.length).toBeGreaterThan(0);

    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/journals") return [];
      return bankPages(path);
    });
    const dry = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "transfers" }),
    ) as { one_sided: Array<{ status: string }> };
    expect(dry.one_sided.some((p) => p.status === "would_confirm")).toBe(true);

    vi.mocked(client.patch).mockRejectedValue("nope");
    const failed = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "transfers", execute: true }),
    ) as { errors: Array<{ reason: string; message: string }> };
    expect(failed.errors.some((e) => e.reason === "register_failed" && e.message === "nope")).toBe(
      true,
    );
  });

  it("transfers execute confirms one-sided transfer", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 13,
            type: "D",
            amount: 15,
            accounts_dimensions_id: 10,
            bank_account_no: "EE22",
            date: "2025-06-05",
            clients_id: 1,
          }),
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [
          { account_name_est: "Main", account_no: "1", iban_code: "EE11" },
          { account_name_est: "Other", account_no: "2", iban_code: "EE22" },
        ];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      return [];
    });
    vi.mocked(client.patch).mockResolvedValue({ response_code: 0 } as never);
    const data = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "transfers", execute: true }),
    ) as { one_sided: Array<{ status: string }> };
    expect(data.one_sided.some((p) => p.status === "confirmed")).toBe(true);
  });

  it("transfers marks already journalized and register failure", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 11,
            type: "D",
            amount: 80,
            accounts_dimensions_id: 10,
            bank_account_no: "EE22",
            date: "2025-06-01",
            clients_id: 1,
          }),
          projectTx({
            id: 12,
            type: "C",
            amount: 80,
            accounts_dimensions_id: 20,
            bank_account_no: "EE11",
            date: "2025-06-01",
          }),
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [
          { account_name_est: "Main", account_no: "1", iban_code: "EE11" },
          { account_name_est: "Other", account_no: "2", iban_code: "EE22" },
        ];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      if (path === "/v1/journals") {
        return [
          {
            effective_date: "2025-06-01",
            registered: true,
            postings: [
              { accounts_id: 100, accounts_dimensions_id: 10, amount: 80, type: "D" },
              { accounts_id: 200, accounts_dimensions_id: 20, amount: 80, type: "C" },
            ],
          },
        ];
      }
      return [];
    });
    const handled = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "transfers", execute: true }),
    ) as { already_handled: unknown[] };
    expect(handled.already_handled.length).toBeGreaterThan(0);

    vi.mocked(client.getAllPages).mockImplementation(async (path: string) => {
      if (path === "/v1/transactions") {
        return [
          projectTx({
            id: 11,
            type: "D",
            amount: 80,
            accounts_dimensions_id: 10,
            bank_account_no: "EE22",
            date: "2025-06-01",
            clients_id: 1,
          }),
          projectTx({
            id: 12,
            type: "C",
            amount: 80,
            accounts_dimensions_id: 20,
            bank_account_no: "EE11",
            date: "2025-06-01",
          }),
        ];
      }
      if (path === "/v1/bank_accounts") {
        return [
          { account_name_est: "Main", account_no: "1", iban_code: "EE11" },
          { account_name_est: "Other", account_no: "2", iban_code: "EE22" },
        ];
      }
      if (path === "/v1/account_dimensions") {
        return [
          {
            id: 10,
            accounts_id: 100,
            title_est: "Main",
            title_eng: "Main",
            cl_currencies_id: "EUR",
          },
          {
            id: 20,
            accounts_id: 200,
            title_est: "Other",
            title_eng: "Other",
            cl_currencies_id: "EUR",
          },
        ];
      }
      return [];
    });
    vi.mocked(client.patch).mockRejectedValue(new Error("fail"));
    const failed = parseToolJson(
      await tools.reconcile_bank_transactions.handler({ mode: "transfers", execute: true }),
    ) as { errors: Array<{ reason: string }> };
    expect(failed.errors.some((e) => e.reason === "register_failed")).toBe(true);
  });
});
