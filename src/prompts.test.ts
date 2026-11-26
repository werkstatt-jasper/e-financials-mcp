import { describe, expect, it } from "vitest";
import { buildAllPrompts, normalizePromptArgValues } from "./prompts.js";
import { WORKFLOW_PROMPT_NAMES } from "./workflow-prompts/index.js";

describe("buildAllPrompts", () => {
  it("includes getting-started with optional focus argument", () => {
    const prompts = buildAllPrompts();
    expect(prompts["getting-started"]).toBeDefined();
    expect(prompts["getting-started"].arguments).toEqual([
      expect.objectContaining({ name: "focus", required: false }),
    ]);
  });

  it("registers the workflow prompts after getting-started", () => {
    const names = Object.keys(buildAllPrompts());
    expect(names).toEqual(["getting-started", ...WORKFLOW_PROMPT_NAMES]);
  });

  it("renders base text without focus and lists workflow prompts", () => {
    const { messages } = promptsRender({});
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content.type).toBe("text");
    expect(messages[0].content.text).toContain("Safe usage");
    expect(messages[0].content.text).not.toContain("User focus");
    expect(messages[0].content.text).toContain("book-invoice");
    expect(messages[0].content.text).toContain("month-end-close");
  });

  it("includes focus section when provided", () => {
    const { messages } = promptsRender({ focus: "invoices" });
    expect(messages[0].content.text).toContain("invoices");
    expect(messages[0].content.text).toContain("User focus");
  });

  it("ignores a non-string focus value", () => {
    const { messages } = buildAllPrompts()["getting-started"].render({ focus: 12 });
    expect(messages[0].content.text).not.toContain("User focus");
  });
});

describe("normalizePromptArgValues", () => {
  it("trims values and treats blank strings as omitted", () => {
    expect(normalizePromptArgValues({ a: "  x  ", b: "   ", c: "ok" })).toEqual({
      a: "x",
      b: undefined,
      c: "ok",
    });
  });
});

describe("workflow prompt registration", () => {
  const prompts = buildAllPrompts();

  it.each(
    WORKFLOW_PROMPT_NAMES,
  )("%s has a description, argument metadata, and a schema", (name) => {
    const prompt = prompts[name];
    expect(prompt.description.length).toBeGreaterThan(20);
    expect(prompt.argsSchema).toBeDefined();
    expect(Array.isArray(prompt.arguments)).toBe(true);
  });

  it("declares required file_path on book-invoice and import-camt", () => {
    expect(arg(prompts["book-invoice"], "file_path")).toMatchObject({ required: true });
    expect(arg(prompts["import-camt"], "file_path")).toMatchObject({ required: true });
  });

  it("declares required month and identifier, and no required args on company-overview", () => {
    expect(arg(prompts["month-end-close"], "month")).toMatchObject({ required: true });
    expect(arg(prompts["new-supplier"], "identifier")).toMatchObject({ required: true });
    expect(prompts["company-overview"].arguments).toEqual([]);
  });

  it("renders book-invoice with the file path and OCR/upgrade fallbacks", () => {
    const text = renderText("book-invoice", { file_path: "/tmp/invoice.pdf" });
    expect(text).toContain("/tmp/invoice.pdf");
    expect(text).toContain("validate_invoice_data");
    expect(text).toContain("create_purchase_invoice");
    expect(text).toContain("register_purchase_invoice");
    expect(text).toContain("extract_pdf_invoice");
    expect(text).toContain("resolve_supplier");
    expect(text).toContain("suggest_booking");
    expect(text).toContain("Pro (or trial)");
    expect(text).toContain("explicitly approves");
  });

  it("renders month-end-close with the computed period and YTD range", () => {
    const text = renderText("month-end-close", { month: "2026-03" });
    expect(text).toContain("2026-03");
    expect(text).toContain("2026-03-01");
    expect(text).toContain("2026-03-31");
    expect(text).toContain("2026-01-01");
    expect(text).toContain("month_end_close_checklist");
    expect(text).toContain("find_missing_documents");
    expect(text).toContain("compute_profit_and_loss");
    expect(text).toContain("ready_to_close");
  });

  it("rejects an invalid month", () => {
    expect(() => renderText("month-end-close", { month: "2026-13" })).toThrow(/Expected YYYY-MM/);
  });

  it("renders reconcile-bank in auto mode by default and hints when no dimension is given", () => {
    const text = renderText("reconcile-bank", {});
    expect(text).toContain("Selected mode: auto");
    expect(text).toContain("list_account_dimensions");
    expect(text).toContain("analyze_unconfirmed_transactions");
    expect(text).toContain("mode=auto_confirm");
    expect(text).toContain("classify-unmatched");
    expect(text).toContain("No arguments were provided.");
  });

  it("renders reconcile-bank review mode with a dimension id and date range", () => {
    const text = renderText("reconcile-bank", {
      mode: "review",
      accounts_dimensions_id: 44,
      date_from: "2026-01-01",
      date_to: "2026-01-31",
    });
    expect(text).toContain("Selected mode: review");
    expect(text).toContain("44");
    expect(text).toContain("2026-01-01");
    expect(text).toContain("Use `accounts_dimensions_id` 44");
  });

  it("renders reconcile-bank transaction mode with a transaction id", () => {
    const text = renderText("reconcile-bank", { mode: "transaction", transaction_id: 99 });
    expect(text).toContain("Selected mode: transaction");
    expect(text).toContain("99");
  });

  it("rejects transaction mode without transaction_id", () => {
    expect(() => renderText("reconcile-bank", { mode: "transaction" })).toThrow(
      /transaction_id is required when mode is transaction/,
    );
  });

  it("rejects a reversed date range on reconcile-bank", () => {
    expect(() =>
      renderText("reconcile-bank", { date_from: "2026-02-01", date_to: "2026-01-01" }),
    ).toThrow(/date_from must be on or before date_to/);
  });

  it("renders import-camt with file path, dimension hint, and parse/dry_run/execute", () => {
    const text = renderText("import-camt", { file_path: "base64:xml:Zm9v" });
    expect(text).toContain("base64:xml:Zm9v");
    expect(text).toContain("mode=parse");
    expect(text).toContain("mode=dry_run");
    expect(text).toContain("mode=execute");
    expect(text).toContain("list_account_dimensions");
    expect(text).toContain("process_camt053");
  });

  it("renders import-camt with a provided dimension and dates", () => {
    const text = renderText("import-camt", {
      file_path: "/tmp/camt.xml",
      accounts_dimensions_id: "12",
      date_from: "2026-04-01",
      date_to: "2026-04-30",
    });
    expect(text).toContain("Use `accounts_dimensions_id` 12");
    expect(text).toContain("2026-04-01");
  });

  it("renders classify-unmatched with apply/review and start_date mapping", () => {
    const text = renderText("classify-unmatched", {
      accounts_dimensions_id: 7,
      date_from: "2026-05-01",
      date_to: "2026-05-31",
    });
    expect(text).toContain("classify_bank_transactions");
    expect(text).toContain("mode=classify");
    expect(text).toContain("mode=dry_run_apply");
    expect(text).toContain("mode=execute_apply");
    expect(text).toContain("start_date");
    expect(text).toContain("Use `accounts_dimensions_id` 7");
    expect(text).toContain("review-only");
  });

  it("renders classify-unmatched without a dimension", () => {
    const text = renderText("classify-unmatched", {});
    expect(text).toContain("list_account_dimensions");
    expect(text).toContain("No arguments were provided.");
  });

  it("renders new-supplier and treats an 8-digit identifier as a registry code", () => {
    const text = renderText("new-supplier", { identifier: "12345678" });
    expect(text).toContain("12345678");
    expect(text).toContain("8-digit Estonian business registry code");
    expect(text).toContain("create_client");
    expect(text).toContain("is_supplier: true");
    expect(text).toContain("is_physical_entity");
    expect(text).toContain("resolve_supplier");
  });

  it("renders new-supplier and treats a non-code identifier as a name", () => {
    const text = renderText("new-supplier", { identifier: "  Acme OÜ  " });
    expect(text).toContain("Acme OÜ");
    expect(text).toContain("supplier name (not an 8-digit registry code)");
  });

  it("renders company-overview as a read-only dashboard", () => {
    const text = renderText("company-overview", {});
    expect(text).toContain("get_vat_info");
    expect(text).toContain("financial_summary");
    expect(text).toContain("compute_balance_sheet");
    expect(text).toContain("compute_receivables_aging");
    expect(text).toContain("get_unprocessed_transactions");
    expect(text).toContain("must not create, update, register, or delete");
  });
});

function arg(prompt: { arguments?: { name: string; required?: boolean }[] }, name: string) {
  return prompt.arguments?.find((item) => item.name === name);
}

function renderText(name: string, args: Record<string, unknown>): string {
  return buildAllPrompts()[name].render(args).messages[0].content.text;
}

function promptsRender(args: Record<string, unknown>) {
  return buildAllPrompts()["getting-started"].render(args);
}
