/**
 * Live HTTP smoke tests against RIK (demo or production, from env).
 * Run: `npm run test:integration` with RIK_API_* set (see README).
 */
import "dotenv/config";

import pino from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAuthConfig } from "../auth.js";
import { EFinancialsClient } from "../client.js";

function extractListPayload(response: unknown): unknown[] {
  if (Array.isArray(response)) {
    return response;
  }
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return obj.items;
    }
  }
  return [];
}

describe("RIK API smoke (integration)", () => {
  let client: EFinancialsClient;

  beforeAll(() => {
    const config = loadAuthConfig();
    const silentLogger = pino({ level: "silent" });
    client = new EFinancialsClient(config, { logger: silentLogger });
  });

  it("GET /v1/currencies returns list data", async () => {
    const res = await client.get("/v1/currencies");
    const rows = extractListPayload(res);
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      expect(rows[0]).toEqual(expect.objectContaining({ id: expect.anything() }));
    }
  });

  it("GET /v1/clients page 1 returns pagination", async () => {
    const res = await client.get("/v1/clients", { page: 1 });
    expect(res).toMatchObject({
      current_page: expect.any(Number),
      total_pages: expect.any(Number),
    });
    const rows = extractListPayload(res);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("GET /v1/accounts returns list data", async () => {
    const res = await client.get("/v1/accounts", { page: 1 });
    const rows = extractListPayload(res);
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      expect(rows[0]).toEqual(expect.objectContaining({ id: expect.any(Number) }));
    }
  });

  it("GET /v1/transactions page 1 returns pagination", async () => {
    const res = await client.get("/v1/transactions", { page: 1 });
    expect(res).toMatchObject({
      current_page: expect.any(Number),
      total_pages: expect.any(Number),
    });
    const rows = extractListPayload(res);
    expect(Array.isArray(rows)).toBe(true);
  });
});
