export const EFINANCIALS_URI_SCHEME = "efinancials://";

export type ResourceReadResult = {
  uri: string;
  mimeType: string;
  text: string;
};

export type StaticResourceDef = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => ResourceReadResult;
};

export type ResourceTemplateDef = {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  read: (uri: string, vars: Record<string, string>) => ResourceReadResult;
};

export type ResourceRegistry = {
  resources: Record<string, StaticResourceDef>;
  templates: Record<string, ResourceTemplateDef>;
};

const SERVER_NAME = "e-financials";
const SERVER_VERSION = "1.0.0";

/**
 * Match a URI against an MCP-style template with `{var}` segments.
 * Returns captured variables or `null` when the URI does not match.
 */
export function matchUriTemplate(uriTemplate: string, uri: string): Record<string, string> | null {
  const parts = uriTemplate.split(/(\{[^}]+\})/);
  let pattern = "^";
  const varNames: string[] = [];

  for (const part of parts) {
    if (part.startsWith("{") && part.endsWith("}")) {
      const name = part.slice(1, -1);
      varNames.push(name);
      pattern += "([^/]+)";
      continue;
    }
    pattern += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  pattern += "$";

  const match = new RegExp(pattern).exec(uri);
  if (!match) {
    return null;
  }

  const vars: Record<string, string> = {};
  for (let i = 0; i < varNames.length; i += 1) {
    vars[varNames[i]] = decodeURIComponent(match[i + 1] ?? "");
  }
  return vars;
}

function buildServerInfoPayload(): ResourceReadResult {
  const payload = {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    uriScheme: EFINANCIALS_URI_SCHEME,
    capabilities: ["tools", "prompts", "resources"],
    description:
      "MCP server for the Estonian RIK e-Financials REST API (placeholder metadata; no tenant/API call).",
  };
  const uri = `${EFINANCIALS_URI_SCHEME}server_info`;
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(payload, null, 2),
  };
}

export function buildAllResources(): ResourceRegistry {
  return {
    resources: {
      server_info: {
        uri: `${EFINANCIALS_URI_SCHEME}server_info`,
        name: "server_info",
        description: "Server name, version, and capability summary (no API call).",
        mimeType: "application/json",
        read: buildServerInfoPayload,
      },
    },
    templates: {},
  };
}
