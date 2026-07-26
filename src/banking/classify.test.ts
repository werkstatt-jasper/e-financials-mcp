import { describe, expect, it } from "vitest";
import type { Transaction } from "../types/transaction.js";
import {
  categorizeTransactionGroup,
  counterpartyKey,
  defaultBankFeeSuggestion,
  groupTransactions,
  resolveApplyMode,
} from "./classify.js";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    accounts_id: 100,
    accounts_dimensions_id: 10,
    clients_id: null,
    bank_accounts_id: 1,
    bank_ref_number: "",
    bank_subtype: "",
    type: "D",
    bank_account_no: null,
    bank_account_name: "Acme SaaS",
    ref_number: null,
    amount: 29,
    cl_currencies_id: "EUR",
    description: "Subscription",
    date: "2025-06-01",
    status: "PROJECT",
    is_deleted: false,
    currency_rate: 1,
    base_amount: 29,
    ...overrides,
  };
}

describe("classify helpers", () => {
  it("builds counterparty keys from name or description", () => {
    expect(counterpartyKey(tx({ bank_account_name: "  Foo  Bar " }))).toBe("foo bar");
    expect(counterpartyKey(tx({ bank_account_name: null, description: " lone " }))).toBe("lone");
    expect(counterpartyKey(tx({ bank_account_name: null, description: "" }))).toBe("unknown");
  });

  it("groups by counterparty", () => {
    const map = groupTransactions([
      tx({ id: 1, bank_account_name: "A" }),
      tx({ id: 2, bank_account_name: "A" }),
      tx({ id: 3, bank_account_name: "B" }),
    ]);
    expect(map.get("a")?.map((t) => t.id)).toEqual([1, 2]);
    expect(map.get("b")?.map((t) => t.id)).toEqual([3]);
  });

  it("categorizes bank fees, tax, owner, revenue, salary, saas, card, unknown", () => {
    expect(
      categorizeTransactionGroup("Swedbank", [tx({ description: "Monthly bank fee", amount: 3 })])
        .category,
    ).toBe("bank_fees");

    expect(
      categorizeTransactionGroup("EMTA", [tx({ description: "Tax payment" })]).apply_mode,
    ).toBe("review_only");

    expect(
      categorizeTransactionGroup("Owner", [tx({ description: "Owner dividend" })]).category,
    ).toBe("owner_transfers");

    expect(
      categorizeTransactionGroup("Customer", [
        tx({ type: "C", amount: 100, description: "Incoming" }),
      ]).category,
    ).toBe("revenue_without_invoice");

    expect(
      categorizeTransactionGroup("Mari Maasikas", [
        tx({
          bank_account_name: "Mari Maasikas",
          amount: 1200,
          date: "2025-05-01",
        }),
        tx({
          id: 2,
          bank_account_name: "Mari Maasikas",
          amount: 1200,
          date: "2025-06-01",
        }),
      ]).category,
    ).toBe("salary_payroll");

    expect(
      categorizeTransactionGroup("Notion Labs", [
        tx({ bank_account_name: "Notion Labs", amount: 10 }),
        tx({ id: 2, bank_account_name: "Notion Labs", amount: 10 }),
      ]).category,
    ).toBe("saas_subscriptions");

    expect(
      categorizeTransactionGroup("Bolt", [tx({ description: "Bolt ride card" })]).category,
    ).toBe("card_purchases");

    expect(categorizeTransactionGroup("Weird Co", [tx({ amount: 500 })]).category).toBe("unknown");
  });

  it("resolves apply mode from history and bank fees", () => {
    expect(resolveApplyMode("tax_payments", "review_only", null)).toBe("review_only");
    expect(resolveApplyMode("bank_fees", "purchase_invoice", null)).toBe("purchase_invoice");
    expect(
      resolveApplyMode("saas_subscriptions", "purchase_invoice", {
        clients_id: 1,
        client_name: "X",
        purchase_article_id: 23,
        vat_rate: 0,
        vat_amount: 0,
      }),
    ).toBe("purchase_invoice");
    expect(resolveApplyMode("saas_subscriptions", "purchase_invoice", null)).toBe("review_only");
  });

  it("builds default bank fee suggestion only with clients_id", () => {
    expect(defaultBankFeeSuggestion("Bank", null)).toBeNull();
    expect(defaultBankFeeSuggestion("Bank", 9)?.purchase_article_id).toBe(39);
  });

  it("handles empty groups and fee-only outgoing without bank name", () => {
    expect(categorizeTransactionGroup("x", []).category).toBe("unknown");
    expect(
      categorizeTransactionGroup("Misc", [
        tx({ bank_account_name: null, description: "Service fee", amount: 4 }),
      ]).category,
    ).toBe("bank_fees");
  });

  it("treats null bank_account_name as non-salary when recurring", () => {
    expect(
      categorizeTransactionGroup("unknown", [
        tx({ bank_account_name: null, description: "Payment", amount: 40 }),
        tx({
          id: 2,
          bank_account_name: null,
          description: "Payment",
          amount: 40,
          date: "2025-05-01",
        }),
      ]).category,
    ).toBe("saas_subscriptions");
  });
});
