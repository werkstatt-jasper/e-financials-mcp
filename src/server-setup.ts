import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { EFinancialsClient } from "./client.js";
import { logger } from "./logger.js";
import type { PromptRecord } from "./prompts.js";
import type { ResourceRegistry } from "./resources.js";
import { matchUriTemplate } from "./resources.js";
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

export type { PromptArgumentDef, PromptDef, PromptRecord } from "./prompts.js";
export { buildAllPrompts } from "./prompts.js";
export type {
  ResourceReadResult,
  ResourceRegistry,
  ResourceTemplateDef,
  StaticResourceDef,
} from "./resources.js";
export { buildAllResources, EFINANCIALS_URI_SCHEME, matchUriTemplate } from "./resources.js";

export function registerMcpPromptHandlers(
  server: Pick<Server, "setRequestHandler">,
  prompts: PromptRecord,
): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: Object.entries(prompts).map(([name, prompt]) => ({
        name,
        description: prompt.description,
        arguments: prompt.arguments,
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const promptCallStart = performance.now();
    const prompt = prompts[name];
    if (!prompt) {
      const durationMs = Math.round(performance.now() - promptCallStart);
      logger.warn(
        {
          component: "prompt",
          prompt: name,
          durationMs,
          outcome: "unknown_prompt",
        },
        "mcp prompt get",
      );
      throw new Error(`Unknown prompt: ${name}`);
    }

    const argValues: Record<string, string> = {};
    if (args) {
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string") {
          argValues[key] = value;
        }
      }
    }

    for (const argDef of prompt.arguments ?? []) {
      if (argDef.required && !argValues[argDef.name]?.trim()) {
        const durationMs = Math.round(performance.now() - promptCallStart);
        logger.warn(
          {
            component: "prompt",
            prompt: name,
            durationMs,
            outcome: "missing_required_arg",
            argument: argDef.name,
          },
          "mcp prompt get",
        );
        throw new Error(`Missing required prompt argument: ${argDef.name}`);
      }
    }

    const result = prompt.render(argValues);
    const durationMs = Math.round(performance.now() - promptCallStart);
    logger.info(
      {
        component: "prompt",
        prompt: name,
        durationMs,
        outcome: "ok",
      },
      "mcp prompt get",
    );
    return {
      description: prompt.description,
      messages: result.messages,
    };
  });
}

export function registerMcpResourceHandlers(
  server: Pick<Server, "setRequestHandler">,
  registry: ResourceRegistry,
): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: Object.values(registry.resources).map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: Object.values(registry.templates).map((template) => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        description: template.description,
        mimeType: template.mimeType,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const resourceCallStart = performance.now();

    const staticResource = Object.values(registry.resources).find(
      (resource) => resource.uri === uri,
    );
    if (staticResource) {
      const content = staticResource.read();
      const durationMs = Math.round(performance.now() - resourceCallStart);
      logger.info(
        {
          component: "resource",
          resource: uri,
          durationMs,
          outcome: "ok",
        },
        "mcp resource read",
      );
      return {
        contents: [
          {
            uri: content.uri,
            mimeType: content.mimeType,
            text: content.text,
          },
        ],
      };
    }

    for (const template of Object.values(registry.templates)) {
      const vars = matchUriTemplate(template.uriTemplate, uri);
      if (vars) {
        const content = template.read(uri, vars);
        const durationMs = Math.round(performance.now() - resourceCallStart);
        logger.info(
          {
            component: "resource",
            resource: uri,
            durationMs,
            outcome: "ok",
          },
          "mcp resource read",
        );
        return {
          contents: [
            {
              uri: content.uri,
              mimeType: content.mimeType,
              text: content.text,
            },
          ],
        };
      }
    }

    const durationMs = Math.round(performance.now() - resourceCallStart);
    logger.warn(
      {
        component: "resource",
        resource: uri,
        durationMs,
        outcome: "unknown_resource",
      },
      "mcp resource read",
    );
    throw new Error(`Unknown resource: ${uri}`);
  });
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
