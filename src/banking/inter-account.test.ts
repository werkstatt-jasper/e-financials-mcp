import { describe, expect, it } from "vitest";
import type { AccountDimension, BankAccounts } from "../types/accounts.js";
import type { Journal } from "../types/journal.js";
import type { Transaction } from "../types/transaction.js";
import {
  bindIbanToDimension,
  buildAccountDistribution,
  buildOwnBankMaps,
  expandOwnDimensionsFromTransactions,
  findOneSidedTransfers,
  findTransferPairs,
  indexInterAccountJournals,
  isAlreadyJournalizedTransfer,
  journalTransferKey,
  normalizeIban,
} from "./inter-account.js";

function tx(
  partial: Partial<Transaction> &
    Pick<Transaction, "id" | "type" | "amount" | "date" | "accounts_dimensions_id">,
): Transaction {
  return {
    accounts_id: 1,
    clients_id: null,
    bank_accounts_id: 1,
    bank_ref_number: "",
    bank_subtype: "",
    bank_account_no: null,
    bank_account_name: null,
    ref_number: null,
    cl_currencies_id: "EUR",
    description: "",
    status: "PROJECT",
    is_deleted: false,
    currency_rate: 1,
    base_amount: partial.amount,
    ...partial,
  };
}

describe("inter-account", () => {
  it("normalizeIban strips spaces", () => {
    expect(normalizeIban("ee12 34")).toBe("EE1234");
    expect(normalizeIban(null)).toBe("");
  });

  it("buildOwnBankMaps binds by name and 1:1 fallback", () => {
    const named = buildOwnBankMaps(
      [
        {
          account_name_est: "Swedbank",
          account_no: "11",
          iban_code: "EE11",
        } satisfies BankAccounts,
        { account_name_est: "Empty", account_no: "", iban_code: "" },
      ],
      [
        {
          id: 5,
          accounts_id: 100,
          title_est: "Swedbank",
          title_eng: "Swedbank",
          cl_currencies_id: "EUR",
        } satisfies AccountDimension,
        {
          id: 6,
          accounts_id: 101,
          title_est: "Other",
          title_eng: "",
          cl_currencies_id: "EUR",
        },
      ],
    );
    expect(named.ibanToDimension.get("EE11")).toBe(5);
    expect(named.dimensionToAccountsId.get(5)).toBe(100);
    expect(named.dimensionToTitle.get(6)).toBe("Other");

    const fallback = buildOwnBankMaps(
      [{ account_name_est: "A", account_no: "22", iban_code: "EE22" }],
      [{ id: 9, accounts_id: 200, title_est: "X", title_eng: "Y", cl_currencies_id: "EUR" }],
    );
    expect(fallback.ibanToDimension.get("EE22")).toBe(9);

    const emptyIbanFallback = buildOwnBankMaps(
      [{ account_name_est: "A", account_no: "", iban_code: "" }],
      [{ id: 9, accounts_id: 200, title_est: "X", title_eng: "Y", cl_currencies_id: "EUR" }],
    );
    expect(emptyIbanFallback.ibanToDimension.size).toBe(0);

    const nullIbanCodeFallback = buildOwnBankMaps(
      [{ account_name_est: "Nomatch", account_no: "EE88", iban_code: null }],
      [{ id: 9, accounts_id: 200, title_est: "X", title_eng: "Y", cl_currencies_id: "EUR" }],
    );
    expect(nullIbanCodeFallback.ibanToDimension.get("EE88")).toBe(9);

    const fromAccountNo = buildOwnBankMaps(
      [{ account_name_est: "Solo", account_no: "EE77", iban_code: null }],
      [{ id: 7, accounts_id: 70, title_est: "Solo", title_eng: "Solo", cl_currencies_id: "EUR" }],
    );
    expect(fromAccountNo.ibanToDimension.get("EE77")).toBe(7);

    const skipUsedDim = buildOwnBankMaps(
      [
        {
          account_name_est: "Twin",
          account_no: "1",
          iban_code: "EE01",
          account_name_eng: "Twin EN",
        },
        { account_name_est: "Twin", account_no: "2", iban_code: "EE02" },
      ],
      [
        { id: 1, accounts_id: 10, title_est: "Twin", title_eng: "Twin", cl_currencies_id: "EUR" },
        { id: 2, accounts_id: 20, title_est: "Other", title_eng: "Other", cl_currencies_id: "EUR" },
      ],
    );
    expect(skipUsedDim.ibanToDimension.get("EE01")).toBe(1);
    expect(skipUsedDim.ownDimensions.has(1)).toBe(true);

    const empty = buildOwnBankMaps([], []);
    expect(empty.ownIbans.size).toBe(0);

    // Reverse name inclusion (dimension title contained in bank account name)
    const reverse = buildOwnBankMaps(
      [{ account_name_est: "Swedbank EE Current", account_no: "1", iban_code: "EE55" }],
      [
        {
          id: 8,
          accounts_id: 80,
          title_est: "Swedbank",
          title_eng: "Swedbank",
          cl_currencies_id: "EUR",
        },
      ],
    );
    expect(reverse.ibanToDimension.get("EE55")).toBe(8);
  });

  it("expand and bind helpers update maps", () => {
    const maps = buildOwnBankMaps(
      [{ account_name_est: "A", account_no: "EEAA", iban_code: "EEAA" }],
      [{ id: 1, accounts_id: 10, title_est: "A", title_eng: "A", cl_currencies_id: "EUR" }],
    );
    expandOwnDimensionsFromTransactions(maps, [
      { accounts_dimensions_id: 2, bank_account_no: "FOREIGN" },
    ]);
    expect(maps.ownDimensions.has(2)).toBe(true);
    expect(maps.ibanToDimension.get("EEAA")).toBe(1);
    bindIbanToDimension(maps, "ee bb", 3);
    expect(maps.ibanToDimension.get("EEBB")).toBe(3);
    bindIbanToDimension(maps, "  ", 4);
    expect(maps.ibanToDimension.has("")).toBe(false);
  });

  it("findTransferPairs matches D→C with IBAN signal and skips ambiguity", () => {
    const maps = buildOwnBankMaps(
      [
        { account_name_est: "Bank1", account_no: "1", iban_code: "EE11" },
        { account_name_est: "Bank2", account_no: "2", iban_code: "EE22" },
      ],
      [
        {
          id: 1,
          accounts_id: 100,
          title_est: "Bank1",
          title_eng: "Bank1",
          cl_currencies_id: "EUR",
        },
        {
          id: 2,
          accounts_id: 200,
          title_est: "Bank2",
          title_eng: "Bank2",
          cl_currencies_id: "EUR",
        },
      ],
    );
    bindIbanToDimension(maps, "EE11", 1);
    bindIbanToDimension(maps, "EE22", 2);

    const out = tx({
      id: 1,
      type: "D",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
      bank_account_no: "EE22",
    });
    const inn = tx({
      id: 2,
      type: "C",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 2,
      bank_account_no: "EE11",
    });
    const { pairs, ambiguous } = findTransferPairs([out, inn], maps, 1);
    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].targetDimensionId).toBe(2);

    const inn2 = tx({
      id: 3,
      type: "C",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 2,
      bank_account_no: "EE11",
    });
    const amb = findTransferPairs([out, inn, inn2], maps, 1);
    expect(amb.ambiguous.length).toBeGreaterThan(0);
    expect(amb.pairs).toHaveLength(0);
  });

  it("rejects pairs without amount/date/counterparty signals", () => {
    const maps = buildOwnBankMaps(
      [{ account_name_est: "Bank1", account_no: "1", iban_code: "EE11" }],
      [
        {
          id: 1,
          accounts_id: 100,
          title_est: "Bank1",
          title_eng: "Bank1",
          cl_currencies_id: "EUR",
        },
      ],
    );
    bindIbanToDimension(maps, "EE11", 1);
    const out = tx({
      id: 1,
      type: "D",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
    });
    const inn = tx({
      id: 2,
      type: "C",
      amount: 50,
      date: "2025-06-01",
      accounts_dimensions_id: 2,
      bank_account_no: "EE11",
    });
    expect(findTransferPairs([out, inn], maps, 1).pairs).toHaveLength(0);

    const innFar = tx({
      id: 3,
      type: "C",
      amount: 100,
      date: "2025-07-01",
      accounts_dimensions_id: 2,
      bank_account_no: "EE11",
    });
    maps.dimensionToAccountsId.set(2, 200);
    expect(findTransferPairs([out, innFar], maps, 1).pairs).toHaveLength(0);

    const innNoSignal = tx({
      id: 4,
      type: "C",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 2,
      bank_account_no: "FOREIGN",
    });
    expect(findTransferPairs([out, innNoSignal], maps, 1).pairs).toHaveLength(0);
  });

  it("findOneSidedTransfers and journal index helpers", () => {
    const maps = buildOwnBankMaps(
      [
        { account_name_est: "Bank1", account_no: "1", iban_code: "EE11" },
        { account_name_est: "Bank2", account_no: "2", iban_code: "EE22" },
      ],
      [
        {
          id: 1,
          accounts_id: 100,
          title_est: "Bank1",
          title_eng: "Bank1",
          cl_currencies_id: "EUR",
        },
        {
          id: 2,
          accounts_id: 200,
          title_est: "Bank2",
          title_eng: "Bank2",
          cl_currencies_id: "EUR",
        },
      ],
    );
    bindIbanToDimension(maps, "EE11", 1);
    bindIbanToDimension(maps, "EE22", 2);

    const one = tx({
      id: 9,
      type: "D",
      amount: 40,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
      bank_account_no: "EE22",
    });
    const sided = findOneSidedTransfers([one], maps, undefined, undefined, new Set());
    expect(sided).toHaveLength(1);
    expect(sided[0].targetDimensionId).toBe(2);

    const byName = tx({
      id: 10,
      type: "C",
      amount: 10,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
      bank_account_name: "My Company OÜ deposit",
    });
    const named = findOneSidedTransfers([byName], maps, "My Company OÜ", undefined, new Set());
    expect(named[0]?.targetDimensionId).toBe(2);

    const targeted = findOneSidedTransfers([byName], maps, "My Company OÜ", 2, new Set([10]));
    expect(targeted).toHaveLength(0);

    expect(buildAccountDistribution({ amount: 12 }, 200, 2)).toEqual({
      related_table: "accounts",
      related_id: 200,
      related_sub_id: 2,
      amount: 12,
    });

    const key = journalTransferKey(1, 2, 100, "2025-06-01");
    expect(key).toBe(journalTransferKey(2, 1, 100, "2025-06-01"));

    const journals: Journal[] = [
      {
        effective_date: "2025-06-01",
        registered: true,
        postings: [
          { accounts_id: 100, accounts_dimensions_id: 1, amount: 100, type: "D" },
          { accounts_id: 200, accounts_dimensions_id: 2, amount: 100, type: "C" },
        ],
      },
      {
        effective_date: "2025-06-02",
        is_deleted: true,
        postings: [],
      },
      {
        effective_date: "2025-06-03",
        postings: [{ accounts_id: 100, accounts_dimensions_id: 1, amount: 1, type: "D" }],
      },
    ];
    const idx = indexInterAccountJournals(journals, maps);
    expect(isAlreadyJournalizedTransfer(1, 2, 100, "2025-06-01", idx)).toBe(true);
    expect(isAlreadyJournalizedTransfer(1, 2, 100, "2025-06-09", idx)).toBe(false);

    const sameType: Journal[] = [
      {
        effective_date: "2025-06-01",
        postings: [
          { accounts_id: 100, accounts_dimensions_id: 1, amount: 100, type: "D" },
          { accounts_id: 200, accounts_dimensions_id: 2, amount: 100, type: "D" },
        ],
      },
      {
        effective_date: "2025-06-01",
        postings: [
          { accounts_id: 100, accounts_dimensions_id: 1, amount: 100, type: "D", is_deleted: true },
          { accounts_id: 200, accounts_dimensions_id: 2, amount: 100, type: "C" },
        ],
      },
    ];
    expect(indexInterAccountJournals(sameType, maps).size).toBe(0);

    const byTarget = findOneSidedTransfers(
      [
        tx({
          id: 99,
          type: "C",
          amount: 5,
          date: "2025-06-01",
          accounts_dimensions_id: 1,
          bank_account_name: "Acme Holdings payment",
        }),
      ],
      maps,
      "Acme Holdings",
      2,
      new Set(),
    );
    expect(byTarget[0]?.targetDimensionId).toBe(2);

    maps.dimensionToAccountsId.delete(2);
    expect(
      findOneSidedTransfers(
        [
          tx({
            id: 98,
            type: "D",
            amount: 5,
            date: "2025-06-01",
            accounts_dimensions_id: 1,
            bank_account_no: "EE22",
          }),
        ],
        maps,
        undefined,
        undefined,
        new Set(),
      ),
    ).toHaveLength(0);
  });

  it("skips same-dimension legs and already-used incoming", () => {
    const maps = buildOwnBankMaps(
      [
        { account_name_est: "Bank1", account_no: "1", iban_code: "EE11" },
        { account_name_est: "Bank2", account_no: "2", iban_code: "EE22" },
      ],
      [
        {
          id: 1,
          accounts_id: 100,
          title_est: "Bank1",
          title_eng: "Bank1",
          cl_currencies_id: "EUR",
        },
        {
          id: 2,
          accounts_id: 200,
          title_est: "Bank2",
          title_eng: "Bank2",
          cl_currencies_id: "EUR",
        },
      ],
    );
    bindIbanToDimension(maps, "EE11", 1);
    bindIbanToDimension(maps, "EE22", 2);
    const sameDim = findTransferPairs(
      [
        tx({
          id: 1,
          type: "D",
          amount: 100,
          date: "2025-06-01",
          accounts_dimensions_id: 1,
          bank_account_no: "EE22",
        }),
        tx({
          id: 2,
          type: "C",
          amount: 100,
          date: "2025-06-01",
          accounts_dimensions_id: 1,
          bank_account_no: "EE11",
        }),
      ],
      maps,
      1,
    );
    expect(sameDim.pairs).toHaveLength(0);

    const out1 = tx({
      id: 10,
      type: "D",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
      bank_account_no: "EE22",
    });
    const out2 = tx({
      id: 11,
      type: "D",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
      bank_account_no: "EE22",
    });
    const inn = tx({
      id: 12,
      type: "C",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 2,
      bank_account_no: "EE11",
    });
    const multi = findTransferPairs([out1, out2, inn], maps, 1);
    expect(multi.pairs).toHaveLength(1);
  });

  it("company-name match with multiple other banks needs explicit target", () => {
    const maps = buildOwnBankMaps(
      [
        { account_name_est: "Bank1", account_no: "1", iban_code: "EE11" },
        { account_name_est: "Bank2", account_no: "2", iban_code: "EE22" },
        { account_name_est: "Bank3", account_no: "3", iban_code: "EE33" },
      ],
      [
        {
          id: 1,
          accounts_id: 100,
          title_est: "Bank1",
          title_eng: "Bank1",
          cl_currencies_id: "EUR",
        },
        {
          id: 2,
          accounts_id: 200,
          title_est: "Bank2",
          title_eng: "Bank2",
          cl_currencies_id: "EUR",
        },
        {
          id: 3,
          accounts_id: 300,
          title_est: "Bank3",
          title_eng: "Bank3",
          cl_currencies_id: "EUR",
        },
      ],
    );
    bindIbanToDimension(maps, "EE11", 1);
    bindIbanToDimension(maps, "EE22", 2);
    bindIbanToDimension(maps, "EE33", 3);
    expect(
      findOneSidedTransfers(
        [
          tx({
            id: 1,
            type: "D",
            amount: 5,
            date: "2025-06-01",
            accounts_dimensions_id: 1,
            bank_account_name: "Acme Holdings",
          }),
        ],
        maps,
        "Acme Holdings",
        undefined,
        new Set(),
      ),
    ).toHaveLength(0);
  });

  it("one-sided skips when target equals source dimension", () => {
    const maps = buildOwnBankMaps(
      [{ account_name_est: "Bank1", account_no: "1", iban_code: "EE11" }],
      [
        {
          id: 1,
          accounts_id: 100,
          title_est: "Bank1",
          title_eng: "Bank1",
          cl_currencies_id: "EUR",
        },
      ],
    );
    bindIbanToDimension(maps, "EE11", 1);
    expect(
      findOneSidedTransfers(
        [
          tx({
            id: 1,
            type: "D",
            amount: 5,
            date: "2025-06-01",
            accounts_dimensions_id: 1,
            bank_account_name: "Acme Holdings",
          }),
        ],
        maps,
        "Acme Holdings",
        1,
        new Set(),
      ),
    ).toHaveLength(0);
  });

  it("skips pair candidates when target accounts id missing", () => {
    const maps = buildOwnBankMaps(
      [
        { account_name_est: "Bank1", account_no: "1", iban_code: "EE11" },
        { account_name_est: "Bank2", account_no: "2", iban_code: "EE22" },
      ],
      [
        {
          id: 1,
          accounts_id: 100,
          title_est: "Bank1",
          title_eng: "Bank1",
          cl_currencies_id: "EUR",
        },
        {
          id: 2,
          accounts_id: 200,
          title_est: "Bank2",
          title_eng: "Bank2",
          cl_currencies_id: "EUR",
        },
      ],
    );
    bindIbanToDimension(maps, "EE11", 1);
    bindIbanToDimension(maps, "EE22", 2);
    maps.dimensionToAccountsId.delete(2);
    const out = tx({
      id: 1,
      type: "D",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
      bank_account_no: "EE22",
    });
    const inn = tx({
      id: 2,
      type: "C",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 2,
      bank_account_no: "EE11",
    });
    expect(findTransferPairs([out, inn], maps, 1).pairs).toHaveLength(0);
  });

  it("pairs with date gap and base amount; skips used incoming", () => {
    const maps = buildOwnBankMaps(
      [
        { account_name_est: "Bank1", account_no: "1", iban_code: "EE11" },
        { account_name_est: "Bank2", account_no: "2", iban_code: "EE22" },
      ],
      [
        {
          id: 1,
          accounts_id: 100,
          title_est: "Bank1",
          title_eng: "Bank1",
          cl_currencies_id: "EUR",
        },
        {
          id: 2,
          accounts_id: 200,
          title_est: "Bank2",
          title_eng: "Bank2",
          cl_currencies_id: "EUR",
        },
      ],
    );
    bindIbanToDimension(maps, "EE11", 1);
    bindIbanToDimension(maps, "EE22", 2);

    const out = tx({
      id: 1,
      type: "D",
      amount: 110,
      base_amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
      bank_account_no: "EE22",
    });
    const inn = tx({
      id: 2,
      type: "C",
      amount: 105,
      base_amount: 100,
      date: "2025-06-02",
      accounts_dimensions_id: 2,
      bank_account_no: "EE11",
    });
    const { pairs } = findTransferPairs([out, inn], maps, 1);
    expect(pairs[0]?.reasons).toContain("exact_base_amount");
    expect(pairs[0]?.reasons).toContain("date_within_gap");

    const outNoBase = tx({
      id: 3,
      type: "D",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 1,
      bank_account_no: "EE22",
    });
    const innNoBase = tx({
      id: 4,
      type: "C",
      amount: 100,
      date: "2025-06-01",
      accounts_dimensions_id: 2,
      bank_account_no: "EE11",
    });
    delete (outNoBase as { base_amount?: number }).base_amount;
    delete (innNoBase as { base_amount?: number }).base_amount;
    expect(findTransferPairs([outNoBase, innNoBase], maps, 1).pairs).toHaveLength(1);
  });
});
