import { describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createMockClient, mockTransactionLists } from "../tools/test-helpers.js";
import type { Transaction } from "../types/transaction.js";
import {
  dateRangeOf,
  getIncomingPage,
  labelDirection,
  labelFetchedRows,
  loadIncomingIds,
  loadLabelledTransactions,
  pageOf,
  storedDirection,
  toolTypeForDirection,
} from "./stored-direction.js";

function tx(id: number, date = "2026-10-01"): Transaction {
  return { id, date, type: "C", amount: 1 } as Transaction;
}

describe("stored direction", () => {
  it("asks the type filter for the incoming rows", async () => {
    const client = createMockClient();
    mockTransactionLists(client, [tx(1), tx(2), tx(3)], [2]);

    const ids = await loadIncomingIds(client, { start_date: "2026-10-01", status: "PROJECT" });

    expect([...ids]).toEqual([2]);
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      status: "PROJECT",
      type: "D",
    });
  });

  it("labels stored-incoming rows C and the rest D", async () => {
    expect(labelDirection([tx(1), tx(2)], new Set([2])).map((row) => row.type)).toEqual(["D", "C"]);

    const client = createMockClient();
    mockTransactionLists(client, [tx(1), tx(2), tx(3)], [1, 3]);
    const rows = await loadLabelledTransactions(client, { end_date: "2026-10-31" });
    expect(rows.map((row) => [row.id, row.type])).toEqual([
      [1, "C"],
      [2, "D"],
      [3, "C"],
    ]);
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      end_date: "2026-10-31",
    });
  });

  it("finds the date range of rows", () => {
    expect(dateRangeOf([])).toEqual({});
    expect(dateRangeOf([{ date: null }, {}])).toEqual({});
    expect(
      dateRangeOf([
        { date: "2026-10-05" },
        { date: "2026-09-30T00:00:00" },
        { date: "2026-10-01" },
      ]),
    ).toEqual({ start_date: "2026-09-30", end_date: "2026-10-05" });
  });

  it("labels fetched rows from the incoming rows in their date range", async () => {
    const client = createMockClient();
    expect(await labelFetchedRows(client, [], {})).toEqual([]);
    expect(client.getAllPages).not.toHaveBeenCalled();

    mockTransactionLists(client, [tx(1, "2026-10-02"), tx(2, "2026-10-04")], [2]);
    const rows = await labelFetchedRows(client, [tx(1, "2026-10-02"), tx(2, "2026-10-04")], {
      status: "PROJECT",
      clients_id: 7,
    });

    expect(rows.map((row) => row.type)).toEqual(["D", "C"]);
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      status: "PROJECT",
      clients_id: 7,
      start_date: "2026-10-02",
      end_date: "2026-10-04",
      type: "D",
    });
  });

  it("returns one RIK page of incoming rows labelled C", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValueOnce({
      items: [tx(5)],
      current_page: 2,
      total_pages: 3,
    } as never);

    expect(await getIncomingPage(client, { clients_id: 4 }, 2)).toEqual({
      items: [{ ...tx(5), type: "C" }],
      current_page: 2,
      total_pages: 3,
    });
    expect(client.get).toHaveBeenCalledWith("/v1/transactions", {
      clients_id: 4,
      type: "D",
      page: 2,
    });

    vi.mocked(client.get).mockResolvedValueOnce({} as never);
    expect(await getIncomingPage(client, {})).toEqual({
      items: [],
      current_page: 1,
      total_pages: 1,
    });
  });

  it("pages rows locally 100 at a time", () => {
    const rows = Array.from({ length: 150 }, (_, i) => tx(i + 1));
    const second = pageOf(rows, 2);
    expect(second.items.map((row) => row.id)).toEqual(rows.slice(100).map((row) => row.id));
    expect(second).toMatchObject({ current_page: 2, total_pages: 2 });
    expect(pageOf([], 1)).toEqual({ items: [], current_page: 1, total_pages: 1 });
  });

  it("reads one transaction's direction from that day's incoming rows", async () => {
    const client: EFinancialsClient = createMockClient();
    mockTransactionLists(client, [tx(8), tx(9)], [9]);

    expect(await storedDirection(client, 9, "2026-10-01T00:00:00")).toBe("incoming");
    expect(await storedDirection(client, 8, "2026-10-01")).toBe("outgoing");
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
      type: "D",
    });
    expect(toolTypeForDirection("incoming")).toBe("C");
    expect(toolTypeForDirection("outgoing")).toBe("D");
  });
});
