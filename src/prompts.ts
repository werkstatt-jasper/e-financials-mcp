import type { ZodType } from "zod";
import { WORKFLOW_PROMPTS } from "./workflow-prompts/index.js";

export type PromptArgumentDef = {
  name: string;
  description?: string;
  required?: boolean;
};

export type PromptMessage = {
  role: "user";
  content: {
    type: "text";
    text: string;
  };
};

export type PromptRenderResult = {
  messages: PromptMessage[];
};

export type PromptDef = {
  description: string;
  arguments?: PromptArgumentDef[];
  argsSchema?: ZodType;
  render: (args: Record<string, unknown>) => PromptRenderResult;
};

export type PromptRecord = Record<string, PromptDef>;

const GETTING_STARTED_TEXT = `You are connected to the e-Financials MCP server for the Estonian RIK e-Financials REST API.

## Capabilities
- **Tools** — accounting operations (transactions, clients, invoices, accounts, journals, products, reports, reference data).
- **Prompts** — guided workflows: \`getting-started\`, \`book-invoice\`, \`month-end-close\`, \`reconcile-bank\`, \`import-camt\`, \`classify-unmatched\`, \`new-supplier\`, and \`company-overview\`.
- **Resources** — read-only server metadata under the \`efinancials://\` URI scheme.

## Safe usage
1. Prefer **read/list** tools before create/update/delete operations.
2. Confirm company context and date ranges with the user before bulk queries or writes.
3. Treat API responses as authoritative; do not invent ledger balances or invoice numbers.
4. For write tools, summarize the intended change and ask for explicit approval when the user has not already requested it.
5. On errors, surface the API message and suggest a narrower query or corrected parameters.
6. If a workflow tool is missing (plan-gated or OCR/env-gated), skip that step, tell the user, and continue with the work that is still possible.

## Next steps
- Call \`list_tools\` (or inspect the tool catalog) and pick the smallest tool that answers the user's question.
- Use a named workflow prompt when the task is a multi-step flow (for example booking an invoice or closing a month).
- Read \`efinancials://server_info\` for server name, version, and capability summary.`;

export function collectPromptArgValues(
  args: Record<string, unknown> | undefined,
): Record<string, string> {
  const argValues: Record<string, string> = {};
  if (!args) {
    return argValues;
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      argValues[key] = value;
    }
  }
  return argValues;
}

/** Trim values and treat blank strings as omitted so optional Zod fields stay optional. */
export function normalizePromptArgValues(
  args: Record<string, string>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(args)) {
    const trimmed = value.trim();
    normalized[key] = trimmed.length > 0 ? trimmed : undefined;
  }
  return normalized;
}

export function buildAllPrompts(): PromptRecord {
  return {
    "getting-started": {
      description:
        "Introduce the e-Financials MCP tool surface, prompts/resources, and safe-usage conventions.",
      arguments: [
        {
          name: "focus",
          description:
            "Optional topic to emphasize (e.g. invoices, bank, VAT). Included in the prompt when provided.",
          required: false,
        },
      ],
      render: (args) => {
        const focus = typeof args.focus === "string" ? args.focus.trim() : "";
        const text =
          focus.length > 0
            ? `${GETTING_STARTED_TEXT}\n\n## User focus\nThe user asked to emphasize: **${focus}**. Prioritize tools and guidance relevant to that area while still following the safety rules above.`
            : GETTING_STARTED_TEXT;
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text },
            },
          ],
        };
      },
    },
    ...WORKFLOW_PROMPTS,
  };
}
