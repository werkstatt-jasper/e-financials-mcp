import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EFinancialsClient } from "./client.js";
import {
  README_TOOLS_END,
  README_TOOLS_START,
  readmeToolGroups,
  renderToolTable,
  replaceToolTable,
  toolSummary,
  writeReadmeToolTable,
} from "./readme-tools.js";
import { buildAllTools } from "./server-setup.js";

describe("toolSummary", () => {
  it("keeps the first sentence on one line", () => {
    expect(toolSummary("List things.\n  Use `x` for more. Another.")).toBe("List things.");
  });

  it("keeps a description without sentence end", () => {
    expect(toolSummary("Get details by ID")).toBe("Get details by ID");
  });

  it("does not split on a lowercase continuation", () => {
    expect(toolSummary("Uses type C. type D is out.")).toBe("Uses type C. type D is out.");
  });

  it("truncates long text on a word boundary and escapes pipes", () => {
    const summary = toolSummary(`a|b ${"word ".repeat(60)}`);
    expect(summary.length).toBeLessThanOrEqual(161);
    expect(summary.endsWith("word…")).toBe(true);
    expect(summary.startsWith("a\\|b ")).toBe(true);
  });
});

describe("renderToolTable", () => {
  it("renders a count and one collapsible table per group", () => {
    const table = renderToolTable([
      { title: "One", tools: { a: { description: "Does A." } } },
      { title: "Two", tools: { b: { description: "Does B." }, c: { description: "Does C." } } },
    ]);
    expect(table).toContain("**3 tools.**");
    expect(table).toContain("<b>Two</b> (2)");
    expect(table).toContain("| `c` | Does C. |");
    expect(table.endsWith("</details>")).toBe(true);
  });
});

describe("replaceToolTable", () => {
  it("replaces only the text between the markers", () => {
    const readme = `top\n${README_TOOLS_START}\nold\n${README_TOOLS_END}\nbottom\n`;
    expect(replaceToolTable(readme, "new")).toBe(
      `top\n${README_TOOLS_START}\nnew\n${README_TOOLS_END}\nbottom\n`,
    );
  });

  it("throws when markers are missing or out of order", () => {
    expect(() => replaceToolTable("no markers", "x")).toThrow(/markers/);
    expect(() => replaceToolTable(`${README_TOOLS_START}`, "x")).toThrow(/markers/);
    expect(() => replaceToolTable(`${README_TOOLS_END}${README_TOOLS_START}`, "x")).toThrow(
      /markers/,
    );
  });
});

describe("writeReadmeToolTable", () => {
  it("writes once and then reports no change", () => {
    const dir = mkdtempSync(join(tmpdir(), "readme-tools-"));
    const path = join(dir, "README.md");
    try {
      writeFileSync(path, `# x\n${README_TOOLS_START}\n${README_TOOLS_END}\n`);
      expect(writeReadmeToolTable(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("<details>");
      expect(writeReadmeToolTable(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("README tool table", () => {
  it("covers every registered tool exactly once", () => {
    const grouped = readmeToolGroups().flatMap((g) => Object.keys(g.tools));
    const all = Object.keys(buildAllTools({} as EFinancialsClient));
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...all].sort());
  });

  it("is in sync with the tool definitions (run npm run docs:readme to fix)", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(replaceToolTable(readme, renderToolTable(readmeToolGroups()))).toBe(readme);
  });
});
