import { describe, expect, it } from "vitest";
import type { Account } from "../types/accounts.js";
import type { Journal } from "../types/journal.js";
import { computeAllBalances, OPENING_BALANCE_API_WARNING, sumCategory } from "./balances.js";

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

function journal(
  overrides: Partial<Journal> & Pick<Journal, "effective_date" | "postings">,
): Journal {
  return {
    id: 1,
    registered: true,
    is_deleted: false,
    ...overrides,
  };
}

describe("computeAllBalances", () => {
  const cash = account({ id: 1000, balance_type: "D", account_type_est: "Varad" });
  const payable = account({ id: 2000, balance_type: "C", account_type_est: "Kohustused" });
  const revenue = account({ id: 3000, balance_type: "C", account_type_est: "Tulud" });
  const expense = account({ id: 4000, balance_type: "D", account_type_est: "Kulud" });
  const equity = account({ id: 2500, balance_type: "C", account_type_est: "Omakapital" });

  it("builds a balanced trial balance from D/C postings", () => {
    const journals = [
      journal({
        id: 1,
        effective_date: "2025-06-01",
        postings: [
          { accounts_id: 1000, type: "D", amount: 100 },
          { accounts_id: 3000, type: "C", amount: 100 },
        ],
      }),
      journal({
        id: 2,
        effective_date: "2025-06-02",
        postings: [
          { accounts_id: 4000, type: "D", amount: 40 },
          { accounts_id: 1000, type: "C", amount: 40 },
        ],
      }),
    ];
    const balances = computeAllBalances([cash, payable, revenue, expense, equity], journals, {
      dateFrom: "2025-06-01",
      dateTo: "2025-06-30",
    });
    const debit = balances.reduce((s, b) => s + b.debit_total, 0);
    const credit = balances.reduce((s, b) => s + b.credit_total, 0);
    expect(debit).toBe(credit);
    expect(balances.find((b) => b.account_id === 1000)?.balance).toBe(60);
  });

  it("skips deleted/unregistered journals and deleted/bad postings", () => {
    const journals = [
      journal({
        id: 1,
        registered: false,
        effective_date: "2025-01-01",
        postings: [{ accounts_id: 1000, type: "D", amount: 99 }],
      }),
      journal({
        id: 2,
        is_deleted: true,
        effective_date: "2025-01-01",
        postings: [{ accounts_id: 1000, type: "D", amount: 99 }],
      }),
      journal({
        id: 3,
        effective_date: "2025-01-01",
        postings: [
          { accounts_id: 1000, type: "D", amount: 10, is_deleted: true },
          { accounts_id: 1000, type: "X", amount: 10 },
          { accounts_id: 1000, type: "D", amount: 5 },
          { accounts_id: 2000, type: "C", amount: 5 },
        ],
      }),
    ];
    const balances = computeAllBalances([cash, payable], journals);
    expect(balances).toHaveLength(2);
    expect(balances.find((b) => b.account_id === 1000)?.debit_total).toBe(5);
  });

  it("filters by inclusive effective_date window", () => {
    const journals = [
      journal({
        id: 1,
        effective_date: "2025-05-31",
        postings: [
          { accounts_id: 1000, type: "D", amount: 1 },
          { accounts_id: 2000, type: "C", amount: 1 },
        ],
      }),
      journal({
        id: 2,
        effective_date: "2025-06-01",
        postings: [
          { accounts_id: 1000, type: "D", amount: 2 },
          { accounts_id: 2000, type: "C", amount: 2 },
        ],
      }),
      journal({
        id: 3,
        effective_date: "2025-07-01",
        postings: [
          { accounts_id: 1000, type: "D", amount: 4 },
          { accounts_id: 2000, type: "C", amount: 4 },
        ],
      }),
    ];
    const balances = computeAllBalances([cash, payable], journals, {
      dateFrom: "2025-06-01",
      dateTo: "2025-06-30",
    });
    expect(balances.find((b) => b.account_id === 1000)?.debit_total).toBe(2);
  });

  it("uses base_amount when present", () => {
    const journals = [
      journal({
        effective_date: "2025-01-01",
        postings: [
          { accounts_id: 1000, type: "D", amount: 100, base_amount: 90 },
          { accounts_id: 2000, type: "C", amount: 100, base_amount: 90 },
        ],
      }),
    ];
    const balances = computeAllBalances([cash, payable], journals);
    expect(balances.find((b) => b.account_id === 1000)?.debit_total).toBe(90);
  });

  it("keeps postings to unknown accounts as 'Unknown' rows instead of dropping them", () => {
    const balances = computeAllBalances(
      [cash],
      [
        journal({
          effective_date: "2025-01-01",
          postings: [{ accounts_id: 9999, type: "D", amount: 1 }],
        }),
        journal({ effective_date: "2025-01-01", postings: [] }),
      ],
    );
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({
      account_id: 9999,
      name_est: "Unknown",
      name_eng: "Unknown",
      account_type_est: "Unknown",
      balance_type: "D",
      debit_total: 1,
      credit_total: 0,
      balance: 1,
      unknown_account: true,
    });
  });

  it("returns an empty result when there are no postings at all", () => {
    const balances = computeAllBalances(
      [cash],
      [journal({ effective_date: "2025-01-01", postings: [] })],
    );
    expect(balances).toEqual([]);
  });

  it("treats non-finite amounts as zero and tolerates missing postings array", () => {
    const balances = computeAllBalances(
      [cash, payable],
      [
        journal({
          effective_date: "2025-01-01",
          postings: [
            { accounts_id: 1000, type: "D", amount: Number.NaN },
            { accounts_id: 2000, type: "C", amount: Number.POSITIVE_INFINITY },
          ],
        }),
        { id: 9, effective_date: "2025-01-01", registered: true, postings: undefined as never },
      ],
    );
    expect(balances).toEqual([]);
  });

  it("signs credit-normal accounts as credit minus debit", () => {
    const balances = computeAllBalances(
      [payable],
      [
        journal({
          effective_date: "2025-01-01",
          postings: [
            { accounts_id: 2000, type: "C", amount: 30 },
            { accounts_id: 2000, type: "D", amount: 10 },
          ],
        }),
      ],
    );
    expect(balances[0]?.balance).toBe(20);
    expect(balances[0]?.balance_type).toBe("C");
  });
});

describe("sumCategory", () => {
  it("handles contra accounts under Varad and Kulud", () => {
    const items = [
      {
        account_id: 1000,
        name_est: "Vara",
        name_eng: "Asset",
        balance_type: "D",
        account_type_est: "Varad",
        debit_total: 100,
        credit_total: 0,
        balance: 100,
      },
      {
        account_id: 1500,
        name_est: "Kulum",
        name_eng: "Accum dep",
        balance_type: "C",
        account_type_est: "Varad",
        debit_total: 0,
        credit_total: 20,
        balance: 20,
      },
      {
        account_id: 4000,
        name_est: "Kulu",
        name_eng: "Expense",
        balance_type: "D",
        account_type_est: "Kulud",
        debit_total: 50,
        credit_total: 0,
        balance: 50,
      },
      {
        account_id: 4010,
        name_est: "Kulude vähendus",
        name_eng: "Expense contra",
        balance_type: "C",
        account_type_est: "Kulud",
        debit_total: 0,
        credit_total: 5,
        balance: 5,
      },
    ];
    expect(sumCategory(items, "Varad", "D").total).toBe(80);
    expect(sumCategory(items, "Kulud", "D").total).toBe(45);
  });

  it("handles contra under credit-normal categories", () => {
    const items = [
      {
        account_id: 2000,
        name_est: "Kohustus",
        name_eng: "Liability",
        balance_type: "C",
        account_type_est: "Kohustused",
        debit_total: 0,
        credit_total: 100,
        balance: 100,
      },
      {
        account_id: 2010,
        name_est: "Contra",
        name_eng: "Contra",
        balance_type: "D",
        account_type_est: "Kohustused",
        debit_total: 15,
        credit_total: 0,
        balance: 15,
      },
    ];
    expect(sumCategory(items, "Kohustused", "C").total).toBe(85);
  });

  it("exports opening-balance warning constant", () => {
    expect(OPENING_BALANCE_API_WARNING).toMatch(/Algbilansi/);
  });
});
