import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { loadAuthConfig } from "./auth.js";
import { EFinancialsClient } from "./client.js";
import { buildAllTools, registerMcpToolHandlers, startStdioServer } from "./server-setup.js";

export async function startApp(): Promise<void> {
  const apiClient = new EFinancialsClient(loadAuthConfig);
  const allTools = buildAllTools(apiClient);
  const server = new Server(
    { name: "e-financials", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerMcpToolHandlers(server, allTools);
  await startStdioServer(server);
}
