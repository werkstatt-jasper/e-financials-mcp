import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createMockClient } from "../tools/test-helpers.js";
import {
  fetchAllJournalListPages,
  JOURNAL_LIST_MAX_PAGES,
  JournalListTruncatedError,
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

  it("throws when max pages would truncate", async () => {
    vi.mocked(client.get).mockImplementation(async (_path, params) => {
      const page = Number(params?.page ?? 1);
      return {
        items: [{ id: page, effective_date: "2025-01-01", postings: [], registered: true }],
        current_page: page,
        total_pages: JOURNAL_LIST_MAX_PAGES + 5,
      } as never;
    });
    await expect(fetchAllJournalListPages(client)).rejects.toBeInstanceOf(
      JournalListTruncatedError,
    );
    expect(vi.mocked(client.get).mock.calls.length).toBe(JOURNAL_LIST_MAX_PAGES);
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
});
