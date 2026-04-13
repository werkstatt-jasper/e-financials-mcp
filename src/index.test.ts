import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStartApp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockLoggerFatal = vi.hoisted(() => vi.fn());

vi.mock("./logger.js", () => ({
  logger: {
    fatal: mockLoggerFatal,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("./main.js", () => ({
  startApp: mockStartApp,
}));

describe("index entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    mockStartApp.mockReset();
    mockStartApp.mockResolvedValue(undefined);
    mockLoggerFatal.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invokes startApp when loaded", async () => {
    await import("./index.js");
    expect(mockStartApp).toHaveBeenCalledTimes(1);
  });

  it("logs fatal error and exits when startApp rejects", async () => {
    mockStartApp.mockRejectedValue(new Error("boot failed"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await import("./index.js");
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
    expect(mockLoggerFatal).toHaveBeenCalledWith({ err: expect.any(Error) }, "Fatal error");

    exitSpy.mockRestore();
  });
});
