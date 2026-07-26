import type { EFinancialsClient } from "../client.js";
import type { Journal } from "../types/journal.js";

/** Match default EFinancialsClient maxPages; statements refuse silent truncation. */
export const JOURNAL_LIST_MAX_PAGES = 100;

const HYDRATE_CONCURRENCY = 5;

export class JournalListTruncatedError extends Error {
  readonly code = "journal_list_truncated";

  constructor(message?: string) {
    super(
      message ??
        `Journal list exceeded ${JOURNAL_LIST_MAX_PAGES} API pages. Narrow date_from/date_to and retry — financial statements refuse incomplete ledger loads.`,
    );
    this.name = "JournalListTruncatedError";
  }
}

function hasPostings(journal: Journal): boolean {
  return Array.isArray(journal.postings) && journal.postings.length > 0;
}

/**
 * Page through /v1/journals; throw if the client page cap would under-report.
 */
export async function fetchAllJournalListPages(
  client: EFinancialsClient,
  params?: { start_date?: string; end_date?: string },
): Promise<Journal[]> {
  const allItems: Journal[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await client.get<Journal>("/v1/journals", {
      ...params,
      page,
    });
    if (response.items) {
      allItems.push(...(response.items as Journal[]));
    }
    const currentPage = response.current_page || page;
    const totalPages = response.total_pages || 1;
    hasMore = currentPage < totalPages;
    if (hasMore && page >= JOURNAL_LIST_MAX_PAGES) {
      throw new JournalListTruncatedError();
    }
    page++;
  }

  return allItems;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Load journals (optional API date filters) and hydrate empty postings via GET by id.
 */
export async function loadJournalsWithPostings(
  client: EFinancialsClient,
  options: { start_date?: string; end_date?: string } = {},
): Promise<Journal[]> {
  const params: { start_date?: string; end_date?: string } = {};
  if (options.start_date != null) {
    params.start_date = options.start_date;
  }
  if (options.end_date != null) {
    params.end_date = options.end_date;
  }

  const listed = await fetchAllJournalListPages(client, params);
  const needHydrate = listed.filter((j) => j.id != null && !hasPostings(j));
  if (needHydrate.length === 0) {
    return listed;
  }

  const hydrated = await mapPool(needHydrate, HYDRATE_CONCURRENCY, async (journal) => {
    const id = journal.id as number;
    return (await client.get<Journal>(`/v1/journals/${id}`)) as unknown as Journal;
  });

  const byId = new Map<number, Journal>();
  for (const j of hydrated) {
    if (j.id != null) {
      byId.set(j.id, j);
    }
  }

  return listed.map((j) => {
    if (j.id != null && byId.has(j.id)) {
      return byId.get(j.id) as Journal;
    }
    return j;
  });
}
