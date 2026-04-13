import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { EFinancialsClient } from "./client.js";
import { logger } from "./logger.js";
import { createAccountTools } from "./tools/accounts.js";
import { createClientTools } from "./tools/clients.js";
import { createInvoiceSettingsTools } from "./tools/invoiceSettings.js";
import { createInvoiceTools } from "./tools/invoices.js";
import { createJournalTools } from "./tools/journals.js";
import { createProductTools } from "./tools/products.js";
import { createReferenceTools } from "./tools/reference.js";
import { createReportTools } from "./tools/reports.js";
import { createTransactionTools } from "./tools/transactions.js";

// biome-ignore lint/suspicious/noExplicitAny: tool handlers use per-tool param shapes
export type ToolHandler = (params: any) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

export type ToolRecord = Record<
  string,
  {
    description: string;
    inputSchema: object;
    handler: ToolHandler;
  }
>;

export function buildAllTools(client: EFinancialsClient): ToolRecord {
  return {
    ...createTransactionTools(client),
    ...createClientTools(client),
    ...createInvoiceTools(client),
    ...createInvoiceSettingsTools(client),
    ...createJournalTools(client),
    ...createProductTools(client),
    ...createAccountTools(client),
    ...createReferenceTools(client),
    ...createReportTools(client),
  };
}

export function registerMcpToolHandlers(
  server: Pick<Server, "setRequestHandler">,
  allTools: ToolRecord,
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.entries(allTools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolCallStart = performance.now();
    const tool = allTools[name];
    if (!tool) {
      const durationMs = Math.round(performance.now() - toolCallStart);
      logger.warn(
        {
          component: "tool",
          tool: name,
          durationMs,
          outcome: "unknown_tool",
        },
        "mcp tool call",
      );
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const result = await tool.handler(args);
      const durationMs = Math.round(performance.now() - toolCallStart);
      const outcome = "isError" in result && result.isError ? "error" : "ok";
      logger.info(
        {
          component: "tool",
          tool: name,
          durationMs,
          outcome,
        },
        "mcp tool call",
      );
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - toolCallStart);
      logger.info(
        {
          component: "tool",
          tool: name,
          durationMs,
          outcome: "handler_throw",
        },
        "mcp tool call",
      );
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });
}

export async function startStdioServer(server: Pick<Server, "connect">): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("e-Financials MCP server running on stdio");
}
