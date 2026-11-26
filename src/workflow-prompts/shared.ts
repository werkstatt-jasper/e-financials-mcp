import { type ZodType, z } from "zod";
import type { PromptArgumentDef, PromptDef, PromptRenderResult } from "../prompts.js";
import { parseToolArgs } from "../validation/tool-args.js";

/** Calendar month `YYYY-MM` (01–12 only). */
export const yearMonthString = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM")
  .describe('Month in YYYY-MM format, e.g. "2026-03"');

export const WORKFLOW_GUARDRAILS = `## How to run this workflow
- Check the current tool list before every call. If a tool named below is missing, do not abort the workflow: skip that step, tell the user what could not be done, and continue with the steps that are still available.
- Some write or batch tools are limited to the Pro plan. If a tool is missing or returns an upgrade or permission error, explain that the step needs a Pro (or trial) upgrade and keep going with any remaining read-only work.
- Document-extraction / OCR tools may be env-gated or not installed. If they are missing, ask the user for the needed fields from the source document instead of failing.
- Stay in a preview or dry-run posture until the user explicitly approves a mutation. Only then call the execute or register tool, using the same previewed values. Never invent VAT treatment, supplier identity, or ledger amounts; treat API responses as authoritative.
- Prefer the smallest read tool that answers the question. On errors, surface the API message and suggest a narrower query or corrected parameters.`;

export function promptMessage(text: string): PromptRenderResult {
  return {
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}

function schemaIsOptional(schema: z.ZodType): boolean {
  return schema.safeParse(undefined).success;
}

function schemaDescription(schema: z.ZodType): string | undefined {
  if (schema.description) {
    return schema.description;
  }
  if ("unwrap" in schema && typeof schema.unwrap === "function") {
    return (schema.unwrap() as z.ZodType).description;
  }
  return undefined;
}

/** MCP prompt argument metadata derived from a Zod object schema (single source with the parser). */
export function promptArgumentDefs(schema: z.ZodObject<z.ZodRawShape>): PromptArgumentDef[] {
  return Object.entries(schema.shape).map(([name, field]) => {
    const typed = field as z.ZodType;
    const description = schemaDescription(typed);
    const def: PromptArgumentDef = {
      name,
      required: !schemaIsOptional(typed),
    };
    if (description) {
      def.description = description;
    }
    return def;
  });
}

export function formatProvidedArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== "");
  const lines = ["## Run arguments"];
  if (entries.length === 0) {
    lines.push("No arguments were provided.");
    return lines.join("\n");
  }
  for (const [key, value] of entries) {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`- \`${key}\`: ${rendered}`);
  }
  return lines.join("\n");
}

export function missingDimensionHint(accountsDimensionsId: number | undefined): string {
  if (accountsDimensionsId != null) {
    return `Use \`accounts_dimensions_id\` ${accountsDimensionsId} on the tools that accept it.`;
  }
  return "No `accounts_dimensions_id` was provided. Call `list_account_dimensions` (and `get_bank_accounts` if useful), then ask the user to confirm the bank account before dry-run or execute steps that require a dimension id.";
}

export function withDateRangeOrder<S extends z.ZodObject<z.ZodRawShape>>(schema: S): z.ZodType {
  return schema.superRefine((value, ctx) => {
    const record = value as { date_from?: string; date_to?: string };
    if (record.date_from && record.date_to && record.date_from > record.date_to) {
      ctx.addIssue({
        code: "custom",
        message: "date_from must be on or before date_to",
        path: ["date_from"],
      });
    }
  });
}

export function definePrompt<S extends z.ZodObject<z.ZodRawShape>>(
  description: string,
  objectSchema: S,
  renderText: (args: z.infer<S>) => string,
  parsedSchema: ZodType = objectSchema,
): PromptDef {
  return {
    description,
    arguments: promptArgumentDefs(objectSchema),
    argsSchema: parsedSchema,
    render: (args) => promptMessage(renderText(parseToolArgs(parsedSchema, args) as z.infer<S>)),
  };
}
