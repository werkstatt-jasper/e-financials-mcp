import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "./client.js";
import { buildAllTools, registerMcpToolHandlers, startStdioServer } from "./server-setup.js";

const mockLoggerInfo = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./logger.js", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    fatal: vi.fn(),
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function MockTransport(this: { x?: number }) {
    this.x = 1;
  }),
}));

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

describe("buildAllTools", () => {
  it("merges all tool modules with expected keys", () => {
    const client = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      getAllPages: vi.fn(),
      request: vi.fn(),
    } as unknown as EFinancialsClient;

    const tools = buildAllTools(client);
    expect(tools.list_transactions).toBeDefined();
    expect(tools.list_clients).toBeDefined();
    expect(tools.list_sales_invoices).toBeDefined();
    expect(tools.list_accounts).toBeDefined();
    expect(tools.reconciliation_report).toBeDefined();
  });
});

describe("registerMcpToolHandlers", () => {
  const setRequestHandler = vi.fn();
  const mockHandler = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "{}" }],
  });

  beforeEach(() => {
    setRequestHandler.mockReset();
    mockHandler.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockHandler.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
    });
  });

  it("registers list and call handlers", async () => {
    const allTools = {
      t1: { description: "d", inputSchema: {}, handler: mockHandler },
    };
    registerMcpToolHandlers({ setRequestHandler }, allTools);

    expect(setRequestHandler).toHaveBeenCalledTimes(2);
    const listFn = setRequestHandler.mock.calls[0][1] as () => Promise<{
      tools: { name: string }[];
    }>;
    const listResult = await listFn();
    expect(listResult.tools).toEqual([{ name: "t1", description: "d", inputSchema: {} }]);
  });

  it("invokes tool handler on call", async () => {
    const allTools = {
      t1: { description: "d", inputSchema: {}, handler: mockHandler },
    };
    registerMcpToolHandlers({ setRequestHandler }, allTools);
    const callFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments: unknown };
    }) => Promise<unknown>;

    await callFn({ params: { name: "t1", arguments: { a: 1 } } });
    expect(mockHandler).toHaveBeenCalledWith({ a: 1 });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "tool",
        tool: "t1",
        outcome: "ok",
      }),
      "mcp tool call",
    );
  });

  it("logs outcome error when handler returns isError without throwing", async () => {
    mockHandler.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      isError: true,
    });
    const allTools = {
      t1: { description: "d", inputSchema: {}, handler: mockHandler },
    };
    registerMcpToolHandlers({ setRequestHandler }, allTools);
    const callFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments: unknown };
    }) => Promise<{ isError?: boolean; content: { text: string }[] }>;

    const result = await callFn({ params: { name: "t1", arguments: {} } });
    expect(result.isError).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "t1",
        outcome: "error",
      }),
      "mcp tool call",
    );
  });

  it("throws for unknown tool name", async () => {
    registerMcpToolHandlers({ setRequestHandler }, {});
    const callFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments: unknown };
    }) => Promise<unknown>;

    await expect(callFn({ params: { name: "missing", arguments: {} } })).rejects.toThrow(
      "Unknown tool: missing",
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "tool",
        tool: "missing",
        outcome: "unknown_tool",
      }),
      "mcp tool call",
    );
  });

  it("returns isError when handler throws Error", async () => {
    mockHandler.mockRejectedValue(new Error("bad"));
    const allTools = {
      t1: { description: "d", inputSchema: {}, handler: mockHandler },
    };
    registerMcpToolHandlers({ setRequestHandler }, allTools);
    const callFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments: unknown };
    }) => Promise<{ isError?: boolean; content: { text: string }[] }>;

    const result = await callFn({ params: { name: "t1", arguments: {} } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bad");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "t1",
        outcome: "handler_throw",
      }),
      "mcp tool call",
    );
  });

  it("returns isError when handler throws non-Error", async () => {
    mockHandler.mockRejectedValue("plain");
    const allTools = {
      t1: { description: "d", inputSchema: {}, handler: mockHandler },
    };
    registerMcpToolHandlers({ setRequestHandler }, allTools);
    const callFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments: unknown };
    }) => Promise<{ isError?: boolean; content: { text: string }[] }>;

    const result = await callFn({ params: { name: "t1", arguments: {} } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("plain");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "t1", outcome: "handler_throw" }),
      "mcp tool call",
    );
  });

  it("returns isError with field path when Zod validation fails in a real tool", async () => {
    const client = {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      getAllPages: vi.fn(),
      request: vi.fn(),
    } as unknown as EFinancialsClient;
    const allTools = buildAllTools(client);
    registerMcpToolHandlers({ setRequestHandler }, allTools);
    const callFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments: unknown };
    }) => Promise<{ isError?: boolean; content: { text: string }[] }>;

    const result = await callFn({
      params: {
        name: "list_transactions",
        arguments: { start_date: "not-a-date" },
      },
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as { error: string };
    expect(payload.error).toMatch(/start_date/);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "list_transactions", outcome: "handler_throw" }),
      "mcp tool call",
    );
  });
});

describe("startStdioServer", () => {
  beforeEach(() => {
    vi.mocked(StdioServerTransport).mockClear();
    mockLoggerInfo.mockClear();
  });

  it("connects server to stdio transport and logs", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);

    await startStdioServer({ connect });

    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith("e-Financials MCP server running on stdio");
  });
});
