import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import journalsFixture from "../__fixtures__/journals.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import { createJournalTools } from "./journals.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("journal tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createJournalTools>;

  beforeEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
    client = createMockClient();
    tools = createJournalTools(client);
    vi.mocked(readFile).mockReset();
  });

  it("list_journals returns items and pagination", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...journalsFixture.list_paged } as never);

    const result = await tools.list_journals.handler({
      page: 2,
      modified_since: "2024-01-01T00:00:00Z",
      start_date: "2024-06-01",
      end_date: "2024-06-30",
    });
    expect(client.get).toHaveBeenCalledWith("/v1/journals", {
      page: 2,
      modified_since: "2024-01-01T00:00:00Z",
      start_date: "2024-06-01",
      end_date: "2024-06-30",
    });
    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toHaveLength(1);
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(2);
  });

  it("list_journals defaults pagination when API omits fields", async () => {
    vi.mocked(client.get).mockResolvedValue({ items: [] } as never);
    const result = await tools.list_journals.handler({});
    const data = parseToolJson(result) as { current_page: number; total_pages: number };
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(1);
  });

  it("list_journals coalesces missing items and falsy pagination", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: null,
      current_page: 0,
      total_pages: 0,
    } as never);
    const result = await tools.list_journals.handler({});
    const data = parseToolJson(result) as {
      items: unknown[];
      current_page: number;
      total_pages: number;
    };
    expect(data.items).toEqual([]);
    expect(data.current_page).toBe(1);
    expect(data.total_pages).toBe(1);
  });

  it("list_journals defaults items when property is absent", async () => {
    vi.mocked(client.get).mockResolvedValue({ current_page: 2, total_pages: 4 } as never);
    const result = await tools.list_journals.handler({});
    const data = parseToolJson(result) as { items: unknown[] };
    expect(data.items).toEqual([]);
  });

  it("get_journal fetches by journals_id", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...journalsFixture.single } as never);
    const result = await tools.get_journal.handler({ journals_id: 739 });
    expect(client.get).toHaveBeenCalledWith("/v1/journals/739");
    expect(parseToolJson(result)).toEqual(journalsFixture.single);
  });

  it("create_journal posts body with journals_id 0 on postings when omitted", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.create_journal.handler({
      effective_date: "2025-01-15",
      title: "Opening",
      postings: [
        { accounts_id: 100, amount: 50, type: "D" },
        { accounts_id: 200, amount: 50, type: "C" },
      ],
    });
    expect(client.post).toHaveBeenCalledWith("/v1/journals", {
      effective_date: "2025-01-15",
      title: "Opening",
      postings: [
        { accounts_id: 100, amount: 50, type: "D", journals_id: 0 },
        { accounts_id: 200, amount: 50, type: "C", journals_id: 0 },
      ],
    });
  });

  it("create_journal preserves explicit journals_id on postings", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.create_journal.handler({
      effective_date: "2025-01-15",
      postings: [{ journals_id: 99, accounts_id: 1, amount: 10, type: "D" }],
    });
    expect(client.post).toHaveBeenCalledWith("/v1/journals", {
      effective_date: "2025-01-15",
      postings: [{ journals_id: 99, accounts_id: 1, amount: 10, type: "D" }],
    });
  });

  it("create_journal leaves postings unchanged when not an array", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.create_journal.handler({
      effective_date: "2025-01-15",
      postings: "invalid" as unknown as { accounts_id: number; amount: number }[],
    });
    expect(client.post).toHaveBeenCalledWith("/v1/journals", {
      effective_date: "2025-01-15",
      postings: "invalid",
    });
  });

  it("create_journal keeps journals_id null on a posting line when provided", async () => {
    vi.mocked(client.post).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.create_journal.handler({
      effective_date: "2025-01-15",
      postings: [
        {
          journals_id: null as unknown as number,
          accounts_id: 1,
          amount: 10,
          type: "D",
        },
      ],
    });
    expect(client.post).toHaveBeenCalledWith("/v1/journals", {
      effective_date: "2025-01-15",
      postings: [
        {
          journals_id: null,
          accounts_id: 1,
          amount: 10,
          type: "D",
        },
      ],
    });
  });

  it("update_journal patches partial body and normalizes postings", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.update_journal.handler({
      journals_id: 739,
      title: "Renamed",
      postings: [{ accounts_id: 1, amount: 5, type: "D" }],
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/journals/739", {
      title: "Renamed",
      postings: [{ accounts_id: 1, amount: 5, type: "D", journals_id: 0 }],
    });
  });

  it("update_journal maps non-array postings to empty array via normalizePostingsForApi", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.update_journal.handler({
      journals_id: 10,
      postings: null as unknown as { accounts_id: number; amount: number }[],
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/journals/10", {
      postings: [],
    });
  });

  it("update_journal skips postings key when omitted", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.update_journal.handler({
      journals_id: 5,
      title: "Only title",
    });
    expect(client.patch).toHaveBeenCalledWith("/v1/journals/5", {
      title: "Only title",
    });
  });

  it("delete_journal deletes by id", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);
    await tools.delete_journal.handler({ journals_id: 739 });
    expect(client.delete).toHaveBeenCalledWith("/v1/journals/739");
  });

  it("register_journal patches register endpoint", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.register_journal.handler({ journals_id: 739 });
    expect(client.patch).toHaveBeenCalledWith("/v1/journals/739/register");
  });

  it("invalidate_journal patches invalidate endpoint", async () => {
    vi.mocked(client.patch).mockResolvedValue({ ...journalsFixture.api_ok } as never);
    await tools.invalidate_journal.handler({ journals_id: 739 });
    expect(client.patch).toHaveBeenCalledWith("/v1/journals/739/invalidate");
  });

  it("get_journal_file returns ApiFile JSON", async () => {
    vi.mocked(client.get).mockResolvedValue({ ...journalsFixture.api_file } as never);
    const result = await tools.get_journal_file.handler({ journals_id: 12 });
    expect(client.get).toHaveBeenCalledWith("/v1/journals/12/document_user");
    expect(parseToolJson(result)).toEqual(journalsFixture.api_file);
  });

  it("upload_journal_file reads file, encodes base64, and puts document", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("hello"));
    vi.mocked(client.put).mockResolvedValue({ ...journalsFixture.upload_put_ok } as never);

    const result = await tools.upload_journal_file.handler({
      journals_id: 55,
      file_path: "/tmp/scan.pdf",
    });

    expect(readFile).toHaveBeenCalledWith("/tmp/scan.pdf");
    expect(client.put).toHaveBeenCalledWith("/v1/journals/55/document_user", {
      name: "scan.pdf",
      contents: Buffer.from("hello").toString("base64"),
    });
    const data = parseToolJson(result) as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toContain("scan.pdf");
  });

  it("delete_journal_file deletes document_user", async () => {
    vi.mocked(client.delete).mockResolvedValue({ response_code: 0 } as never);
    await tools.delete_journal_file.handler({ journals_id: 12 });
    expect(client.delete).toHaveBeenCalledWith("/v1/journals/12/document_user");
  });

  it("propagates read errors from upload_journal_file", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    await expect(
      tools.upload_journal_file.handler({ journals_id: 1, file_path: "/nope" }),
    ).rejects.toThrow("ENOENT");
  });
});
