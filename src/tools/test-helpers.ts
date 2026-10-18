import { vi } from "vitest";
import type { EFinancialsClient } from "../client.js";

export function createMockClient(): EFinancialsClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getAllPages: vi.fn(),
    request: vi.fn(),
  } as unknown as EFinancialsClient;
}

/**
 * RIK transaction lists as the live API returns them: every row has type "C",
 * and the `type` filter (any letter) returns only the rows stored as incoming.
 */
export function transactionLists<T extends { id: number }>(
  rows: readonly T[],
  incomingIds: readonly number[],
): (params?: Record<string, unknown>) => Array<T & { type: "C" }> {
  const incoming = new Set(incomingIds);
  return (params) => {
    const listed = rows.map((row) => ({ ...row, type: "C" as const }));
    return params?.type === undefined ? listed : listed.filter((row) => incoming.has(row.id));
  };
}

/** Routes `getAllPages("/v1/transactions")` through `transactionLists`; other paths use `other`. */
export function mockTransactionLists<T extends { id: number }>(
  client: EFinancialsClient,
  rows: readonly T[],
  incomingIds: readonly number[],
  other: (path: string, params?: Record<string, unknown>) => unknown = () => [],
): void {
  const list = transactionLists(rows, incomingIds);
  vi.mocked(client.getAllPages).mockImplementation(
    async (path: string, params?: Record<string, unknown>) =>
      (path === "/v1/transactions" ? list(params) : other(path, params)) as never,
  );
}

export function parseToolJson(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}
