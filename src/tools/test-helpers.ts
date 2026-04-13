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

export function parseToolJson(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}
