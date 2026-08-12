import { describe, expect, it } from "vitest";
import type { Account } from "../types/accounts.js";
import type { Journal } from "../types/journal.js";
import {
  compareBalanceEntries,
  computeAccountBalance,
  computeClientDebt,
} from "./account-balance.js";
import { OPENING_BALANCE_API_WARNING } from "./balances.js";

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
  account({ id: 1210, balance_type: "D", account_type_est: "Varad", name_est: "Nõuded" }),
  account({ id: 2310, balance_type: "C", account_type_est: "Kohustused", name_est: "Võlad" }),
  account({ id: 1000, balance_type: "D", account_type_est: "Varad" }),
];

const journals: Journal[] = [
  {
    id: 1,
    effective_date: "2025-06-01",
    registered: true,
    is_deleted: false,
    clients_id: 42,
    title: "Sale",
    postings: [
      { accounts_id: 1210, type: "D", amount: 100 },
      { accounts_id: 1000, type: "C", amount: 100 },
    ],
  },
  {
    id: 2,
    effective_date: "2025-06-15",
    registered: true,
    is_deleted: false,
    clients_id: 42,
    title: "Payment",
    postings: [
      { accounts_id: 1000, type: "D", amount: 40, base_amount: 40 },
      { accounts_id: 1210, type: "C", amount: 40 },
    ],
  },
  {
    id: 3,
    effective_date: "2025-07-01",
    registered: true,
    is_deleted: false,
    clients_id: 99,
    postings: [
      { accounts_id: 1210, type: "D", amount: 500 },
      { accounts_id: 1000, type: "C", amount: 500 },
    ],
  },
  {
    id: 4,
    effective_date: "2025-06-20",
    registered: true,
    is_deleted: false,
    clients_id: 42,
    postings: [
      { accounts_id: 2310, type: "C", amount: 25 },
      { accounts_id: 1000, type: "D", amount: 25 },
    ],
  },
  {
    id: 5,
    effective_date: "2025-05-01",
    registered: false,
    clients_id: 42,
    postings: [{ accounts_id: 1210, type: "D", amount: 999 }],
  },
  {
    id: 6,
    effective_date: "2025-05-02",
    registered: true,
    is_deleted: true,
    clients_id: 42,
    postings: [{ accounts_id: 1210, type: "D", amount: 999 }],
  },
  {
    id: 7,
    effective_date: "2025-06-10",
    registered: true,
    clients_id: 42,
    postings: [
      { accounts_id: 1210, type: "D", amount: 10, is_deleted: true },
      { accounts_id: 1210, type: "X", amount: 10 },
      { accounts_id: 1210, type: "D", amount: 0 },
    ],
  },
];

describe("compareBalanceEntries", () => {
  it("orders by date then journal id", () => {
    const a = {
      journal_id: 2,
      date: "2025-01-01",
      title: null,
      type: "D" as const,
      amount: 1,
      clients_id: null,
    };
    const b = { ...a, journal_id: 1, date: "2025-01-02" };
    const c = { ...a, journal_id: 1 };
    expect(compareBalanceEntries(a, b)).toBe(-1);
    expect(compareBalanceEntries(b, a)).toBe(1);
    expect(compareBalanceEntries(a, c)).toBe(1);
    expect(compareBalanceEntries({ ...a, journal_id: null }, { ...a, journal_id: null })).toBe(0);
  });
});

describe("computeAccountBalance", () => {
  it("signs D-type accounts as debit - credit", () => {
    const result = computeAccountBalance(chart, journals, { accountId: 1210 });
    // 100 + 500 - 40 = 560
    expect(result.balance_type).toBe("D");
    expect(result.debit_total).toBe(600);
    expect(result.credit_total).toBe(40);
    expect(result.balance).toBe(560);
    expect(result.warnings).toContain(OPENING_BALANCE_API_WARNING);
  });

  it("signs C-type accounts as credit - debit", () => {
    const result = computeAccountBalance(chart, journals, { accountId: 2310 });
    expect(result.balance_type).toBe("C");
    expect(result.credit_total).toBe(25);
    expect(result.balance).toBe(25);
  });

  it("filters by clients_id and date window", () => {
    const result = computeAccountBalance(chart, journals, {
      accountId: 1210,
      clientsId: 42,
      dateFrom: "2025-06-01",
      dateTo: "2025-06-30",
    });
    // only journal 1 debit 100 and journal 2 credit 40
    expect(result.balance).toBe(60);
    expect(result.clients_id).toBe(42);
    expect(result.date_from).toBe("2025-06-01");
    expect(result.date_to).toBe("2025-06-30");
    expect(result.entry_count).toBe(2);
  });

  it("includes entries when requested, sorted by date then journal id", () => {
    const result = computeAccountBalance(chart, journals, {
      accountId: 1210,
      clientsId: 42,
      includeEntries: true,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries?.[0]?.date).toBe("2025-06-01");
    expect(result.entries?.[0]?.type).toBe("D");
    expect(result.entries?.[1]?.date).toBe("2025-06-15");
    expect(result.entries?.[1]?.type).toBe("C");
    expect(result.entry_count).toBe(2);

    const sameDay: Journal[] = [
      {
        id: 20,
        effective_date: "2025-06-10",
        registered: true,
        clients_id: 42,
        postings: [{ accounts_id: 1210, type: "D", amount: 2 }],
      },
      {
        id: 10,
        effective_date: "2025-06-10",
        registered: true,
        clients_id: 42,
        postings: [{ accounts_id: 1210, type: "D", amount: 1 }],
      },
      {
        id: 5,
        effective_date: "2025-06-12",
        registered: true,
        clients_id: 42,
        postings: [{ accounts_id: 1210, type: "D", amount: 3 }],
      },
    ];
    const sorted = computeAccountBalance(chart, sameDay, {
      accountId: 1210,
      includeEntries: true,
    });
    expect(sorted.entries?.map((e) => e.journal_id)).toEqual([10, 20, 5]);
  });

  it("falls back for unknown account id", () => {
    const result = computeAccountBalance(chart, journals, { accountId: 9999 });
    expect(result.account_name).toBe("Unknown");
    expect(result.balance_type).toBe("D");
    expect(result.balance).toBe(0);
    expect(result.warnings.some((w) => w.includes("9999"))).toBe(true);
  });

  it("uses base_amount when present", () => {
    const result = computeAccountBalance(chart, journals, {
      accountId: 1000,
      clientsId: 42,
      dateFrom: "2025-06-15",
      dateTo: "2025-06-15",
    });
    expect(result.debit_total).toBe(40);
  });

  it("handles missing journal id/clients_id/title and non-array postings", () => {
    const odd: Journal[] = [
      {
        effective_date: "2025-06-01",
        registered: true,
        postings: [{ accounts_id: 1210, type: "D", amount: 7 }],
      },
      {
        id: 99,
        effective_date: "2025-06-02",
        registered: true,
        clients_id: null,
        title: undefined,
        // force the non-array fallback in both aggregate and count paths
        postings: null as unknown as Journal["postings"],
      },
    ];
    const withEntries = computeAccountBalance(chart, odd, {
      accountId: 1210,
      includeEntries: true,
    });
    expect(withEntries.entries?.[0]).toMatchObject({
      journal_id: null,
      clients_id: null,
      title: null,
      amount: 7,
    });
    const counted = computeAccountBalance(chart, odd, { accountId: 1210 });
    expect(counted.entry_count).toBe(1);
  });

  it("formats account name from est/eng", () => {
    const withBoth = computeAccountBalance(
      [
        account({
          id: 1,
          balance_type: "D",
          account_type_est: "Varad",
          name_est: "A",
          name_eng: "B",
        }),
      ],
      [],
      { accountId: 1 },
    );
    expect(withBoth.account_name).toBe("A / B");

    const engOnly = computeAccountBalance(
      [
        account({
          id: 2,
          balance_type: "D",
          account_type_est: "Varad",
          name_est: "  ",
          name_eng: "OnlyEng",
        }),
      ],
      [],
      { accountId: 2 },
    );
    expect(engOnly.account_name).toBe("OnlyEng");

    const blank = computeAccountBalance(
      [
        account({
          id: 3,
          balance_type: "D",
          account_type_est: "Varad",
          name_est: "",
          name_eng: "",
        }),
      ],
      [],
      { accountId: 3 },
    );
    expect(blank.account_name).toBe("Unknown");

    const missingNames = computeAccountBalance(
      [
        {
          ...account({ id: 4, balance_type: "D", account_type_est: "Varad" }),
          name_est: undefined as unknown as string,
          name_eng: undefined as unknown as string,
        },
      ],
      [],
      { accountId: 4 },
    );
    expect(missingNames.account_name).toBe("Unknown");
  });

  it("treats non-finite posting amounts as zero", () => {
    const result = computeAccountBalance(
      chart,
      [
        {
          id: 1,
          effective_date: "2025-06-01",
          registered: true,
          postings: [
            { accounts_id: 1210, type: "D", amount: Number.NaN },
            { accounts_id: 1210, type: "D", amount: "x" as unknown as number },
          ],
        },
      ],
      { accountId: 1210 },
    );
    expect(result.balance).toBe(0);
    expect(result.entry_count).toBe(0);
  });
});

describe("computeClientDebt", () => {
  it("summarizes debt and receivable across discovered accounts", () => {
    const result = computeClientDebt(chart, journals, { clientsId: 42 });
    const ids = result.accounts.map((a) => a.account_id).sort((a, b) => a - b);
    expect(ids).toEqual([1000, 1210, 2310]);
    // 1210 D: 100-40 = 60; 1000 D: 65-100 = -35; 2310 C: 25
    expect(result.summary.total_debt_to_client).toBe(25);
    expect(result.summary.total_receivable_from_client).toBe(25);
    expect(result.summary.net_position).toBe(0);
  });

  it("respects explicit account_ids including zero-activity accounts", () => {
    const result = computeClientDebt(chart, journals, {
      clientsId: 42,
      accountIds: [1210, 9999],
    });
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts.find((a) => a.account_id === 9999)?.entry_count).toBe(0);
    expect(result.warnings.some((w) => w.includes("9999"))).toBe(true);
  });

  it("returns empty accounts when client has no postings and no account_ids", () => {
    const result = computeClientDebt(chart, journals, { clientsId: 777 });
    expect(result.accounts).toEqual([]);
    expect(result.summary).toEqual({
      total_debt_to_client: 0,
      total_receivable_from_client: 0,
      net_position: 0,
    });
  });

  it("treats empty account_ids like omitted and skips non-array postings in discovery", () => {
    const withBad: Journal[] = [
      ...journals,
      {
        id: 50,
        effective_date: "2025-06-01",
        registered: true,
        clients_id: 42,
        postings: null as unknown as Journal["postings"],
      },
    ];
    const result = computeClientDebt(chart, withBad, { clientsId: 42, accountIds: [] });
    expect(result.accounts.map((a) => a.account_id).sort((a, b) => a - b)).toEqual([
      1000, 1210, 2310,
    ]);
  });
});
