import { beforeEach, describe, expect, it, vi } from "vitest";
import referenceFixture from "../__fixtures__/reference.json" with { type: "json" };
import type { EFinancialsClient } from "../client.js";
import { createReferenceTools } from "./reference.js";
import { createMockClient, parseToolJson } from "./test-helpers.js";

describe("reference tools", () => {
  let client: EFinancialsClient;
  let tools: ReturnType<typeof createReferenceTools>;

  beforeEach(() => {
    client = createMockClient();
    tools = createReferenceTools(client);
  });

  it("list_currencies returns array from raw JSON array", async () => {
    vi.mocked(client.get).mockResolvedValue(referenceFixture.currencies as never);
    const result = await tools.list_currencies.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/currencies");
    const data = parseToolJson(result) as unknown[];
    expect(data).toEqual(referenceFixture.currencies);
    expect(data).toHaveLength(2);
  });

  it("list_currencies normalizes { items: [...] }", async () => {
    vi.mocked(client.get).mockResolvedValue({ items: referenceFixture.currencies } as never);
    const result = await tools.list_currencies.handler({});
    expect(parseToolJson(result)).toEqual(referenceFixture.currencies);
  });

  it("list_sale_articles returns array from raw JSON array", async () => {
    vi.mocked(client.get).mockResolvedValue(referenceFixture.sale_articles as never);
    const result = await tools.list_sale_articles.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/sale_articles");
    expect(parseToolJson(result)).toEqual(referenceFixture.sale_articles);
  });

  it("list_templates returns array from raw JSON array", async () => {
    vi.mocked(client.get).mockResolvedValue(referenceFixture.templates as never);
    const result = await tools.list_templates.handler({});
    expect(client.get).toHaveBeenCalledWith("/v1/templates");
    expect(parseToolJson(result)).toEqual(referenceFixture.templates);
  });

  it("extractItems returns empty array for unexpected shape", async () => {
    vi.mocked(client.get).mockResolvedValue({} as never);
    const result = await tools.list_currencies.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("extractItems returns empty when response is truthy but not an object", async () => {
    vi.mocked(client.get).mockResolvedValue(1 as never);
    const result = await tools.list_currencies.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });

  it("extractItems returns empty when object has non-array items property", async () => {
    vi.mocked(client.get).mockResolvedValue({ items: "x" } as never);
    const result = await tools.list_currencies.handler({});
    expect(parseToolJson(result)).toEqual([]);
  });
});
