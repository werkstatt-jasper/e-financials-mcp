import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "./client.js";
import { buildAllPrompts } from "./prompts.js";
import { buildAllResources, matchUriTemplate } from "./resources.js";
import {
  buildAllTools,
  registerMcpPromptHandlers,
  registerMcpResourceHandlers,
  registerMcpToolHandlers,
  startStdioServer,
} from "./server-setup.js";

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

describe("registerMcpPromptHandlers", () => {
  const setRequestHandler = vi.fn();

  beforeEach(() => {
    setRequestHandler.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
  });

  it("lists prompts with arguments metadata", async () => {
    const prompts = buildAllPrompts();
    registerMcpPromptHandlers({ setRequestHandler }, prompts);

    expect(setRequestHandler).toHaveBeenCalledTimes(2);
    const listFn = setRequestHandler.mock.calls[0][1] as () => Promise<{
      prompts: { name: string }[];
    }>;
    const listResult = await listFn();
    expect(listResult.prompts.map((p) => p.name)).toContain("getting-started");
  });

  it("renders getting-started prompt", async () => {
    registerMcpPromptHandlers({ setRequestHandler }, buildAllPrompts());
    const getFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments?: Record<string, string> };
    }) => Promise<{ messages: { content: { text: string } }[] }>;

    const result = await getFn({
      params: { name: "getting-started", arguments: { focus: "bank" } },
    });
    expect(result.messages[0].content.text).toContain("bank");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ component: "prompt", prompt: "getting-started", outcome: "ok" }),
      "mcp prompt get",
    );
  });

  it("renders prompts without an arguments field on the request", async () => {
    registerMcpPromptHandlers({ setRequestHandler }, buildAllPrompts());
    const getFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string };
    }) => Promise<{ messages: { content: { text: string } }[] }>;

    const result = await getFn({ params: { name: "getting-started" } });
    expect(result.messages[0].content.text).toContain("Safe usage");
  });

  it("ignores non-string prompt argument values", async () => {
    registerMcpPromptHandlers({ setRequestHandler }, buildAllPrompts());
    const getFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments?: Record<string, unknown> };
    }) => Promise<{ messages: { content: { text: string } }[] }>;

    const result = await getFn({
      params: { name: "getting-started", arguments: { focus: 123 } },
    });
    expect(result.messages[0].content.text).not.toContain("User focus");
  });

  it("renders prompts that declare no arguments schema", async () => {
    const prompts = {
      plain: {
        description: "plain",
        render: () => ({
          messages: [{ role: "user" as const, content: { type: "text" as const, text: "plain" } }],
        }),
      },
    };
    registerMcpPromptHandlers({ setRequestHandler }, prompts);
    const getFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string };
    }) => Promise<{ messages: { content: { text: string } }[] }>;

    const result = await getFn({ params: { name: "plain" } });
    expect(result.messages[0].content.text).toBe("plain");
  });

  it("throws for unknown prompt", async () => {
    registerMcpPromptHandlers({ setRequestHandler }, buildAllPrompts());
    const getFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string };
    }) => Promise<unknown>;

    await expect(getFn({ params: { name: "missing" } })).rejects.toThrow("Unknown prompt: missing");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ component: "prompt", outcome: "unknown_prompt" }),
      "mcp prompt get",
    );
  });

  it("throws when required argument is missing", async () => {
    const prompts = {
      req: {
        description: "needs arg",
        arguments: [{ name: "x", required: true }],
        render: () => ({
          messages: [{ role: "user" as const, content: { type: "text" as const, text: "ok" } }],
        }),
      },
    };
    registerMcpPromptHandlers({ setRequestHandler }, prompts);
    const getFn = setRequestHandler.mock.calls[1][1] as (req: {
      params: { name: string; arguments?: Record<string, string> };
    }) => Promise<unknown>;

    await expect(getFn({ params: { name: "req", arguments: {} } })).rejects.toThrow(
      "Missing required prompt argument: x",
    );
  });
});

describe("registerMcpResourceHandlers", () => {
  const setRequestHandler = vi.fn();

  beforeEach(() => {
    setRequestHandler.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
  });

  it("lists static resources and empty templates", async () => {
    registerMcpResourceHandlers({ setRequestHandler }, buildAllResources());
    expect(setRequestHandler).toHaveBeenCalledTimes(3);

    const listResourcesFn = setRequestHandler.mock.calls[0][1] as () => Promise<{
      resources: { uri: string }[];
    }>;
    const listTemplatesFn = setRequestHandler.mock.calls[1][1] as () => Promise<{
      resourceTemplates: unknown[];
    }>;

    const resources = await listResourcesFn();
    expect(resources.resources.some((r) => r.uri === "efinancials://server_info")).toBe(true);
    const templates = await listTemplatesFn();
    expect(templates.resourceTemplates).toEqual([]);
  });

  it("reads server_info resource", async () => {
    registerMcpResourceHandlers({ setRequestHandler }, buildAllResources());
    const readFn = setRequestHandler.mock.calls[2][1] as (req: {
      params: { uri: string };
    }) => Promise<{ contents: { text: string }[] }>;

    const result = await readFn({ params: { uri: "efinancials://server_info" } });
    expect(JSON.parse(result.contents[0].text)).toMatchObject({ name: "e-financials" });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ component: "resource", outcome: "ok" }),
      "mcp resource read",
    );
  });

  it("lists resource templates when registry has templates", async () => {
    const registry = {
      resources: {},
      templates: {
        item: {
          uriTemplate: "efinancials://items/{id}",
          name: "item",
          description: "item by id",
          mimeType: "application/json",
          read: (_uri: string, vars: Record<string, string>) => ({
            uri: `efinancials://items/${vars.id}`,
            mimeType: "application/json",
            text: JSON.stringify({ id: vars.id }),
          }),
        },
      },
    };
    registerMcpResourceHandlers({ setRequestHandler }, registry);
    const listTemplatesFn = setRequestHandler.mock.calls[1][1] as () => Promise<{
      resourceTemplates: { uriTemplate: string; name: string }[];
    }>;

    const templates = await listTemplatesFn();
    expect(templates.resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: "efinancials://items/{id}",
        name: "item",
      }),
    ]);
  });

  it("matches template resources", async () => {
    const registry = {
      resources: {},
      templates: {
        item: {
          uriTemplate: "efinancials://items/{id}",
          name: "item",
          description: "item by id",
          mimeType: "application/json",
          read: (_uri: string, vars: Record<string, string>) => ({
            uri: `efinancials://items/${vars.id}`,
            mimeType: "application/json",
            text: JSON.stringify({ id: vars.id }),
          }),
        },
      },
    };
    registerMcpResourceHandlers({ setRequestHandler }, registry);
    const readFn = setRequestHandler.mock.calls[2][1] as (req: {
      params: { uri: string };
    }) => Promise<{ contents: { text: string }[] }>;

    const result = await readFn({ params: { uri: "efinancials://items/99" } });
    expect(JSON.parse(result.contents[0].text)).toEqual({ id: "99" });
    expect(matchUriTemplate("efinancials://items/{id}", "efinancials://items/99")).toEqual({
      id: "99",
    });
  });

  it("skips non-matching templates before finding a match", async () => {
    const registry = {
      resources: {},
      templates: {
        other: {
          uriTemplate: "efinancials://other/{id}",
          name: "other",
          description: "other",
          mimeType: "application/json",
          read: (_uri: string, vars: Record<string, string>) => ({
            uri: `efinancials://other/${vars.id}`,
            mimeType: "application/json",
            text: JSON.stringify({ kind: "other" }),
          }),
        },
        item: {
          uriTemplate: "efinancials://items/{id}",
          name: "item",
          description: "item by id",
          mimeType: "application/json",
          read: (_uri: string, vars: Record<string, string>) => ({
            uri: `efinancials://items/${vars.id}`,
            mimeType: "application/json",
            text: JSON.stringify({ id: vars.id }),
          }),
        },
      },
    };
    registerMcpResourceHandlers({ setRequestHandler }, registry);
    const readFn = setRequestHandler.mock.calls[2][1] as (req: {
      params: { uri: string };
    }) => Promise<{ contents: { text: string }[] }>;

    const result = await readFn({ params: { uri: "efinancials://items/7" } });
    expect(JSON.parse(result.contents[0].text)).toEqual({ id: "7" });
  });

  it("throws for unknown resource URI", async () => {
    registerMcpResourceHandlers({ setRequestHandler }, buildAllResources());
    const readFn = setRequestHandler.mock.calls[2][1] as (req: {
      params: { uri: string };
    }) => Promise<unknown>;

    await expect(readFn({ params: { uri: "efinancials://missing" } })).rejects.toThrow(
      "Unknown resource: efinancials://missing",
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ component: "resource", outcome: "unknown_resource" }),
      "mcp resource read",
    );
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
