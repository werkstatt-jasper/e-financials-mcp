import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { JOURNAL_LIST_MAX_PAGES } from "../financial-statements/load-journals.js";
import type { Account } from "../types/accounts.js";
import type { Journal } from "../types/journal.js";
import { createAccountBalanceTools } from "./account-balance.js";
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
  account({ id: 1210, balance_type: "D", account_type_est: "Varad" }),
  account({ id: 2310, balance_type: "C", account_type_est: "Kohustused" }),
];

const journals: Journal[] = [
  {
    id: 1,
    effective_date: "2025-06-01",
    registered: true,
    clients_id: 42,
    postings: [
      { accounts_id: 1210, type: "D", amount: 100 },
      { accounts_id: 2310, type: "C", amount: 100 },
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

describe("account balance tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createAccountBalanceTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createAccountBalanceTools(client);
  });

  it("compute_account_balance returns signed balance", async () => {
    mockLedger(client);
    const result = await tools.compute_account_balance.handler({
      account_id: 1210,
      clients_id: 42,
      date_from: "2025-06-01",
      date_to: "2025-06-30",
      include_entries: true,
    });
    const data = parseToolJson(result) as {
      balance: number;
      entry_count: number;
      entries: unknown[];
      clients_id: number;
    };
    expect(data.balance).toBe(100);
    expect(data.entry_count).toBe(1);
    expect(data.entries).toHaveLength(1);
    expect(data.clients_id).toBe(42);
  });

  it("compute_client_debt summarizes net position", async () => {
    mockLedger(client);
    const result = await tools.compute_client_debt.handler({
      clients_id: 42,
      account_ids: [1210, 2310],
    });
    const data = parseToolJson(result) as {
      summary: {
        total_debt_to_client: number;
        total_receivable_from_client: number;
        net_position: number;
      };
      accounts: unknown[];
    };
    expect(data.accounts).toHaveLength(2);
    expect(data.summary.total_receivable_from_client).toBe(100);
    expect(data.summary.total_debt_to_client).toBe(100);
    expect(data.summary.net_position).toBe(0);
  });

  it("compute_client_debt discovers accounts when account_ids omitted", async () => {
    mockLedger(client);
    const result = await tools.compute_client_debt.handler({ clients_id: 42 });
    const data = parseToolJson(result) as { accounts: Array<{ account_id: number }> };
    expect(data.accounts.map((a) => a.account_id).sort((a, b) => a - b)).toEqual([1210, 2310]);
  });

  it("requires account_id", async () => {
    await expect(tools.compute_account_balance.handler({})).rejects.toThrow(/account_id/);
  });

  it("requires clients_id for client debt", async () => {
    await expect(tools.compute_client_debt.handler({})).rejects.toThrow(/clients_id/);
  });

  it("returns structured error when journal list is truncated", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(chart as never);
    let page = 0;
    vi.mocked(client.get).mockImplementation(async (path) => {
      if (path === "/v1/journals") {
        page += 1;
        return {
          items: journals,
          current_page: page,
          total_pages: JOURNAL_LIST_MAX_PAGES + 1,
        } as never;
      }
      throw new Error(`unexpected get ${path}`);
    });

    const result = await tools.compute_account_balance.handler({ account_id: 1210 });
    const data = parseToolJson(result) as { error: string; message: string };
    expect(data.error).toBe("journal_list_truncated");
    expect(data.message).toMatch(/Narrow date/);
  });

  it("returns structured error for client debt truncation", async () => {
    vi.mocked(client.getAllPages).mockResolvedValue(chart as never);
    let page = 0;
    vi.mocked(client.get).mockImplementation(async (path) => {
      if (path === "/v1/journals") {
        page += 1;
        return {
          items: journals,
          current_page: page,
          total_pages: JOURNAL_LIST_MAX_PAGES + 1,
        } as never;
      }
      throw new Error(`unexpected get ${path}`);
    });

    const result = await tools.compute_client_debt.handler({ clients_id: 42 });
    const data = parseToolJson(result) as { error: string };
    expect(data.error).toBe("journal_list_truncated");
  });

  it("rethrows unexpected errors from account balance and client debt", async () => {
    vi.mocked(client.getAllPages).mockRejectedValue(new Error("boom"));
    await expect(tools.compute_account_balance.handler({ account_id: 1210 })).rejects.toThrow(
      "boom",
    );
    await expect(tools.compute_client_debt.handler({ clients_id: 42 })).rejects.toThrow("boom");
  });
});
