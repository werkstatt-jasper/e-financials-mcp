import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CamtEntry } from "../banking/camt053-parser.js";
import type { EFinancialsClient } from "../client.js";
import type { AccountDimension } from "../types/accounts.js";
import type { Client } from "../types/clients.js";
import type { Transaction } from "../types/transaction.js";
import { createCamt053Tools, matchClient } from "./camt053.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

function camtXml(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document>
  <BkToCstmrStmt>
    <Stmt>
      <Id>S1</Id>
      <Acct><Id><IBAN>EE123</IBAN></Id><Ccy>EUR</Ccy></Acct>
      ${entries}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

function ntry(opts: {
  amt: string;
  dir?: "CRDT" | "DBIT";
  date: string;
  ref?: string;
  name?: string;
  iban?: string;
  desc?: string;
  e2e?: string;
  coid?: string;
}): string {
  const dir = opts.dir ?? "CRDT";
  const party =
    dir === "CRDT"
      ? `<Dbtr><Nm>${opts.name ?? ""}</Nm>${
          opts.coid
            ? `<Id><OrgId><Othr><Id>${opts.coid}</Id><SchmeNm><Cd>COID</Cd></SchmeNm></Othr></OrgId></Id>`
            : ""
        }</Dbtr><DbtrAcct><Id><IBAN>${opts.iban ?? ""}</IBAN></Id></DbtrAcct>`
      : `<Cdtr><Nm>${opts.name ?? ""}</Nm></Cdtr><CdtrAcct><Id><IBAN>${opts.iban ?? ""}</IBAN></Id></CdtrAcct>`;
  return `<Ntry>
    <Amt Ccy="EUR">${opts.amt}</Amt>
    <CdtDbtInd>${dir}</CdtDbtInd>
    <BookgDt><Dt>${opts.date}</Dt></BookgDt>
    <AcctSvcrRef>${opts.ref ?? "R1"}</AcctSvcrRef>
    <NtryDtls><TxDtls>
      <Refs><EndToEndId>${opts.e2e ?? "E2E"}</EndToEndId></Refs>
      <RltdPties>${party}</RltdPties>
      <RmtInf><Ustrd>${opts.desc ?? "Note"}</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
  </Ntry>`;
}

function filePath(xml: string): string {
  return `base64:xml:${Buffer.from(xml, "utf8").toString("base64")}`;
}

const dimension: AccountDimension = {
  id: 9,
  accounts_id: 1000,
  title_est: "Pank",
  title_eng: "Bank",
  cl_currencies_id: "EUR",
};

const clientRow: Client = {
  id: 50,
  name: "Acme OÜ",
  reg_code: "11111111",
  vat_no: null,
  email: null,
  phone: null,
  address: null,
  city: null,
  postal_code: null,
  country_code: null,
  is_buyer: true,
  is_supplier: false,
  is_active: true,
  bank_account: null,
  bank_name: null,
  payment_term_days: null,
};

function existingTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    accounts_id: 1,
    accounts_dimensions_id: 9,
    clients_id: null,
    bank_accounts_id: 1,
    bank_ref_number: "EXISTING",
    bank_subtype: "",
    type: "C",
    bank_account_no: null,
    bank_account_name: null,
    ref_number: null,
    amount: 99,
    cl_currencies_id: "EUR",
    description: "old",
    date: "2025-01-01",
    status: "PROJECT",
    is_deleted: false,
    currency_rate: 1,
    base_amount: 99,
    ...overrides,
  };
}

describe("matchClient", () => {
  const clients: Client[] = [clientRow, { ...clientRow, id: 51, name: "Beta", reg_code: "222" }];

  it("matches by reg code, exact name, and unique fuzzy name", () => {
    expect(
      matchClient({ counterparty_reg_code: "11111111" } as CamtEntry, clients)?.match_type,
    ).toBe("reg_code");
    expect(matchClient({ counterparty_name: "Acme OÜ" } as CamtEntry, clients)?.match_type).toBe(
      "exact_name",
    );
    expect(
      matchClient({ counterparty_name: "Beta Industries" } as CamtEntry, [
        { ...clientRow, id: 51, name: "Beta", reg_code: null },
      ])?.match_type,
    ).toBe("single_name_match");
    expect(matchClient({} as CamtEntry, clients)).toBeUndefined();
    expect(matchClient({ counterparty_name: "Nope" } as CamtEntry, clients)).toBeUndefined();
    expect(
      matchClient(
        { counterparty_reg_code: "000", counterparty_name: "Acme OÜ" } as CamtEntry,
        clients,
      )?.match_type,
    ).toBe("exact_name");
    expect(
      matchClient({ counterparty_name: "Acme OÜ" } as CamtEntry, [
        clientRow,
        { ...clientRow, id: 99, name: "Acme OÜ", reg_code: "x" },
      ]),
    ).toBeUndefined();
    expect(
      matchClient({ counterparty_name: "Ac" } as CamtEntry, [
        { ...clientRow, id: 1, name: "Acme" },
        { ...clientRow, id: 2, name: "Acmee", reg_code: "x" },
      ]),
    ).toBeUndefined();
  });
});

describe("process_camt053", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createCamt053Tools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createCamt053Tools(client);
    vi.mocked(client.getAllPages).mockImplementation(async (path) => {
      if (path === "/v1/transactions") {
        return [] as never;
      }
      if (path === "/v1/account_dimensions") {
        return [dimension] as never;
      }
      if (path === "/v1/clients") {
        return [clientRow] as never;
      }
      throw new Error(`unexpected getAllPages ${path}`);
    });
  });

  it("defaults to parse and flags duplicates without writing", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path) => {
      if (path === "/v1/transactions") {
        return [
          existingTx({
            bank_ref_number: "R1",
            amount: 10,
            date: "2025-06-01",
            bank_account_name: "Acme OÜ",
            bank_account_no: "EE9",
            ref_number: "E2E",
            description: "Note",
          }),
        ] as never;
      }
      return [] as never;
    });
    const xml = camtXml(
      ntry({ amt: "10", date: "2025-06-01", ref: "R1", name: "Acme OÜ", iban: "EE9" }),
    );
    const result = await tools.process_camt053.handler({ file_path: filePath(xml) });
    const data = parseToolJson(result) as {
      mode: string;
      summary: { duplicate_count: number };
      entries: Array<{ duplicate?: boolean }>;
    };
    expect(data.mode).toBe("parse");
    expect(data.summary.duplicate_count).toBe(1);
    expect(data.entries[0]?.duplicate).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("dry_run would_create and never POSTs", async () => {
    const xml = camtXml(
      ntry({
        amt: "12.3",
        date: "2025-06-02",
        ref: "NEW",
        name: "Acme OÜ",
        iban: "EE9",
        coid: "11111111",
      }),
    );
    const result = await tools.process_camt053.handler({
      mode: "dry_run",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as {
      mode: string;
      results: Array<{
        status: string;
        client_match?: string;
        type: string;
        stored_description?: string;
      }>;
      summary: { created_count: number };
    };
    expect(data.mode).toBe("DRY_RUN");
    expect(data.results[0]?.status).toBe("would_create");
    expect(data.results[0]?.client_match).toBe("reg_code");
    expect(data.results[0]?.type).toBe("C");
    expect(data.results[0]?.stored_description).toContain("iban=EE9");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("execute creates PROJECT transactions and continues after per-entry errors", async () => {
    vi.mocked(client.post)
      .mockResolvedValueOnce({ id: 101 } as never)
      .mockRejectedValueOnce(new Error("boom"));
    const xml = camtXml(
      `${ntry({ amt: "1", date: "2025-06-01", ref: "A", name: "Acme OÜ" })}
       ${ntry({ amt: "2", date: "2025-06-02", ref: "B", dir: "DBIT", name: "Other" })}`,
    );
    const result = await tools.process_camt053.handler({
      mode: "execute",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as {
      mode: string;
      results: Array<{ status: string; api_id?: number; type: string }>;
      errors: Array<{ message: string }>;
      summary: { created_count: number; error_count: number };
    };
    expect(data.mode).toBe("EXECUTED");
    expect(data.results[0]).toMatchObject({ status: "created", api_id: 101, type: "C" });
    expect(data.errors[0]?.message).toBe("boom");
    expect(data.summary.created_count).toBe(1);
    expect(data.summary.error_count).toBe(1);
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.post).mock.calls[0]?.[0]).toBe("/v1/transactions");
    const body = vi.mocked(client.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.bank_ref_number).toBe("A");
    expect(body.type).toBe("C");
  });

  it("skips exact duplicates and in-batch duplicates on import", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path) => {
      if (path === "/v1/transactions") {
        return [
          existingTx({
            bank_ref_number: "DUP",
            amount: 5,
            date: "2025-06-01",
            description: "Note",
            bank_account_name: "X",
            bank_account_no: "EE1",
            ref_number: "E2E",
          }),
        ] as never;
      }
      if (path === "/v1/account_dimensions") {
        return [dimension] as never;
      }
      if (path === "/v1/clients") {
        return [] as never;
      }
      return [] as never;
    });
    const xml = camtXml(
      `${ntry({ amt: "5", date: "2025-06-01", ref: "DUP", name: "X", iban: "EE1" })}
       ${ntry({ amt: "8", date: "2025-06-03", ref: "BATCH", name: "Y" })}
       ${ntry({ amt: "8", date: "2025-06-03", ref: "BATCH", name: "Y" })}`,
    );
    const result = await tools.process_camt053.handler({
      mode: "dry_run",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as {
      skipped: Array<{ reason: string }>;
      results: unknown[];
      summary: { skipped_count: number; created_count: number };
    };
    expect(data.summary.skipped_count).toBe(2);
    expect(data.summary.created_count).toBe(1);
    expect(data.skipped.some((s) => s.reason.includes("Existing"))).toBe(true);
    expect(data.skipped.some((s) => s.reason.includes("batch"))).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("filters by date range and reports possible duplicates", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path) => {
      if (path === "/v1/transactions") {
        return [
          existingTx({
            id: 77,
            bank_ref_number: "",
            amount: 15,
            date: "2025-06-10",
            description: "Same note",
            accounts_dimensions_id: 9,
          }),
        ] as never;
      }
      if (path === "/v1/account_dimensions") {
        return [dimension] as never;
      }
      if (path === "/v1/clients") {
        return [] as never;
      }
      return [] as never;
    });
    const xml = camtXml(
      `${ntry({ amt: "15", date: "2025-06-10", ref: "P1", desc: "Same note" })}
       ${ntry({ amt: "1", date: "2025-05-01", ref: "OLD" })}`,
    );
    const result = await tools.process_camt053.handler({
      mode: "dry_run",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
      date_from: "2025-06-01",
      date_to: "2025-06-30",
    });
    const data = parseToolJson(result) as {
      summary: { eligible_entries: number; filtered_out: number; possible_duplicate_count: number };
      possible_duplicates: unknown[];
    };
    expect(data.summary.eligible_entries).toBe(1);
    expect(data.summary.filtered_out).toBe(1);
    expect(data.summary.possible_duplicate_count).toBe(1);
  });

  it("execute records possible duplicates against the new api id", async () => {
    vi.mocked(client.getAllPages).mockImplementation(async (path) => {
      if (path === "/v1/transactions") {
        return [
          existingTx({
            id: 77,
            bank_ref_number: "",
            amount: 15,
            date: "2025-06-10",
            description: "Same note",
          }),
        ] as never;
      }
      if (path === "/v1/account_dimensions") {
        return [dimension] as never;
      }
      if (path === "/v1/clients") {
        return [] as never;
      }
      return [] as never;
    });
    vi.mocked(client.post).mockResolvedValue({ created_object_id: 500 } as never);
    const xml = camtXml(ntry({ amt: "15", date: "2025-06-10", ref: "P1", desc: "Same note" }));
    const result = await tools.process_camt053.handler({
      mode: "execute",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as {
      possible_duplicates: Array<{ new_transaction_api_id?: number }>;
    };
    expect(data.possible_duplicates[0]?.new_transaction_api_id).toBe(500);
  });

  it("filters parse mode by date_from/date_to", async () => {
    const xml = camtXml(
      `${ntry({ amt: "1", date: "2025-05-01", ref: "OLD" })}
       ${ntry({ amt: "2", date: "2025-06-15", ref: "IN" })}`,
    );
    const result = await tools.process_camt053.handler({
      file_path: filePath(xml),
      date_from: "2025-06-01",
      date_to: "2025-06-30",
    });
    const data = parseToolJson(result) as { entries: unknown[]; summary: { entry_count: number } };
    expect(data.entries).toHaveLength(1);
    expect(data.summary.entry_count).toBe(1);
  });

  it("includes debit totals in parse summary", async () => {
    const xml = camtXml(ntry({ amt: "4", date: "2025-06-01", ref: "OUT", dir: "DBIT" }));
    const result = await tools.process_camt053.handler({ file_path: filePath(xml) });
    const data = parseToolJson(result) as {
      summary: { debit_count: number; debit_total: number; credit_count: number };
    };
    expect(data.summary).toMatchObject({ debit_count: 1, debit_total: 4, credit_count: 0 });
  });

  it("applies an open-ended date_from filter on dry_run", async () => {
    const xml = camtXml(
      `${ntry({ amt: "1", date: "2025-05-01", ref: "OLD" })}
       ${ntry({ amt: "2", date: "2025-06-15", ref: "IN" })}`,
    );
    const result = await tools.process_camt053.handler({
      mode: "dry_run",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
      date_from: "2025-06-01",
    });
    const data = parseToolJson(result) as { summary: { eligible_entries: number } };
    expect(data.summary.eligible_entries).toBe(1);
  });

  it("applies an open-ended date_to filter on dry_run", async () => {
    const xml = camtXml(
      `${ntry({ amt: "1", date: "2025-05-01", ref: "OLD" })}
       ${ntry({ amt: "2", date: "2025-06-15", ref: "IN" })}`,
    );
    const result = await tools.process_camt053.handler({
      mode: "dry_run",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
      date_to: "2025-05-31",
    });
    const data = parseToolJson(result) as { summary: { eligible_entries: number } };
    expect(data.summary.eligible_entries).toBe(1);
  });

  it("validates mode inputs", async () => {
    await expect(tools.process_camt053.handler({})).rejects.toThrow(/file_path/);
    await expect(
      tools.process_camt053.handler({
        mode: "dry_run",
        file_path: filePath(camtXml("")),
      }),
    ).rejects.toThrow(/accounts_dimensions_id/);
    await expect(
      tools.process_camt053.handler({
        mode: "dry_run",
        file_path: filePath(camtXml("")),
        accounts_dimensions_id: 9,
        date_from: "2025-06-30",
        date_to: "2025-06-01",
      }),
    ).rejects.toThrow(/date_from/);
    await expect(
      tools.process_camt053.handler({
        mode: "execute",
        file_path: filePath(camtXml("")),
        accounts_dimensions_id: 99,
      }),
    ).rejects.toThrow(/was not found/);
    await expect(
      tools.process_camt053.handler({
        file_path: `base64:csv:${Buffer.from("a,b").toString("base64")}`,
      }),
    ).rejects.toThrow(/XML/);
  });

  it("uses created_object_id fallback and string errors", async () => {
    vi.mocked(client.post)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce("fail-string");
    const xml = camtXml(
      `${ntry({ amt: "1", date: "2025-06-01", ref: "A" })}
       ${ntry({ amt: "2", date: "2025-06-02", ref: "B" })}`,
    );
    const result = await tools.process_camt053.handler({
      mode: "execute",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as {
      results: Array<{ api_id?: number }>;
      errors: Array<{ message: string }>;
    };
    expect(data.results[0]?.api_id).toBeUndefined();
    expect(data.errors[0]?.message).toBe("fail-string");
  });

  it("creates a payload without optional bank fields when they are absent", async () => {
    const xml = camtXml(`<Ntry>
      <Amt>1</Amt>
      <CdtDbtInd>CRDT</CdtDbtInd>
      <BookgDt><Dt>2025-06-01</Dt></BookgDt>
    </Ntry>`);
    const result = await tools.process_camt053.handler({
      mode: "dry_run",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as {
      results: Array<{ stored_description?: string; ref_number?: string; bank_reference?: string }>;
    };
    expect(data.results[0]?.stored_description).toBeUndefined();
    expect(data.results[0]?.ref_number).toBeUndefined();
    expect(data.results[0]?.bank_reference).toBeUndefined();
  });

  it("treats a non-object POST response as having no id", async () => {
    vi.mocked(client.post)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce("ok" as never);
    const xml = camtXml(
      `${ntry({ amt: "1", date: "2025-06-01", ref: "Z" })}
       ${ntry({ amt: "2", date: "2025-06-02", ref: "Y" })}`,
    );
    const result = await tools.process_camt053.handler({
      mode: "execute",
      file_path: filePath(xml),
      accounts_dimensions_id: 9,
    });
    const data = parseToolJson(result) as { results: Array<{ api_id?: number }> };
    expect(data.results).toHaveLength(2);
    expect(data.results[0]?.api_id).toBeUndefined();
    expect(data.results[1]?.api_id).toBeUndefined();
  });
});
