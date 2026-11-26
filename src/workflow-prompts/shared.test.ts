import { describe, expect, it } from "vitest";
import { z } from "zod";
import { optionalPositiveInt, optionalYmd, parseToolArgs } from "../validation/tool-args.js";
import {
  definePrompt,
  formatProvidedArgs,
  missingDimensionHint,
  promptArgumentDefs,
  withDateRangeOrder,
  yearMonthString,
} from "./shared.js";

describe("promptArgumentDefs", () => {
  it("marks required strings and copies .describe() text", () => {
    const schema = z.object({
      file_path: z.string().min(1).describe("Path to the file"),
    });
    expect(promptArgumentDefs(schema)).toEqual([
      { name: "file_path", description: "Path to the file", required: true },
    ]);
  });

  it("marks optional fields and reads a description from unwrap() when needed", () => {
    const schema = z.object({
      mode: z.enum(["auto", "review"]).describe("Reconciliation mode").optional(),
      dim: optionalPositiveInt.describe("Dimension id"),
      when: optionalYmd,
      plain: z.string(),
    });
    const defs = promptArgumentDefs(schema);
    expect(defs).toEqual([
      { name: "mode", description: "Reconciliation mode", required: false },
      { name: "dim", description: "Dimension id", required: false },
      { name: "when", required: false },
      { name: "plain", required: true },
    ]);
  });
});

describe("formatProvidedArgs", () => {
  it("lists string and non-string values", () => {
    const text = formatProvidedArgs({
      file_path: "/tmp/a.xml",
      accounts_dimensions_id: 3,
      skip: undefined,
      empty: "",
    });
    expect(text).toContain("`file_path`: /tmp/a.xml");
    expect(text).toContain("`accounts_dimensions_id`: 3");
    expect(text).not.toContain("skip");
    expect(text).not.toContain("empty");
  });

  it("explains when nothing was provided", () => {
    expect(formatProvidedArgs({})).toContain("No arguments were provided.");
  });
});

describe("missingDimensionHint", () => {
  it("mentions a provided id", () => {
    expect(missingDimensionHint(15)).toContain("15");
  });

  it("asks the user to confirm when the id is missing", () => {
    expect(missingDimensionHint(undefined)).toContain("list_account_dimensions");
  });
});

describe("withDateRangeOrder", () => {
  const schema = withDateRangeOrder(
    z.object({
      date_from: optionalYmd,
      date_to: optionalYmd,
    }),
  );

  it("accepts a missing bound or an ordered range", () => {
    expect(parseToolArgs(schema, { date_from: "2026-01-01" })).toEqual({
      date_from: "2026-01-01",
      date_to: undefined,
    });
    expect(parseToolArgs(schema, { date_from: "2026-01-01", date_to: "2026-01-01" })).toEqual({
      date_from: "2026-01-01",
      date_to: "2026-01-01",
    });
  });

  it("rejects a reversed range", () => {
    expect(() => parseToolArgs(schema, { date_from: "2026-02-02", date_to: "2026-02-01" })).toThrow(
      /date_from must be on or before date_to/,
    );
  });
});

describe("definePrompt", () => {
  it("parses args through the schema before rendering", () => {
    const prompt = definePrompt(
      "A demo prompt",
      z.object({ month: yearMonthString }),
      (args) => `month=${args.month}`,
    );
    expect(prompt.arguments?.[0]).toMatchObject({ name: "month", required: true });
    expect(prompt.render({ month: "2026-07" }).messages[0].content.text).toBe("month=2026-07");
    expect(() => prompt.render({})).toThrow(/month/);
  });
});
