import { afterEach, describe, expect, it, vi } from "vitest";

describe("logger module", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    vi.resetModules();
  });

  it("uses default info when LOG_LEVEL is unset", async () => {
    delete process.env.LOG_LEVEL;
    const { logger } = await import("./logger.js");
    expect(logger.level).toBe("info");
  });

  it("uses LOG_LEVEL when valid", async () => {
    process.env.LOG_LEVEL = "silent";
    const { logger } = await import("./logger.js");
    expect(logger.level).toBe("silent");
  });

  it("falls back to info when LOG_LEVEL is invalid", async () => {
    process.env.LOG_LEVEL = "not-a-pino-level";
    const { logger } = await import("./logger.js");
    expect(logger.level).toBe("info");
  });
});
