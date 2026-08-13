import { describe, expect, it } from "vitest";
import type { Transaction } from "../types/transaction.js";
import {
  bankReferenceHash,
  buildCamtDescription,
  buildDuplicateIndex,
  DESCRIPTION_MAX_LEN,
  entryBatchKey,
  entryExactKey,
  entrySignatureHex,
  findExactDuplicate,
  findPossibleDuplicates,
  isTrustedCamtMarker,
  normalizeMatchText,
  stripCamtMarker,
  transactionTypeFromDirection,
} from "./camt053-duplicates.js";
import type { CamtEntry } from "./camt053-parser.js";

function entry(overrides: Partial<CamtEntry> = {}): CamtEntry {
  return {
    date: "2025-06-01",
    amount: 10,
    currency: "EUR",
    direction: "CRDT",
    bank_reference: "REF1",
    description: "Payment",
    counterparty_name: "Acme",
    counterparty_iban: "EE111",
    reference_number: "RF1",
    ...overrides,
  };
}

function tx(overrides: Partial<Transaction> & Pick<Transaction, "id">): Transaction {
  return {
    accounts_id: 1,
    accounts_dimensions_id: 9,
    clients_id: null,
    bank_accounts_id: 1,
    bank_ref_number: "REF1",
    bank_subtype: "",
    type: "C",
    bank_account_no: "EE111",
    bank_account_name: "Acme",
    ref_number: "RF1",
    amount: 10,
    cl_currencies_id: "EUR",
    description: "Payment",
    date: "2025-06-01",
    status: "CONFIRMED",
    is_deleted: false,
    currency_rate: 1,
    base_amount: 10,
    ...overrides,
  };
}

describe("camt053 duplicates helpers", () => {
  it("maps CAMT direction onto RIK C/D", () => {
    expect(transactionTypeFromDirection("CRDT")).toBe("C");
    expect(transactionTypeFromDirection("DBIT")).toBe("D");
  });

  it("hashes bank references stably", () => {
    expect(bankReferenceHash("REF1")).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(bankReferenceHash("REF1")).toBe(bankReferenceHash("REF1"));
  });

  it("strips and normalizes marker text", () => {
    const marked = `Hello ${buildCamtDescription(entry({ description: "" }))}`;
    expect(stripCamtMarker(marked).startsWith("Hello")).toBe(true);
    expect(normalizeMatchText("  Foo   BAR  ")).toBe("foo bar");
    expect(stripCamtMarker(null)).toBe("");
    expect(normalizeMatchText(undefined)).toBe("");
  });
});

describe("buildCamtDescription", () => {
  it("appends a trusted marker and stays within 150 chars", () => {
    const desc = buildCamtDescription(entry());
    expect(desc).toContain("[e-financials-mcp:camt");
    expect(desc).toContain("br=REF1");
    expect(desc).toContain("iban=EE111");
    expect(desc).toContain("sig=");
    expect(desc).not.toContain("brh=");
    expect(desc?.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LEN);
  });

  it("omits marker when both bank ref and IBAN are missing", () => {
    expect(
      buildCamtDescription(entry({ bank_reference: undefined, counterparty_iban: undefined })),
    ).toBe("Payment");
    expect(
      buildCamtDescription(
        entry({ description: undefined, bank_reference: undefined, counterparty_iban: undefined }),
      ),
    ).toBeUndefined();
    expect(
      buildCamtDescription(
        entry({
          description: "x".repeat(200),
          bank_reference: undefined,
          counterparty_iban: undefined,
        }),
      )?.length,
    ).toBe(DESCRIPTION_MAX_LEN);
  });

  it("uses brh when the plaintext bank reference would exceed the cap", () => {
    const longRef = "R".repeat(200);
    const desc = buildCamtDescription(
      entry({
        bank_reference: longRef,
        description: "User text",
        counterparty_iban: "EE123456789012345678",
      }),
    );
    expect(desc?.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LEN);
    expect(desc).toContain("brh=");
    expect(desc).not.toContain("br=");
  });

  it("uses brh only when both plaintext br and iban exceed the cap", () => {
    const desc = buildCamtDescription(
      entry({
        bank_reference: "R".repeat(200),
        counterparty_iban: "E".repeat(80),
        description: "X",
      }),
    );
    expect(desc).toContain("brh=");
    expect(desc).not.toContain("iban=");
    expect(desc).not.toContain("br=");
    expect(desc?.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LEN);
  });

  it("keeps plaintext br and drops iban when both together would exceed the cap", () => {
    const desc = buildCamtDescription(
      entry({
        bank_reference: "R".repeat(60),
        counterparty_iban: "E".repeat(40),
        description: "Note",
      }),
    );
    expect(desc).toContain("br=");
    expect(desc).not.toContain("iban=");
    expect(desc?.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LEN);
  });

  it("drops user text when the marker already fills the cap", () => {
    const desc = buildCamtDescription(
      entry({
        bank_reference: "R".repeat(100),
        counterparty_iban: undefined,
        description: "Payment",
      }),
    );
    expect(desc?.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LEN);
    expect(desc?.startsWith("[e-financials-mcp:camt")).toBe(true);
  });

  it("escapes user text that looks like a marker", () => {
    const desc = buildCamtDescription(entry({ description: "[e-financials-mcp:camt fake]" }));
    expect(desc?.startsWith("\\[e-financials-mcp:camt")).toBe(true);
  });

  it("returns marker-only when the user description is empty", () => {
    const desc = buildCamtDescription(entry({ description: "" }));
    expect(desc?.startsWith("[e-financials-mcp:camt")).toBe(true);
  });

  it("marks iban-only entries and falls back to sig when iban is huge", () => {
    const ibanOnly = buildCamtDescription(
      entry({ bank_reference: undefined, counterparty_iban: "EE111", description: "Pay" }),
    );
    expect(ibanOnly).toContain("iban=EE111");
    expect(ibanOnly).not.toContain("br=");
    const huge = buildCamtDescription(
      entry({
        bank_reference: undefined,
        counterparty_iban: "E".repeat(200),
        description: "Pay",
      }),
    );
    expect(huge).toContain("sig=");
    expect(huge).not.toContain("iban=");
  });
});

describe("findExactDuplicate", () => {
  it("matches an existing transaction by exact key", () => {
    const e = entry();
    const index = buildDuplicateIndex([tx({ id: 5 })], [e]);
    const hit = findExactDuplicate(e, index);
    expect(hit?.kind).toBe("exact");
    expect(hit?.transaction_ids).toEqual([5]);
  });

  it("falls back to bank-ref-only when exact fields differ", () => {
    const e = entry({ description: "New wording", counterparty_name: "Other" });
    const index = buildDuplicateIndex([tx({ id: 6, description: "Old wording" })], [e]);
    const hit = findExactDuplicate(e, index);
    expect(hit?.kind).toBe("bank_ref");
    expect(hit?.transaction_ids).toEqual([6]);
  });

  it("disables bank-ref fallback when the same ref appears twice in the file", () => {
    const a = entry();
    const b = entry({ amount: 20, description: "B" });
    const index = buildDuplicateIndex([tx({ id: 7 })], [a, b]);
    expect(findExactDuplicate(a, index)?.kind).toBe("exact");
    expect(findExactDuplicate(b, index)).toBeUndefined();
  });

  it("ignores VOID and deleted existing transactions", () => {
    const e = entry();
    const index = buildDuplicateIndex(
      [tx({ id: 1, status: "VOID" }), tx({ id: 2, is_deleted: true })],
      [e],
    );
    expect(findExactDuplicate(e, index)).toBeUndefined();
  });

  it("trusts a description marker when bank_ref_number is empty", () => {
    const e = entry();
    const marked = buildCamtDescription(e) as string;
    const stored = tx({
      id: 8,
      bank_ref_number: "",
      description: marked,
    });
    expect(isTrustedCamtMarker(stored)).toBe(true);
    const index = buildDuplicateIndex([stored], [e]);
    expect(findExactDuplicate(e, index)?.transaction_ids).toEqual([8]);
  });

  it("trusts alias marker keys and a brh-only marker", () => {
    const e = entry();
    const sig = entrySignatureHex(e);
    const brh = bankReferenceHash("REF1");
    const aliased = tx({
      id: 81,
      bank_ref_number: "",
      description: `Payment [e-financials-mcp:camt bank_ref_number=REF1 | bank_ref_hash=${brh} | bank_account_no=EE111 | entry_sig=${sig}]`,
    });
    expect(isTrustedCamtMarker(aliased)).toBe(true);

    const long = entry({ bank_reference: "R".repeat(200), description: "Payment" });
    const marked = buildCamtDescription(long) as string;
    const stored = tx({
      id: 82,
      bank_ref_number: "",
      amount: long.amount,
      bank_account_no: long.counterparty_iban ?? null,
      bank_account_name: long.counterparty_name ?? null,
      ref_number: long.reference_number ?? null,
      description: marked,
    });
    expect(isTrustedCamtMarker(stored)).toBe(true);
    expect(
      findExactDuplicate(long, buildDuplicateIndex([stored], [long]))?.transaction_ids,
    ).toEqual([82]);
  });

  it("does not trust an unsigned or tampered marker for bank-ref matching", () => {
    const e = entry({ description: "Changed" });
    const stored = tx({
      id: 9,
      bank_ref_number: "",
      description:
        "[e-financials-mcp:camt br=%ZZ | leftover | foo=bar | brh=sha256:dead | sig=0000]",
    });
    const index = buildDuplicateIndex([stored], [e]);
    expect(findExactDuplicate(e, index)).toBeUndefined();
    expect(isTrustedCamtMarker(stored)).toBe(false);
    expect(isTrustedCamtMarker(tx({ id: 91, bank_ref_number: "", description: "no marker" }))).toBe(
      false,
    );
  });
});

describe("findPossibleDuplicates", () => {
  it("reports review-only matches without a stored bank_ref_number", () => {
    const e = entry({ bank_reference: "NEW" });
    const stored = tx({
      id: 10,
      bank_ref_number: "",
      description: "Payment",
      accounts_dimensions_id: 9,
    });
    const index = buildDuplicateIndex([stored], [e], 9);
    const hits = findPossibleDuplicates(e, index);
    expect(hits[0]?.id).toBe(10);
    expect(hits[0]?.match_reasons).toEqual(
      expect.arrayContaining([
        "reference_number",
        "counterparty_iban",
        "counterparty_name",
        "description",
      ]),
    );
  });

  it("does not treat other dimensions as possible duplicates", () => {
    const e = entry();
    const stored = tx({ id: 11, bank_ref_number: "", accounts_dimensions_id: 99 });
    const index = buildDuplicateIndex([stored], [e], 9);
    expect(findPossibleDuplicates(e, index)).toEqual([]);
  });

  it("requires at least one field reason besides amount/date/type", () => {
    const e = entry({
      bank_reference: "NEW",
      reference_number: undefined,
      counterparty_iban: undefined,
      counterparty_name: undefined,
      description: undefined,
    });
    const stored = tx({
      id: 12,
      bank_ref_number: "",
      ref_number: null,
      bank_account_no: null,
      bank_account_name: null,
      description: "other",
    });
    expect(findPossibleDuplicates(e, buildDuplicateIndex([stored], [e], 9))).toEqual([]);

    const mismatch = tx({
      id: 14,
      bank_ref_number: "",
      ref_number: "OTHER",
      bank_account_no: "OTHER",
      bank_account_name: "OTHER",
      description: "OTHER",
    });
    expect(
      findPossibleDuplicates(
        entry({ bank_reference: "NEW" }),
        buildDuplicateIndex([mismatch], [entry({ bank_reference: "NEW" })], 9),
      ),
    ).toEqual([]);
  });

  it("indexes possible duplicates when dimension is unrestricted", () => {
    const e = entry({ bank_reference: "NEW" });
    const stored = tx({ id: 13, bank_ref_number: "" });
    const hits = findPossibleDuplicates(e, buildDuplicateIndex([stored], [e]));
    expect(hits[0]?.id).toBe(13);

    const noRef = entry({ bank_reference: undefined });
    buildDuplicateIndex([], [noRef]);
    const ibanOnly = entry({ bank_reference: undefined, description: "Payment" });
    const marked = buildCamtDescription(ibanOnly) as string;
    const storedIban = tx({
      id: 15,
      bank_ref_number: "",
      description: marked,
    });
    expect(isTrustedCamtMarker(storedIban)).toBe(false);
  });
});

describe("keys", () => {
  it("builds distinct batch keys for different amounts", () => {
    expect(entryBatchKey(entry({ amount: 1 }))).not.toBe(entryBatchKey(entry({ amount: 2 })));
    expect(entryExactKey(entry())).toContain("sha256:");
    expect(entryExactKey(entry({ bank_reference: undefined }))).not.toContain("sha256:");
    expect(entrySignatureHex(entry())).toHaveLength(16);
  });
});
