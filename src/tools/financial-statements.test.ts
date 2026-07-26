import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { JOURNAL_LIST_MAX_PAGES } from "../financial-statements/load-journals.js";
import type { Account } from "../types/accounts.js";
import type { Journal } from "../types/journal.js";
import { createFinancialStatementTools } from "./financial-statements.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

function account(
  overrides: Partial<Account> & Pick<Account, "id" | "balance_type" | "account_type_est">,
): Account {
  return {
    name_est: `Konto ${overrides.id}`,
    name_eng: `Account ${overrides.id}`,
    account_type_eng: overrides.account_type_est,
    is_valid: true,
    is_vat_account: false,
    is_fixed_asset: false,
    priority: 1,
    allows_deactivation: true,
    transaction_in_bindable: true,
    transaction_out_bindable: true,
    cl_account_groups: [],
    ...overrides,
  };
}

const chart: Account[] = [
  account({ id: 1000, balance_type: "D", account_type_est: "Varad" }),
  account({ id: 2000, balance_type: "C", account_type_est: "Kohustused" }),
  account({ id: 2500, balance_type: "C", account_type_est: "Omakapital" }),
  account({ id: 3000, balance_type: "C", account_type_est: "Tulud", name_est: "" }),
  account({ id: 4000, balance_type: "D", account_type_est: "Kulud" }),
];

const journals: Journal[] = [
  {
    id: 1,
    effective_date: "2025-06-01",
    registered: true,
    is_deleted: false,
    postings: [
      { accounts_id: 1000, type: "D", amount: 100 },
      { accounts_id: 3000, type: "C", amount: 100 },
    ],
  },
  {
    id: 2,
    effective_date: "2025-06-15",
    registered: true,
    is_deleted: false,
    postings: [
      { accounts_id: 4000, type: "D", amount: 40 },
      { accounts_id: 1000, type: "C", amount: 40 },
    ],
  },
  {
    id: 3,
    effective_date: "2025-01-01",
    registered: true,
    is_deleted: false,
    postings: [
      { accounts_id: 1000, type: "D", amount: 50 },
      { accounts_id: 2500, type: "C", amount: 50 },
    ],
  },
];

function mockLedger(client: EFinancialsClient, list: Journal[] = journals) {
  vi.mocked(client.getAllPages).mockImplementation(async (path) => {
    if (path === "/v1/accounts") {
      return chart as never;
    }
    throw new Error(`unexpected getAllPages ${path}`);
  });
  vi.mocked(client.get).mockImplementation(async (path) => {
    if (path === "/v1/journals") {
      return { items: list, current_page: 1, total_pages: 1 } as never;
    }
    throw new Error(`unexpected get ${path}`);
  });
}

describe("financial statement tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createFinancialStatementTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createFinancialStatementTools(client);
  });

  it("compute_trial_balance returns balanced totals and warnings", async () => {
    mockLedger(client);
    const result = await tools.compute_trial_balance.handler({
      date_from: "2025-06-01",
      date_to: "2025-06-30",
    });
    const data = parseToolJson(result) as {
      totals: { debit: number; credit: number; difference: number };
      account_count: number;
      warnings: string[];
      period: { from: string; to: string };
    };
    expect(data.totals.difference).toBe(0);
    expect(data.totals.debit).toBe(data.totals.credit);
    expect(data.account_count).toBeGreaterThan(0);
    expect(data.warnings[0]).toMatch(/Algbilansi/);
    expect(data.period).toEqual({ from: "2025-06-01", to: "2025-06-30" });
    expect(client.get).toHaveBeenCalledWith(
      "/v1/journals",
      expect.objectContaining({
        start_date: "2025-06-01",
        end_date: "2025-06-30",
        page: 1,
      }),
    );
  });

  it("compute_trial_balance defaults period labels when dates omitted", async () => {
    mockLedger(client);
    const data = parseToolJson(await tools.compute_trial_balance.handler({})) as {
      period: { from: string; to: string };
    };
    expect(data.period).toEqual({ from: "inception", to: "now" });
  });

  it("compute_balance_sheet folds open P&L into equity", async () => {
    mockLedger(client);
    const data = parseToolJson(
      await tools.compute_balance_sheet.handler({ date_to: "2025-06-30" }),
    ) as {
      check: { balanced: boolean; assets: number; liabilities_plus_equity: number };
      current_year_pl: { net_profit: number };
      equity: { total: number };
      warnings: string[];
      revenue?: unknown;
    };
    expect(data.check.balanced).toBe(true);
    expect(data.current_year_pl.net_profit).toBe(60);
    expect(data.warnings.some((w) => w.includes("folded into equity"))).toBe(true);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/journals",
      expect.objectContaining({ end_date: "2025-06-30", page: 1 }),
    );
  });

  it("compute_balance_sheet defaults date label when date_to omitted", async () => {
    mockLedger(client);
    const data = parseToolJson(await tools.compute_balance_sheet.handler({})) as {
      current_year_pl: { revenue: number };
      date: string;
    };
    expect(data.date).toBe("current");
    expect(data.current_year_pl.revenue).toBe(100);
  });

  it("compute_balance_sheet omits open-P&L fold warning when net is zero", async () => {
    mockLedger(client, [
      {
        id: 1,
        effective_date: "2025-01-01",
        registered: true,
        postings: [
          { accounts_id: 1000, type: "D", amount: 50 },
          { accounts_id: 2500, type: "C", amount: 50 },
        ],
      },
    ]);
    const data = parseToolJson(await tools.compute_balance_sheet.handler({})) as {
      current_year_pl: { net_profit: number };
      warnings: string[];
      check: { balanced: boolean };
    };
    expect(data.current_year_pl.net_profit).toBe(0);
    expect(data.check.balanced).toBe(true);
    expect(data.warnings.some((w) => w.includes("folded into equity"))).toBe(false);
  });

  it("compute_profit_and_loss requires dates and returns net_profit", async () => {
    mockLedger(client);
    const data = parseToolJson(
      await tools.compute_profit_and_loss.handler({
        date_from: "2025-06-01",
        date_to: "2025-06-30",
      }),
    ) as {
      net_profit: number;
      revenue: { total: number; items: { id: number; name: string; amount: number }[] };
      expenses: { total: number };
    };
    expect(data.revenue.total).toBe(100);
    expect(data.expenses.total).toBe(40);
    expect(data.net_profit).toBe(60);
    expect(data.revenue.items[0]?.name).toBe("Account 3000");
  });

  it("returns structured truncation error for all three tools", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(chart as never);
    vi.mocked(client.get).mockImplementation(async (_path, params) => {
      const page = Number(params?.page ?? 1);
      return {
        items: [{ id: page, effective_date: "2025-01-01", postings: [], registered: true }],
        current_page: page,
        total_pages: JOURNAL_LIST_MAX_PAGES + 1,
      } as never;
    });

    for (const name of [
      "compute_trial_balance",
      "compute_balance_sheet",
      "compute_profit_and_loss",
    ] as const) {
      const args =
        name === "compute_profit_and_loss"
          ? { date_from: "2025-01-01", date_to: "2025-12-31" }
          : {};
      const data = parseToolJson(await tools[name].handler(args)) as {
        error: string;
        message: string;
      };
      expect(data.error).toBe("journal_list_truncated");
      expect(data.message).toMatch(/Narrow date_from/);
    }
  });

  it("rethrows unexpected errors", async () => {
    vi.mocked(client.getAllPages).mockRejectedValue(new Error("network down"));
    await expect(tools.compute_trial_balance.handler({})).rejects.toThrow("network down");
    await expect(tools.compute_balance_sheet.handler({})).rejects.toThrow("network down");
    await expect(
      tools.compute_profit_and_loss.handler({
        date_from: "2025-01-01",
        date_to: "2025-12-31",
      }),
    ).rejects.toThrow("network down");
  });
});
