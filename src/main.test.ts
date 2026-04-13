import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  startStdioServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./server-setup.js", async () => {
  const mod = await vi.importActual<typeof import("./server-setup.js")>("./server-setup.js");
  return {
    ...mod,
    startStdioServer: hoisted.startStdioServer,
  };
});

vi.mock("./auth.js", () => ({
  loadAuthConfig: vi.fn(() => ({
    apiKeyId: "id",
    apiKeyPassword: "pw",
    apiKeyPublic: "pub",
    baseUrl: "https://rmp-api.rik.ee",
  })),
}));

vi.mock("./client.js", () => ({
  EFinancialsClient: vi.fn(function MockEFC(this: Record<string, never>) {
    return this;
  }),
}));

const mockSetRequestHandler = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn(function MockServer(this: {
    setRequestHandler: typeof mockSetRequestHandler;
    connect: typeof mockConnect;
  }) {
    this.setRequestHandler = mockSetRequestHandler;
    this.connect = mockConnect;
  }),
}));

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startApp } from "./main.js";
import * as serverSetup from "./server-setup.js";

describe("startApp", () => {
  beforeEach(() => {
    hoisted.startStdioServer.mockClear();
    mockSetRequestHandler.mockClear();
    vi.mocked(Server).mockClear();
  });

  it("builds tools, registers handlers, and starts stdio server", async () => {
    const spy = vi.spyOn(serverSetup, "registerMcpToolHandlers");
    await startApp();

    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything());
    spy.mockRestore();

    expect(Server).toHaveBeenCalledWith(
      { name: "e-financials", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    expect(mockSetRequestHandler).toHaveBeenCalled();
    expect(hoisted.startStdioServer).toHaveBeenCalledTimes(1);
    const serverArg = hoisted.startStdioServer.mock.calls[0][0];
    expect(serverArg).toEqual(
      expect.objectContaining({
        setRequestHandler: mockSetRequestHandler,
        connect: mockConnect,
      }),
    );
  });
});
