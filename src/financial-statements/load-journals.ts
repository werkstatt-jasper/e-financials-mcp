import type { EFinancialsClient } from "../client.js";
import type { Journal } from "../types/journal.js";

/**
 * Default cap on /v1/journals list pages for ledger loads (statements, balances,
 * month-end). Raised from 100 → 1000 → 2000 after a full-year ledger reported
 * 1508 pages. Override with `RIK_JOURNAL_LIST_MAX_PAGES`.
 */
export const JOURNAL_LIST_MAX_PAGES = 2000;

/** Concurrent page requests once page 1 has reported total_pages. */
export const JOURNAL_LIST_PAGE_CONCURRENCY = 4;

const HYDRATE_CONCURRENCY = 5;

/**
 * Reads `RIK_JOURNAL_LIST_MAX_PAGES`; unset, invalid or values below 1 use
 * {@link JOURNAL_LIST_MAX_PAGES}.
 */
export function journalListMaxPagesFromEnv(): number {
  const raw = process.env.RIK_JOURNAL_LIST_MAX_PAGES;
  if (raw === undefined || raw.trim() === "") {
    return JOURNAL_LIST_MAX_PAGES;
  }
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 ? n : JOURNAL_LIST_MAX_PAGES;
}

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

function truncatedMessage(totalPages: number, maxPages: number): string {
  return `Journal list has ${totalPages} API pages, more than the limit of ${maxPages} (RIK_JOURNAL_LIST_MAX_PAGES). Narrow date_from/date_to or raise RIK_JOURNAL_LIST_MAX_PAGES and retry — financial statements refuse incomplete ledger loads.`;
}

function hasPostings(journal: Journal): boolean {
  return Array.isArray(journal.postings) && journal.postings.length > 0;
}

/**
 * Page through /v1/journals. Page 1 is fetched first; once it reports
 * total_pages, the remaining pages are fetched with bounded concurrency and
 * concatenated in page order. If a later page reports a higher total_pages
 * (the ledger grew mid-load), those pages are fetched too.
 *
 * Throws {@link JournalListTruncatedError} as soon as total_pages exceeds the
 * cap (`maxPages`, default from `RIK_JOURNAL_LIST_MAX_PAGES`), so statements
 * never silently under-report.
 */
export async function fetchAllJournalListPages(
  client: EFinancialsClient,
  params?: { start_date?: string; end_date?: string },
  options: { maxPages?: number } = {},
): Promise<Journal[]> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? journalListMaxPagesFromEnv()));
  const pages: Journal[][] = [];

  const fetchPage = async (page: number): Promise<number> => {
    const response = await client.get<Journal>("/v1/journals", {
      ...params,
      page,
    });
    pages[page - 1] = (response.items as Journal[] | undefined) ?? [];
    return response.total_pages || 1;
  };

  let totalPages = await fetchPage(1);
  let fetched = 1;
  while (fetched < totalPages) {
    if (totalPages > maxPages) {
      throw new JournalListTruncatedError(truncatedMessage(totalPages, maxPages));
    }
    const batch: number[] = [];
    for (
      let page = fetched + 1;
      page <= totalPages && batch.length < JOURNAL_LIST_PAGE_CONCURRENCY;
      page++
    ) {
      batch.push(page);
    }
    const reported = await Promise.all(batch.map(fetchPage));
    fetched += batch.length;
    totalPages = Math.max(totalPages, ...reported);
  }

  return pages.flat();
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
  options: { start_date?: string; end_date?: string; maxPages?: number } = {},
): Promise<Journal[]> {
  const params: { start_date?: string; end_date?: string } = {};
  if (options.start_date != null) {
    params.start_date = options.start_date;
  }
  if (options.end_date != null) {
    params.end_date = options.end_date;
  }

  const listed = await fetchAllJournalListPages(client, params, { maxPages: options.maxPages });
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
