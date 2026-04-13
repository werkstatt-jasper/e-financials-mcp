import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  formatZodError,
  optionalYmd,
  parseToolArgs,
  positiveInt,
  ymdDateString,
} from "./tool-args.js";

describe("formatZodError", () => {
  it("includes dot-separated paths and messages", () => {
    const schema = z.object({ a: z.object({ b: ymdDateString }) });
    const result = schema.safeParse({ a: { b: "nope" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatZodError(result.error);
      expect(msg).toContain("a.b");
      expect(msg).toMatch(/Expected YYYY-MM-DD|Invalid/i);
    }
  });

  it("uses (root) when issue path is empty", () => {
    const result = z.string().safeParse(123);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error)).toMatch(/^\(root\):/);
    }
  });
});

describe("parseToolArgs", () => {
  it("uses empty object when raw is undefined", () => {
    const schema = z.object({ page: z.number().optional() });
    expect(parseToolArgs(schema, undefined)).toEqual({});
  });

  it("throws Error with formatted message on failure", () => {
    const schema = z.object({ id: positiveInt });
    expect(() => parseToolArgs(schema, { id: -1 })).toThrow(/id/);
  });

  it("rejects impossible calendar dates", () => {
    expect(() => parseToolArgs(z.object({ d: ymdDateString }), { d: "2024-02-30" })).toThrow(
      /Invalid calendar date|Expected/,
    );
  });

  it("strips unknown keys by default (Zod object behavior)", () => {
    const schema = z.object({ x: z.number().optional() });
    const out = parseToolArgs(schema, { x: 1, extra: "gone" });
    expect(out).toEqual({ x: 1 });
    expect(Object.keys(out as object)).not.toContain("extra");
  });

  it("accepts valid optional YMD", () => {
    const schema = z.object({ start: optionalYmd });
    expect(parseToolArgs(schema, { start: "2024-06-01" })).toEqual({ start: "2024-06-01" });
    expect(parseToolArgs(schema, {})).toEqual({ start: undefined });
  });
});
