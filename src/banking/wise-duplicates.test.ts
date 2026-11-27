import { describe, expect, it } from "vitest";
import type { Transaction } from "../types/transaction.js";
import {
  buildWiseDescription,
  buildWiseDuplicateIndex,
  canonicalWiseDescription,
  escapeWiseDescription,
  findWiseDuplicate,
  rememberWiseEntry,
  stripWiseMarker,
  WISE_DESCRIPTION_MAX_LEN,
  WISE_MARKER_PREFIX,
  type WiseImportEntry,
  wiseEntrySignatureHex,
} from "./wise-duplicates.js";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    accounts_id: 1,
    accounts_dimensions_id: 9,
    clients_id: null,
    bank_accounts_id: 1,
    bank_ref_number: "",
    bank_subtype: "",
    type: "C",
    bank_account_no: null,
    bank_account_name: "Example Customer OÜ",
    ref_number: "INV-1001",
    amount: 150,
    cl_currencies_id: "EUR",
    description: "old",
    date: "2026-03-01",
    status: "PROJECT",
    is_deleted: false,
    currency_rate: 1,
    base_amount: 150,
    ...overrides,
  };
}

function entry(overrides: Partial<WiseImportEntry> = {}): WiseImportEntry {
  return {
    wiseId: "TRF-1001",
    kind: "main",
    date: "2026-03-01",
    type: "C",
    amount: 150,
    currency: "EUR",
    counterparty: "Example Customer OÜ",
    reference: "INV-1001",
    description: "Example Customer OÜ",
    ...overrides,
  };
}

describe("Wise description markers", () => {
  it("appends a trusted marker and strips it back off", () => {
    const stored = buildWiseDescription(entry());
    expect(stored).toContain("Example Customer OÜ");
    expect(stored).toContain(WISE_MARKER_PREFIX);
    expect(stored).toContain("id=TRF-1001");
    expect(stored).toContain(`sig=${wiseEntrySignatureHex(entry())}`);
    expect(stripWiseMarker(stored)).toBe("Example Customer OÜ");
    expect(stripWiseMarker("")).toBe("");
    expect(stripWiseMarker(null)).toBe("");
  });

  it("escapes a spoofed marker in the human text", () => {
    const stored = buildWiseDescription(
      entry({ description: "Pay [e-financials-mcp:wise id=spoof] now" }),
    );
    expect(stored).toContain("\\[e-financials-mcp:wise");
    expect(escapeWiseDescription("[e-financials-mcp:wise x]")).toBe("\\[e-financials-mcp:wise x]");
  });

  it("shortens an oversized marker and can drop the human text when the budget is zero", () => {
    const longId = "W".repeat(80);
    const full = buildWiseDescription(entry({ wiseId: longId, description: "Merchant" }));
    expect(full.length).toBeLessThanOrEqual(150);
    expect(full).toContain("id=WWWWWWWWWWWWWWWWWWWWWWWW");

    const tight = buildWiseDescription(entry({ description: "" }), 20);
    expect(tight.startsWith(WISE_MARKER_PREFIX) || tight.length <= 20).toBe(true);
    expect(tight.length).toBeLessThanOrEqual(20);

    const noBudget = buildWiseDescription(entry({ description: "Hello" }), 10);
    expect(noBudget).not.toContain("Hello");
    expect(noBudget.length).toBeLessThanOrEqual(10);
  });
});

describe("duplicate index", () => {
  it("matches a trusted marker by Wise ID and kind, independently of fees", () => {
    const main = entry();
    const fee = entry({
      kind: "fee",
      type: "D",
      amount: 1.5,
      counterparty: "Wise",
      reference: undefined,
      description: "Wise fee",
    });
    const existing = [
      tx({ id: 11, description: buildWiseDescription(main) }),
      tx({
        id: 12,
        type: "D",
        amount: 1.5,
        bank_account_name: "Wise",
        ref_number: null,
        description: buildWiseDescription(fee),
      }),
    ];
    const index = buildWiseDuplicateIndex(existing);
    expect(findWiseDuplicate(main, index)?.reason).toMatch(/Wise ID match/);
    expect(findWiseDuplicate(fee, index)?.reason).toMatch(/Fee already imported \(Wise ID match\)/);
    expect(
      findWiseDuplicate(entry({ wiseId: "OTHER", description: "Someone else", amount: 9 }), index),
    ).toBeUndefined();
  });

  it("matches a marker-less prior row by date/amount/counterparty/reference", () => {
    const index = buildWiseDuplicateIndex([tx({ description: "Example Customer OÜ" })]);
    expect(findWiseDuplicate(entry(), index)?.reason).toMatch(/date\/amount\/counterparty/);
    expect(
      findWiseDuplicate(entry({ amount: 1.5, description: "Wise fee", kind: "fee" }), index)
        ?.reason,
    ).toBeUndefined();
  });

  it("trusts a marker that omits kind (defaults to main) and a missing description", () => {
    const main = entry();
    const sig = wiseEntrySignatureHex(main);
    const stored = `Example Customer OÜ [e-financials-mcp:wise id=TRF-1001 | sig=${sig}]`;
    const index = buildWiseDuplicateIndex([
      tx({ id: 21, description: stored }),
      tx({ id: 22, description: null as unknown as string, amount: 3, ref_number: "X" }),
    ]);
    expect(findWiseDuplicate(main, index)?.transaction_ids).toEqual([21]);
  });

  it("ignores VOID and deleted rows, and a tampered or malformed marker", () => {
    const good = buildWiseDescription(entry());
    const existing = [
      tx({ id: 2, status: "VOID", description: good }),
      tx({ id: 3, is_deleted: true, description: good }),
      tx({
        id: 4,
        description: "[e-financials-mcp:wise id=TRF-1001 | kind=main | sig=deadbeef]",
      }),
      tx({
        id: 5,
        description: "[e-financials-mcp:wise id=%E0%A4%A | kind=nope | foo bar | =x]",
      }),
    ];
    const index = buildWiseDuplicateIndex(existing);
    expect(findWiseDuplicate(entry(), index)).toBeUndefined();
  });

  it("remembers in-batch entries so a second copy is skipped", () => {
    const index = buildWiseDuplicateIndex([]);
    expect(findWiseDuplicate(entry(), index)).toBeUndefined();
    rememberWiseEntry(index, entry(), 99);
    expect(findWiseDuplicate(entry(), index)?.transaction_ids).toEqual([99]);
    const fee = entry({ kind: "fee", amount: 0.4, description: "Wise fee", counterparty: "Wise" });
    rememberWiseEntry(index, fee);
    expect(findWiseDuplicate(fee, index)?.reason).toMatch(/Fee already imported \(Wise ID match\)/);
  });

  it("does not treat the same amount in another currency as a duplicate", () => {
    const index = buildWiseDuplicateIndex([tx()]);
    expect(findWiseDuplicate(entry({ currency: "USD" }), index)).toBeUndefined();
  });

  it("matches a marker-less fee by date/amount/counterparty and dedups repeated ids", () => {
    const feeRow = tx({
      id: 15,
      type: "D",
      amount: 1.5,
      bank_account_name: "Wise",
      ref_number: null,
      description: "Wise fee",
    });
    const index = buildWiseDuplicateIndex([feeRow, feeRow]);
    expect(
      findWiseDuplicate(
        entry({
          kind: "fee",
          type: "D",
          amount: 1.5,
          counterparty: "Wise",
          reference: undefined,
          description: "Wise fee",
        }),
        index,
      ),
    ).toEqual({
      transaction_ids: [15],
      reason: "Fee already imported (date/amount/counterparty match)",
    });
    rememberWiseEntry(
      index,
      entry({ kind: "fee", amount: 1.5, description: "Wise fee", counterparty: "Wise" }),
      15,
    );
    expect(index.byIdKind.get("fee:TRF-1001")).toEqual([15]);
  });

  it("round-trips a 100+ character description through the marker and signature fallback", () => {
    const description =
      "Fictional Merchant With An Extraordinarily Long Counterparty Name LLC (Shopping) [38.64 EUR @ 0.92] extra padding to exceed one hundred characters";
    expect(description.length).toBeGreaterThan(100);
    const longEntry = entry({
      counterparty: "Fictional Merchant With An Extraordinarily Long Counterparty Name LLC",
      description,
    });
    const stored = buildWiseDescription(longEntry);
    expect(stored.length).toBeLessThanOrEqual(WISE_DESCRIPTION_MAX_LEN);
    const truncated = stripWiseMarker(stored);
    expect(truncated).toBe(canonicalWiseDescription(longEntry));
    expect(truncated.length).toBeLessThan(description.length);
    expect(stored).toContain(`sig=${wiseEntrySignatureHex(longEntry)}`);

    const markedIndex = buildWiseDuplicateIndex([
      tx({
        bank_account_name: longEntry.counterparty ?? null,
        description: stored,
      }),
    ]);
    expect(findWiseDuplicate(longEntry, markedIndex)?.reason).toMatch(/Wise ID match/);

    const strippedIndex = buildWiseDuplicateIndex([
      tx({
        bank_account_name: longEntry.counterparty ?? null,
        description: truncated,
      }),
    ]);
    expect(findWiseDuplicate(longEntry, strippedIndex)?.reason).toMatch(
      /date\/amount\/counterparty/,
    );

    const remembered = buildWiseDuplicateIndex([]);
    rememberWiseEntry(remembered, longEntry, 77);
    expect(findWiseDuplicate(longEntry, remembered)?.transaction_ids).toEqual([77]);
  });
});
