import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createMockClient } from "../tools/test-helpers.js";
import {
  fetchAllJournalListPages,
  JOURNAL_LIST_MAX_PAGES,
  JOURNAL_LIST_PAGE_CONCURRENCY,
  JournalListTruncatedError,
  journalListMaxPagesFromEnv,
  loadJournalsWithPostings,
} from "./load-journals.js";

describe("fetchAllJournalListPages", () => {
  let client: EFinancialsClient;

  beforeEach(() => {
    client = createMockClient();
  });

  it("collects all pages", async () => {
    vi.mocked(client.get).mockImplementation(async (_path, params) => {
      const page = Number(params?.page ?? 1);
      return {
        items: [{ id: page, effective_date: "2025-01-01", postings: [], registered: true }],
        current_page: page,
        total_pages: 2,
      } as never;
    });
    const rows = await fetchAllJournalListPages(client, {
      start_date: "2025-01-01",
      end_date: "2025-12-31",
    });
    expect(rows).toHaveLength(2);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/journals",
      expect.objectContaining({ start_date: "2025-01-01", end_date: "2025-12-31", page: 1 }),
    );
  });

  function pagedJournals(totalPages: number | ((page: number) => number)) {
    vi.mocked(client.get).mockImplementation(async (_path, params) => {
      const page = Number(params?.page ?? 1);
      return {
        items: [{ id: page, effective_date: "2025-01-01", postings: [], registered: true }],
        current_page: page,
        total_pages: typeof totalPages === "function" ? totalPages(page) : totalPages,
      } as never;
    });
  }

  it("fetches more than 100 pages, in page order", async () => {
    pagedJournals(150);
    const rows = await fetchAllJournalListPages(client);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(client.get).toHaveBeenCalledTimes(150);
  });

  it("keeps page order when later pages resolve first", async () => {
    vi.mocked(client.get).mockImplementation(async (_path, params) => {
      const page = Number(params?.page ?? 1);
      await new Promise((resolve) => setTimeout(resolve, (10 - page) * 2));
      return {
        items: [{ id: page, effective_date: "2025-01-01", postings: [], registered: true }],
        current_page: page,
        total_pages: 6,
      } as never;
    });
    const rows = await fetchAllJournalListPages(client);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("limits concurrent page requests", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(client.get).mockImplementation(async (_path, params) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return {
        items: [],
        current_page: Number(params?.page ?? 1),
        total_pages: 20,
      } as never;
    });
    await fetchAllJournalListPages(client);
    expect(peak).toBe(JOURNAL_LIST_PAGE_CONCURRENCY);
    expect(client.get).toHaveBeenCalledTimes(20);
  });

  it("follows a total_pages that grows during the load", async () => {
    pagedJournals((page) => (page < 3 ? 3 : 7));
    const rows = await fetchAllJournalListPages(client);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("throws after page 1 when total_pages exceeds the default cap", async () => {
    pagedJournals(JOURNAL_LIST_MAX_PAGES + 5);
    const err = await fetchAllJournalListPages(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JournalListTruncatedError);
    expect((err as JournalListTruncatedError).code).toBe("journal_list_truncated");
    expect((err as Error).message).toContain(
      `Journal list has ${JOURNAL_LIST_MAX_PAGES + 5} API pages, more than the limit of ${JOURNAL_LIST_MAX_PAGES} (RIK_JOURNAL_LIST_MAX_PAGES)`,
    );
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("throws when a later page pushes total_pages over the cap", async () => {
    pagedJournals((page) => (page === 1 ? 3 : 50));
    await expect(fetchAllJournalListPages(client, undefined, { maxPages: 10 })).rejects.toThrow(
      "Journal list has 50 API pages, more than the limit of 10",
    );
    expect(client.get).toHaveBeenCalledTimes(3);
  });

  it("accepts exactly maxPages pages", async () => {
    pagedJournals(3);
    const rows = await fetchAllJournalListPages(client, undefined, { maxPages: 3 });
    expect(rows).toHaveLength(3);
  });

  it("treats a maxPages below 1 as 1", async () => {
    pagedJournals(2);
    await expect(fetchAllJournalListPages(client, undefined, { maxPages: 0 })).rejects.toThrow(
      "more than the limit of 1",
    );
  });

  it("uses RIK_JOURNAL_LIST_MAX_PAGES as the cap", async () => {
    vi.stubEnv("RIK_JOURNAL_LIST_MAX_PAGES", "2");
    try {
      pagedJournals(3);
      await expect(fetchAllJournalListPages(client)).rejects.toThrow("more than the limit of 2");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the legacy default message on JournalListTruncatedError", () => {
    expect(new JournalListTruncatedError().message).toContain(
      `Journal list exceeded ${JOURNAL_LIST_MAX_PAGES} API pages`,
    );
  });
});

describe("journalListMaxPagesFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 2000 so a full-year ledger of ~1508 pages fits", () => {
    expect(JOURNAL_LIST_MAX_PAGES).toBe(2000);
  });

  it.each([
    [undefined, JOURNAL_LIST_MAX_PAGES],
    ["", JOURNAL_LIST_MAX_PAGES],
    ["  ", JOURNAL_LIST_MAX_PAGES],
    ["abc", JOURNAL_LIST_MAX_PAGES],
    ["0", JOURNAL_LIST_MAX_PAGES],
    ["-3", JOURNAL_LIST_MAX_PAGES],
    ["2.5", JOURNAL_LIST_MAX_PAGES],
    ["250", 250],
    [" 5000 ", 5000],
  ])("RIK_JOURNAL_LIST_MAX_PAGES=%s gives %s", (raw, expected) => {
    if (raw === undefined) {
      vi.stubEnv("RIK_JOURNAL_LIST_MAX_PAGES", undefined as unknown as string);
    } else {
      vi.stubEnv("RIK_JOURNAL_LIST_MAX_PAGES", raw);
    }
    expect(journalListMaxPagesFromEnv()).toBe(expected);
  });
});

describe("loadJournalsWithPostings", () => {
  let client: EFinancialsClient;

  beforeEach(() => {
    client = createMockClient();
  });

  it("hydrates journals with empty postings", async () => {
    vi.mocked(client.get).mockImplementation(async (path) => {
      if (path === "/v1/journals") {
        return {
          items: [
            { id: 1, effective_date: "2025-01-01", postings: [], registered: true },
            {
              id: 2,
              effective_date: "2025-01-02",
              registered: true,
              postings: [
                { accounts_id: 1, type: "D", amount: 1 },
                { accounts_id: 2, type: "C", amount: 1 },
              ],
            },
          ],
          current_page: 1,
          total_pages: 1,
        } as never;
      }
      if (path === "/v1/journals/1") {
        return {
          id: 1,
          effective_date: "2025-01-01",
          registered: true,
          postings: [
            { accounts_id: 1, type: "D", amount: 10 },
            { accounts_id: 2, type: "C", amount: 10 },
          ],
        } as never;
      }
      throw new Error(`unexpected ${path}`);
    });

    const rows = await loadJournalsWithPostings(client);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.postings).toHaveLength(2);
    expect(rows[1]?.postings).toHaveLength(2);
    expect(client.get).toHaveBeenCalledWith("/v1/journals/1");
  });

  it("skips hydrate when all list rows already have postings", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [
        {
          id: 1,
          effective_date: "2025-01-01",
          registered: true,
          postings: [{ accounts_id: 1, type: "D", amount: 1 }],
        },
      ],
      current_page: 1,
      total_pages: 1,
    } as never);
    const rows = await loadJournalsWithPostings(client, { start_date: "2025-01-01" });
    expect(rows).toHaveLength(1);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("passes end_date only and tolerates null items / default page metadata", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: null,
    } as never);
    const rows = await loadJournalsWithPostings(client, { end_date: "2025-12-31" });
    expect(rows).toEqual([]);
    expect(client.get).toHaveBeenCalledWith(
      "/v1/journals",
      expect.objectContaining({ end_date: "2025-12-31", page: 1 }),
    );
  });

  it("keeps list row when hydrate response lacks id", async () => {
    vi.mocked(client.get).mockImplementation(async (path) => {
      if (path === "/v1/journals") {
        return {
          items: [{ id: 1, effective_date: "2025-01-01", postings: [], registered: true }],
          current_page: 1,
          total_pages: 1,
        } as never;
      }
      if (path === "/v1/journals/1") {
        return {
          effective_date: "2025-01-01",
          registered: true,
          postings: [{ accounts_id: 1, type: "D", amount: 1 }],
        } as never;
      }
      throw new Error(path);
    });
    const rows = await loadJournalsWithPostings(client);
    expect(rows[0]?.postings).toEqual([]);
  });

  it("passes maxPages through to the list fetch", async () => {
    vi.mocked(client.get).mockResolvedValue({
      items: [],
      current_page: 1,
      total_pages: 3,
    } as never);
    await expect(loadJournalsWithPostings(client, { maxPages: 2 })).rejects.toBeInstanceOf(
      JournalListTruncatedError,
    );
  });
});
