import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { loadAuthConfig } from "./auth.js";
import { EFinancialsClient } from "./client.js";
import { buildAllPrompts } from "./prompts.js";
import { buildAllResources } from "./resources.js";
import {
  buildAllTools,
  registerMcpPromptHandlers,
  registerMcpResourceHandlers,
  registerMcpToolHandlers,
  startStdioServer,
} from "./server-setup.js";

export async function startApp(): Promise<void> {
  const apiClient = new EFinancialsClient(loadAuthConfig);
  const allTools = buildAllTools(apiClient);
  const allPrompts = buildAllPrompts();
  const allResources = buildAllResources();
  const server = new Server(
    { name: "e-financials", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );
  registerMcpToolHandlers(server, allTools);
  registerMcpPromptHandlers(server, allPrompts);
  registerMcpResourceHandlers(server, allResources);
  await startStdioServer(server);
}
