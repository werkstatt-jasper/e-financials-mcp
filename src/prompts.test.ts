import { describe, expect, it } from "vitest";
import { buildAllPrompts } from "./prompts.js";

describe("buildAllPrompts", () => {
  it("includes getting-started with optional focus argument", () => {
    const prompts = buildAllPrompts();
    expect(prompts["getting-started"]).toBeDefined();
    expect(prompts["getting-started"].arguments).toEqual([
      expect.objectContaining({ name: "focus", required: false }),
    ]);
  });

  it("renders base text without focus", () => {
    const { messages } = promptsRender({});
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content.type).toBe("text");
    expect(messages[0].content.text).toContain("Safe usage");
    expect(messages[0].content.text).not.toContain("User focus");
  });

  it("includes focus section when provided", () => {
    const { messages } = promptsRender({ focus: "invoices" });
    expect(messages[0].content.text).toContain("invoices");
    expect(messages[0].content.text).toContain("User focus");
  });
});

function promptsRender(args: Record<string, string>) {
  return buildAllPrompts()["getting-started"].render(args);
}
