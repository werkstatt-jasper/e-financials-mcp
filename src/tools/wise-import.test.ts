import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWiseDescription, type WiseImportEntry } from "../banking/wise-duplicates.js";
import type { EFinancialsClient } from "../client.js";
import type { AccountDimension } from "../types/accounts.js";
import type { Transaction } from "../types/transaction.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";
import {
  createWiseImportTools,
  normalizeWiseImportFilePath,
  resolveWiseFeeAccountDimensionId,
} from "./wise-import.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/wise");

function filePath(csv: string): string {
  return `base64:csv:${Buffer.from(csv, "utf8").toString("base64")}`;
}

function fixtureFile(name: string): string {
  return filePath(readFileSync(join(fixtures, name), "utf8"));
}

const bankDimension: AccountDimension = {
  id: 9,
  accounts_id: 1000,
  title_est: "Wise",
  title_eng: "Wise",
  cl_currencies_id: "EUR",
};

const feeDimension: AccountDimension = {
  id: 20,
  accounts_id: 8610,
  title_est: "Muud finantskulud",
  title_eng: "Other financial expenses",
  cl_currencies_id: "EUR",
};

function existingTx(overrides: Partial<Transaction> = {}): Transaction {
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

describe("resolveWiseFeeAccountDimensionId", () => {
  it("uses the provided id, auto-detects a unique 8610 dimension, and errors otherwise", () => {
    expect(resolveWiseFeeAccountDimensionId([bankDimension, feeDimension], 20, 9)).toBe(20);
    expect(resolveWiseFeeAccountDimensionId([bankDimension, feeDimension], undefined, 9)).toBe(20);
    expect(() => resolveWiseFeeAccountDimensionId([bankDimension, feeDimension], 99, 9)).toThrow(
      /was not found/,
    );
    expect(() => resolveWiseFeeAccountDimensionId([bankDimension], undefined, 9)).toThrow(
      /No unique dimension for account 8610/,
    );
    const second: AccountDimension = { ...feeDimension, id: 21 };
    expect(() =>
      resolveWiseFeeAccountDimensionId([bankDimension, feeDimension, second], undefined, 9),
    ).toThrow(/multiple dimensions \(20, 21\)/);
  });
});

describe("normalizeWiseImportFilePath", () => {
  it("leaves paths and explicit hints alone, and adds csv to a bare base64 payload", () => {
    expect(normalizeWiseImportFilePath("/tmp/wise.csv")).toBe("/tmp/wise.csv");
    expect(normalizeWiseImportFilePath("base64:csv:abc")).toBe("base64:csv:abc");
    expect(normalizeWiseImportFilePath("base64:xml:abc")).toBe("base64:xml:abc");
    expect(normalizeWiseImportFilePath("base64:abc")).toBe("base64:csv:abc");
  });
});

describe("import_wise_transactions", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createWiseImportTools>;

  function mockLookups(
    existing: Array<{ id: number }> = [],
    incomingIds: number[] = [],
    dimensions: AccountDimension[] = [bankDimension, feeDimension],
    /** Outgoing ids that must appear on the one-day list so stored direction can be confirmed. */
    outgoingIds: number[] = [],
  ) {
    vi.mocked(client.getAllPages).mockImplementation(async (path, params) => {
      if (path === "/v1/transactions") {
        if (params?.type !== undefined) {
          return incomingIds.map((id) => ({ id, type: "C" })) as never;
        }
        const oneDay = params?.start_date != null && params.start_date === params.end_date;
        if (!oneDay) {
          return existing as never;
        }
        const listed = new Set(existing.map((row) => row.id));
        const extras = [...incomingIds, ...outgoingIds]
          .filter((id) => !listed.has(id))
          .map((id) => ({ id, type: "C" as const }));
        return [...existing, ...extras] as never;
      }
      if (path === "/v1/account_dimensions") {
        return dimensions as never;
      }
      throw new Error(`unexpected getAllPages ${path}`);
    });
  }

  beforeEach(() => {
    client = createMockClient();
    tools = createWiseImportTools(client);
    mockLookups();
  });

  it("dry-runs the EUR fixture as type C and never writes", async () => {
    const result = await tools.import_wise_transactions.handler({
      file_path: fixtureFile("eur-incoming.csv"),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as {
      mode: string;
      results: Array<{
        status: string;
        type: string;
        amount: number;
        currency: string;
        wise_id: string;
        stored_description?: string;
      }>;
      summary: { created_count: number; eligible_rows: number };
    };
    expect(data.mode).toBe("DRY_RUN");
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({
      status: "would_create",
      wise_id: "TRF-1001",
      type: "C",
      amount: 150,
      currency: "EUR",
    });
    expect(data.results[0]?.stored_description).toContain("[e-financials-mcp:wise");
    expect(data.results[0]?.stored_description).toContain("id=TRF-1001");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("splits a USD card payment and its fee, deriving the EUR rate from the amounts", async () => {
    const result = await tools.import_wise_transactions.handler({
      file_path: fixtureFile("usd-card-payment.csv"),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as {
      fee_account_dimensions_id?: number;
      results: Array<{
        kind: string;
        type: string;
        amount: number;
        currency: string;
        currency_rate?: number;
        base_amount?: number;
        description: string;
      }>;
    };
    expect(data.fee_account_dimensions_id).toBe(20);
    expect(data.results[0]).toMatchObject({
      kind: "main",
      type: "D",
      amount: 42,
      currency: "USD",
      currency_rate: 0.92,
      base_amount: 38.64,
    });
    expect(data.results[0]?.description).toContain("Fictional Merchant Inc");
    expect(data.results[0]?.description).toContain("[38.64 EUR @ 0.92]");
    expect(data.results[1]).toMatchObject({
      kind: "fee",
      type: "D",
      amount: 1.5,
      currency: "USD",
      currency_rate: 0.92,
      base_amount: 1.38,
      description: "Wise fee",
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("skips Jar transfers by default and can include them when asked", async () => {
    const skipped = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("jars-and-filters.csv"),
        accounts_dimensions_id: 9,
      }),
    ) as {
      results: Array<{ wise_id: string; kind: string }>;
      skipped: Array<{ wise_id?: string; reason: string }>;
      summary: { filtered_out: number; skipped_count: number; created_count: number };
    };
    expect(skipped.results.map((row) => `${row.kind}:${row.wise_id}`)).toEqual([
      "main:EUR-4004",
      "fee:FEE:EUR-4004",
    ]);
    expect(skipped.skipped.map((row) => row.wise_id).sort()).toEqual([
      "JAR-3003",
      "NOTE-3005",
      "REF-3006",
    ]);
    expect(skipped.summary.filtered_out).toBe(3);
    expect(client.post).not.toHaveBeenCalled();

    const included = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("jars-and-filters.csv"),
        accounts_dimensions_id: 9,
        skip_jar_transfers: false,
      }),
    ) as { results: Array<{ wise_id: string; kind: string }>; summary: { filtered_out: number } };
    expect(included.summary.filtered_out).toBe(3);
    expect(included.results.some((row) => row.wise_id === "JAR-3003")).toBe(true);
    expect(included.results.some((row) => row.wise_id === "NOTE-3005")).toBe(true);
  });

  it("filters by date and skips a missing Wise id", async () => {
    const header =
      "ID,Status,Direction,Source amount (after fees),Target amount (after fees),Exchange rate,Created on,Finished on,Source name,Target name";
    const csv = `${header}
,COMPLETED,OUT,11,11,1,2026-03-10 10:00:00,2026-03-10 10:00:00,A,B
KEEP,COMPLETED,OUT,12,12,1,2026-03-11 10:00:00,2026-03-11 10:00:00,A,B
OLD,COMPLETED,OUT,13,13,1,2026-02-01 10:00:00,2026-02-01 10:00:00,A,B
FUTURE,COMPLETED,OUT,14,14,1,2026-04-01 10:00:00,2026-04-01 10:00:00,A,B
`;
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: filePath(csv),
        accounts_dimensions_id: 9,
        date_from: "2026-03-01",
        date_to: "2026-03-31",
      }),
    ) as {
      results: Array<{ wise_id: string }>;
      skipped: Array<{ reason: string }>;
      summary: { filtered_out: number };
    };
    expect(data.results.map((row) => row.wise_id)).toEqual(["KEEP"]);
    expect(data.skipped.some((row) => row.reason.includes("Missing Wise transaction ID"))).toBe(
      true,
    );
    expect(data.summary.filtered_out).toBe(2);
  });

  it("does not require a fee account when only filtered-out rows have fees", async () => {
    mockLookups([], [], [bankDimension]);
    const header =
      "ID,Status,Direction,Source amount (after fees),Target amount (after fees),Exchange rate,Created on,Source fee amount,Source fee currency,Category";
    const csv = `${header}
OLD,COMPLETED,OUT,10,10,1,2026-01-01 10:00:00,2,EUR,General
JAR,COMPLETED,OUT,5,5,1,2026-03-01 10:00:00,1,EUR,Jar
`;
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: filePath(csv),
        accounts_dimensions_id: 9,
        date_from: "2026-03-01",
        date_to: "2026-03-31",
      }),
    ) as { fee_account_dimensions_id?: number; results: unknown[]; skipped: unknown[] };
    expect(data.fee_account_dimensions_id).toBeUndefined();
    expect(data.results).toHaveLength(0);
    expect(data.skipped).toHaveLength(1);
  });

  it("skips exact and in-batch duplicates, including a marker-less prior row", async () => {
    const main: WiseImportEntry = {
      wiseId: "TRF-1001",
      kind: "main",
      date: "2026-03-01",
      type: "C",
      amount: 150,
      currency: "EUR",
      counterparty: "Example Customer OÜ",
      reference: "INV-1001",
      description: "Example Customer OÜ",
    };
    mockLookups([existingTx({ id: 11, description: buildWiseDescription(main) })], [11]);
    const marked = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("eur-incoming.csv"),
        accounts_dimensions_id: 9,
      }),
    ) as {
      skipped: Array<{ reason: string; duplicate_transaction_ids?: number[] }>;
      results: unknown[];
    };
    expect(marked.results).toHaveLength(0);
    expect(marked.skipped[0]).toMatchObject({
      reason: "Already imported (Wise ID match)",
      duplicate_transaction_ids: [11],
    });

    mockLookups(
      [
        existingTx({
          description: "Example Customer OÜ",
          bank_account_name: "Example Customer OÜ",
        }),
      ],
      [1],
    );
    const legacy = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("eur-incoming.csv"),
        accounts_dimensions_id: 9,
      }),
    ) as { skipped: Array<{ reason: string }> };
    expect(legacy.skipped[0]?.reason).toMatch(/date\/amount\/counterparty/);

    const header =
      "ID,Status,Direction,Source amount (after fees),Target amount (after fees),Exchange rate,Created on,Source name,Target name";
    const batch = `${header}
DUP,COMPLETED,OUT,10,10,1,2026-03-12 10:00:00,A,B
DUP,COMPLETED,OUT,10,10,1,2026-03-12 10:00:00,A,B
`;
    mockLookups([]);
    const batched = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: filePath(batch),
        accounts_dimensions_id: 9,
      }),
    ) as {
      results: unknown[];
      skipped: Array<{ reason: string }>;
      summary: { created_count: number };
    };
    expect(batched.summary.created_count).toBe(1);
    expect(batched.skipped[0]?.reason).toMatch(/Already imported/);
  });

  it("can still create a missing fee when the main transaction already exists", async () => {
    const main: WiseImportEntry = {
      wiseId: "CARD-2002",
      kind: "main",
      date: "2026-03-02",
      type: "D",
      amount: 42,
      currency: "USD",
      counterparty: "Fictional Merchant Inc",
      reference: "CARD-2002",
      description: "Fictional Merchant Inc (Shopping) [38.64 EUR @ 0.92]",
    };
    mockLookups([
      existingTx({
        id: 50,
        type: "D",
        date: "2026-03-02",
        amount: 42,
        cl_currencies_id: "USD",
        bank_account_name: "Fictional Merchant Inc",
        ref_number: "CARD-2002",
        description: buildWiseDescription(main),
      }),
    ]);
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("usd-card-payment.csv"),
        accounts_dimensions_id: 9,
      }),
    ) as {
      results: Array<{ kind: string; status: string }>;
      skipped: Array<{ kind?: string; reason: string }>;
    };
    expect(data.skipped.some((row) => row.reason.includes("Already imported"))).toBe(true);
    expect(data.results).toEqual([
      expect.objectContaining({ kind: "fee", status: "would_create" }),
    ]);
  });

  it("does not treat VOID rows as duplicates, or the same amount in another currency", async () => {
    mockLookups([
      existingTx({ status: "VOID", description: "Example Customer OÜ" }),
      existingTx({
        id: 8,
        type: "C",
        amount: 150,
        cl_currencies_id: "USD",
        date: "2026-03-01",
        bank_account_name: "Example Customer OÜ",
        ref_number: "INV-1001",
        description: "Example Customer OÜ",
      }),
    ]);
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("eur-incoming.csv"),
        accounts_dimensions_id: 9,
      }),
    ) as { results: Array<{ status: string }>; skipped: unknown[] };
    expect(data.results[0]?.status).toBe("would_create");
    expect(data.skipped).toHaveLength(0);
  });

  it("executes main and fee creates, and skips the fee when the main create fails", async () => {
    mockLookups([], [], [bankDimension, feeDimension], [101, 102]);
    vi.mocked(client.get)
      .mockResolvedValueOnce({ id: 101, type: "C", status: "PROJECT" } as never)
      .mockResolvedValueOnce({ id: 102, type: "C", status: "PROJECT" } as never);
    vi.mocked(client.post)
      .mockResolvedValueOnce({ id: 101, messages: ["Outgoing payment has been saved."] } as never)
      .mockResolvedValueOnce({ id: 102, messages: ["Outgoing payment has been saved."] } as never);

    const created = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("usd-card-payment.csv"),
        accounts_dimensions_id: 9,
        execute: true,
      }),
    ) as {
      mode: string;
      results: Array<{
        status: string;
        kind: string;
        api_id?: number;
        type: string;
        direction_confirmed?: boolean;
      }>;
      summary: { created_count: number; direction_unconfirmed_count: number };
    };
    expect(created.mode).toBe("EXECUTED");
    expect(created.results).toEqual([
      expect.objectContaining({
        status: "created",
        kind: "main",
        api_id: 101,
        type: "D",
        direction_confirmed: true,
      }),
      expect.objectContaining({
        status: "created",
        kind: "fee",
        api_id: 102,
        type: "D",
        direction_confirmed: true,
      }),
    ]);
    expect(client.post).toHaveBeenCalledTimes(2);
    const mainBody = vi.mocked(client.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(mainBody).toMatchObject({
      type: "C",
      amount: 42,
      cl_currencies_id: "USD",
      currency_rate: 0.92,
      base_amount: 38.64,
    });
    expect(mainBody.description).toContain("[e-financials-mcp:wise");

    mockLookups([]);
    vi.mocked(client.post).mockReset();
    vi.mocked(client.post).mockRejectedValueOnce(new Error("boom"));
    const failed = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("usd-card-payment.csv"),
        accounts_dimensions_id: 9,
        execute: true,
      }),
    ) as {
      results: unknown[];
      errors: Array<{ kind?: string; message: string }>;
      skipped: Array<{ reason: string }>;
      summary: { error_count: number };
    };
    expect(failed.results).toHaveLength(0);
    expect(failed.errors[0]).toMatchObject({ kind: "main", message: "boom" });
    expect(failed.skipped[0]?.reason).toMatch(/main transaction was not created/);
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("records an unconfirmed direction and a fee-row create error", async () => {
    mockLookups([], []);
    vi.mocked(client.get).mockResolvedValue({ id: 201, type: "C", status: "PROJECT" } as never);
    vi.mocked(client.post)
      .mockResolvedValueOnce({ id: 201, messages: ["Saved."] } as never)
      .mockRejectedValueOnce(new Error("fee failed"));
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("usd-card-payment.csv"),
        accounts_dimensions_id: 9,
        execute: true,
      }),
    ) as {
      results: Array<{ direction_confirmed?: boolean }>;
      errors: Array<{ kind?: string; message: string }>;
      summary: { direction_unconfirmed_count: number; error_count: number };
    };
    expect(data.results[0]?.direction_confirmed).toBe(false);
    expect(data.summary.direction_unconfirmed_count).toBe(1);
    expect(data.errors[0]).toMatchObject({ kind: "fee", message: "fee failed" });
  });

  it("skips a fee that is already present and reports read_back_error when the draft cannot be re-read", async () => {
    const fee: WiseImportEntry = {
      wiseId: "CARD-2002",
      kind: "fee",
      date: "2026-03-02",
      type: "D",
      amount: 1.5,
      currency: "USD",
      counterparty: "Wise",
      description: "Wise fee",
    };
    mockLookups(
      [
        existingTx({
          id: 77,
          type: "D",
          date: "2026-03-02",
          amount: 1.5,
          cl_currencies_id: "USD",
          bank_account_name: "Wise",
          ref_number: null,
          description: buildWiseDescription(fee),
        }),
      ],
      [],
      [bankDimension, feeDimension],
      [301],
    );
    vi.mocked(client.get).mockRejectedValue(new Error("gone"));
    vi.mocked(client.post).mockResolvedValue({ id: 301, messages: ["Saved."] } as never);
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("usd-card-payment.csv"),
        accounts_dimensions_id: 9,
        execute: true,
      }),
    ) as {
      results: Array<{ kind: string; read_back_error?: string }>;
      skipped: Array<{ kind?: string; reason: string }>;
    };
    expect(data.results[0]?.kind).toBe("main");
    expect(data.results[0]?.read_back_error).toMatch(/could not be read back/);
    expect(data.skipped[0]?.reason).toMatch(/Fee already imported/);
  });

  it("counts an unconfirmed fee direction when the one-day list does not include the fee row", async () => {
    mockLookups([], [], [bankDimension, feeDimension], [401]);
    vi.mocked(client.get).mockResolvedValue({ id: 401, type: "C", status: "PROJECT" } as never);
    vi.mocked(client.post)
      .mockResolvedValueOnce({ id: 401, messages: ["Saved."] } as never)
      .mockResolvedValueOnce({ id: 402, messages: ["Saved."] } as never);
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: fixtureFile("usd-card-payment.csv"),
        accounts_dimensions_id: 9,
        execute: true,
      }),
    ) as {
      results: Array<{ kind: string; direction_confirmed?: boolean; api_id?: number }>;
      summary: { direction_unconfirmed_count: number };
    };
    expect(data.results[0]).toMatchObject({ kind: "main", api_id: 401, direction_confirmed: true });
    expect(data.results[1]).toMatchObject({ kind: "fee", api_id: 402, direction_confirmed: false });
    expect(data.summary.direction_unconfirmed_count).toBe(1);
  });

  it("rejects bad input, a missing bank dimension, and an inverted date range", async () => {
    await expect(tools.import_wise_transactions.handler({})).rejects.toThrow(/file_path/);
    await expect(
      tools.import_wise_transactions.handler({
        file_path: fixtureFile("eur-incoming.csv"),
      }),
    ).rejects.toThrow(/accounts_dimensions_id/);
    await expect(
      tools.import_wise_transactions.handler({
        file_path: "base64:xml:PHg+PC94Pg==",
        accounts_dimensions_id: 9,
      }),
    ).rejects.toThrow(/must be CSV/);
    await expect(
      tools.import_wise_transactions.handler({
        file_path: fixtureFile("eur-incoming.csv"),
        accounts_dimensions_id: 9,
        date_from: "2026-03-31",
        date_to: "2026-03-01",
      }),
    ).rejects.toThrow(/date_from must be on or before date_to/);
    await expect(
      tools.import_wise_transactions.handler({
        file_path: fixtureFile("eur-incoming.csv"),
        accounts_dimensions_id: 99,
      }),
    ).rejects.toThrow(/accounts_dimensions_id 99 was not found/);
    await expect(
      tools.import_wise_transactions.handler({
        file_path: fixtureFile("usd-card-payment.csv"),
        accounts_dimensions_id: 9,
        fee_account_dimensions_id: 123,
      }),
    ).rejects.toThrow(/fee_account_dimensions_id 123 was not found/);
  });

  it("imports a nameless, unreferenced EUR row", async () => {
    const header =
      "ID,Status,Direction,Source amount (after fees),Target amount (after fees),Exchange rate,Created on,Source name,Target name,Reference,Category";
    const csv = `${header}
BARE-1,COMPLETED,OUT,6,6,1,2026-03-16 10:00:00,,,,General
`;
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: filePath(csv),
        accounts_dimensions_id: 9,
      }),
    ) as {
      results: Array<{ counterparty?: string; ref_number?: string; stored_description?: string }>;
    };
    expect(data.results[0]?.counterparty).toBeUndefined();
    expect(data.results[0]?.ref_number).toBeUndefined();
    expect(data.results[0]?.stored_description).toContain("[e-financials-mcp:wise");
  });

  it("splits a same-currency USD fee without inventing an EUR rate", async () => {
    const header =
      "ID,Status,Direction,Source amount (after fees),Target amount (after fees),Exchange rate,Created on,Source fee amount,Source fee currency,Source currency,Target currency,Source name,Target name,Reference";
    const csv = `${header}
USD-1,COMPLETED,OUT,25,25,1,2026-03-15 10:00:00,0.75,USD,USD,USD,Example Holder OÜ,Fictional Cafe,
`;
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: filePath(csv),
        accounts_dimensions_id: 9,
      }),
    ) as {
      results: Array<{
        kind: string;
        currency: string;
        currency_rate?: number;
        base_amount?: number;
      }>;
    };
    expect(data.results[0]).toMatchObject({ kind: "main", currency: "USD" });
    expect(data.results[0]?.currency_rate).toBeUndefined();
    expect(data.results[1]).toMatchObject({ kind: "fee", currency: "USD" });
    expect(data.results[1]?.currency_rate).toBeUndefined();
    expect(data.results[1]?.base_amount).toBeUndefined();
  });

  it("uses an incoming target-side fee and an explicit fee dimension", async () => {
    const header = [
      "ID",
      "Status",
      "Direction",
      "Created on",
      "Finished on",
      "Source fee amount",
      "Source fee currency",
      "Target fee amount",
      "Target fee currency",
      "Source name",
      "Source amount (after fees)",
      "Source currency",
      "Target name",
      "Target amount (after fees)",
      "Target currency",
      "Exchange rate",
      "Reference",
      "Category",
      "Note",
    ].join(",");
    const csv = `${header}
fx-in-1,COMPLETED,IN,2026-01-16 09:00:00,2026-01-16 09:00:00,0,USD,2,EUR,Customer Inc,100,USD,Example Holder OÜ,92,EUR,0.92,PAY-FX-IN,General,
`;
    const extraFee: AccountDimension = { ...feeDimension, id: 21 };
    mockLookups([], [], [bankDimension, feeDimension, extraFee]);
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: filePath(csv),
        accounts_dimensions_id: 9,
        fee_account_dimensions_id: 21,
      }),
    ) as {
      fee_account_dimensions_id?: number;
      results: Array<{ kind: string; type: string; amount: number; currency: string }>;
    };
    expect(data.fee_account_dimensions_id).toBe(21);
    expect(data.results[0]).toMatchObject({
      kind: "main",
      type: "C",
      amount: 92,
      currency: "EUR",
    });
    expect(data.results[1]).toMatchObject({
      kind: "fee",
      type: "D",
      amount: 2,
      currency: "EUR",
    });
  });

  it("accepts a bare base64: payload and an explicit base64:csv: payload", async () => {
    const csv = readFileSync(join(fixtures, "eur-incoming.csv"), "utf8");
    const encoded = Buffer.from(csv, "utf8").toString("base64");
    const bare = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: `base64:${encoded}`,
        accounts_dimensions_id: 9,
      }),
    ) as { mode: string; results: Array<{ wise_id: string }> };
    expect(bare.mode).toBe("DRY_RUN");
    expect(bare.results[0]?.wise_id).toBe("TRF-1001");

    const hinted = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: `base64:csv:${encoded}`,
        accounts_dimensions_id: 9,
      }),
    ) as { results: Array<{ wise_id: string }> };
    expect(hinted.results[0]?.wise_id).toBe("TRF-1001");
  });

  it("skips a zero-amount main row and still creates the fee", async () => {
    const header =
      "ID,Status,Direction,Source amount (after fees),Target amount (after fees),Exchange rate,Source fee amount,Source fee currency,Target fee amount,Created on,Finished on,Source name,Target name,Source currency,Target currency";
    const csv = `${header}
ZERO-FEE,COMPLETED,OUT,0,0,1,1.5,EUR,0,2026-03-01 10:00:00,2026-03-01 10:00:00,Holder,Payee,EUR,EUR
`;
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: filePath(csv),
        accounts_dimensions_id: 9,
      }),
    ) as {
      results: Array<{
        status: string;
        kind: string;
        wise_id: string;
        amount: number;
        type: string;
      }>;
      summary: { created_count: number; eligible_rows: number };
    };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({
      status: "would_create",
      kind: "fee",
      wise_id: "FEE:ZERO-FEE",
      amount: 1.5,
      type: "D",
    });
    expect(data.summary.created_count).toBe(1);
    expect(data.summary.eligible_rows).toBe(1);
  });

  it("counts short CSV rows in filtered_out", async () => {
    const header =
      "ID,Status,Direction,Source amount (after fees),Target amount (after fees),Exchange rate,Created on,Finished on,Source name,Target name";
    const csv = `${header}
only-one-field
KEEP,COMPLETED,OUT,12,12,1,2026-03-11 10:00:00,2026-03-11 10:00:00,A,B
`;
    const data = parseToolJson(
      await tools.import_wise_transactions.handler({
        file_path: filePath(csv),
        accounts_dimensions_id: 9,
      }),
    ) as {
      results: Array<{ wise_id: string }>;
      summary: {
        total_csv_rows: number;
        filtered_out: number;
        eligible_rows: number;
        created_count: number;
      };
    };
    expect(data.summary.total_csv_rows).toBe(2);
    expect(data.summary.filtered_out).toBe(1);
    expect(data.summary.eligible_rows).toBe(1);
    expect(data.summary.created_count).toBe(1);
    expect(data.results[0]?.wise_id).toBe("KEEP");
  });
});
