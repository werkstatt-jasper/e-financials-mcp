import { createHash } from "node:crypto";
import { roundMoney } from "../money.js";
import type { Transaction } from "../types/transaction.js";
import type { ToolTransactionType } from "./transaction-direction.js";

export const WISE_MARKER_PREFIX = "[e-financials-mcp:wise";
export const WISE_DESCRIPTION_MAX_LEN = 150;

export type WiseEntryKind = "main" | "fee";

export interface WiseImportEntry {
  wiseId: string;
  kind: WiseEntryKind;
  date: string;
  type: ToolTransactionType;
  amount: number;
  currency: string;
  counterparty?: string;
  reference?: string;
  /** Operator-facing text, without the stored marker. */
  description: string;
}

export interface WiseDuplicateMatch {
  transaction_ids: number[];
  reason: string;
}

export interface WiseDuplicateIndex {
  byIdKind: Map<string, number[]>;
  bySignature: Map<string, number[]>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function amountKey(amount: number): string {
  return roundMoney(amount).toFixed(2);
}

export function normalizeWiseText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function wiseIdKindKey(wiseId: string, kind: WiseEntryKind): string {
  return `${kind}:${wiseId}`;
}

function signatureParts(entry: {
  date: string;
  type: string;
  currency: string;
  amount: number;
  counterparty?: string | null;
  reference?: string | null;
  description?: string | null;
}): string {
  return [
    entry.date,
    entry.type,
    entry.currency,
    amountKey(entry.amount),
    normalizeWiseText(entry.counterparty),
    normalizeWiseText(entry.reference),
    normalizeWiseText(entry.description),
  ].join("|");
}

const SIGNATURE_HEX_LEN = 16;

function selectWiseMarker(id: string, kind: WiseEntryKind, sig: string, maxLen: number): string {
  const variants = [
    formatMarker({ id, kind, sig }),
    formatMarker({ id: id.slice(0, 24), kind, sig }),
    formatMarker({ id: "", kind, sig }),
  ];
  let marker = formatMarker({ id: "", kind, sig });
  for (const candidate of variants) {
    if (candidate.length <= maxLen) {
      marker = candidate;
      break;
    }
  }
  return marker.slice(0, maxLen);
}

/**
 * Operator-facing text actually stored with the marker: escaped and sliced
 * to the budget that remains after the marker. Hash and signature fallback
 * must use this truncated form so re-imports still match.
 */
export function canonicalWiseDescription(
  entry: Pick<WiseImportEntry, "wiseId" | "kind" | "description">,
  maxLen = WISE_DESCRIPTION_MAX_LEN,
): string {
  const escaped = escapeWiseDescription(entry.description);
  if (escaped === "") {
    return "";
  }
  const placeholder = selectWiseMarker(
    entry.wiseId,
    entry.kind,
    "0".repeat(SIGNATURE_HEX_LEN),
    maxLen,
  );
  const budget = maxLen - placeholder.length - 1;
  if (budget <= 0) {
    return "";
  }
  return escaped.slice(0, budget);
}

function entrySignatureParts(entry: WiseImportEntry, maxLen = WISE_DESCRIPTION_MAX_LEN): string {
  return signatureParts({
    date: entry.date,
    type: entry.type,
    currency: entry.currency,
    amount: entry.amount,
    counterparty: entry.counterparty,
    reference: entry.reference,
    description: canonicalWiseDescription(entry, maxLen),
  });
}

export function wiseEntrySignatureHex(
  entry: WiseImportEntry,
  maxLen = WISE_DESCRIPTION_MAX_LEN,
): string {
  return sha256Hex(
    JSON.stringify([entry.wiseId, entry.kind, entrySignatureParts(entry, maxLen)]),
  ).slice(0, SIGNATURE_HEX_LEN);
}

export function escapeWiseDescription(text: string): string {
  return text.replace(/\[e-financials-mcp:wise/g, "\\[e-financials-mcp:wise");
}

function encodeField(value: string): string {
  return encodeURIComponent(value);
}

function decodeField(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatMarker(fields: { id: string; kind: WiseEntryKind; sig: string }): string {
  const body = [
    ["id", fields.id],
    ["kind", fields.kind],
    ["sig", fields.sig],
  ]
    .map(([key, value]) => `${key}=${encodeField(value)}`)
    .join(" | ");
  return `${WISE_MARKER_PREFIX} ${body}]`;
}

export function stripWiseMarker(description: string | null | undefined): string {
  if (description == null || description === "") {
    return "";
  }
  return description.replace(/\s*\[e-financials-mcp:wise[^\]]*\]/g, "").trim();
}

interface MarkerFields {
  id?: string;
  kind?: WiseEntryKind;
  sig?: string;
}

function parseMarkerBlock(description: string): MarkerFields | undefined {
  const match = description.match(/\[e-financials-mcp:wise([^\]]*)\]/);
  if (match == null) {
    return undefined;
  }
  const body = match[0].slice(WISE_MARKER_PREFIX.length, -1);
  const fields: MarkerFields = {};
  for (const part of body.split("|")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = decodeField(trimmed.slice(eq + 1).trim());
    if (key === "id") {
      fields.id = value;
    } else if (key === "kind" && (value === "main" || value === "fee")) {
      fields.kind = value;
    } else if (key === "sig") {
      fields.sig = value;
    }
  }
  return fields;
}

function isActiveTransaction(tx: Transaction): boolean {
  return tx.status !== "VOID" && tx.is_deleted !== true;
}

function trustedMarker(
  tx: Transaction,
): (MarkerFields & { id: string; kind: WiseEntryKind; sig: string }) | undefined {
  const marker = parseMarkerBlock(tx.description ?? "");
  if (marker?.id == null || marker.sig == null) {
    return undefined;
  }
  const kind = marker.kind ?? "main";
  const recomputed = sha256Hex(
    JSON.stringify([
      marker.id,
      kind,
      signatureParts({
        date: tx.date,
        type: tx.type,
        currency: tx.cl_currencies_id,
        amount: tx.amount,
        counterparty: tx.bank_account_name,
        reference: tx.ref_number,
        description: stripWiseMarker(tx.description),
      }),
    ]),
  ).slice(0, 16);
  if (recomputed !== marker.sig) {
    return undefined;
  }
  return { id: marker.id, kind, sig: marker.sig };
}

export function buildWiseDescription(
  entry: WiseImportEntry,
  maxLen = WISE_DESCRIPTION_MAX_LEN,
): string {
  const canonical = canonicalWiseDescription(entry, maxLen);
  const sig = wiseEntrySignatureHex(entry, maxLen);
  const marker = selectWiseMarker(entry.wiseId, entry.kind, sig, maxLen);
  if (canonical === "") {
    return marker;
  }
  return `${canonical} ${marker}`;
}

export function buildWiseDuplicateIndex(existing: Transaction[]): WiseDuplicateIndex {
  const byIdKind = new Map<string, number[]>();
  const bySignature = new Map<string, number[]>();

  const add = (map: Map<string, number[]>, key: string, id: number) => {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) {
      list.push(id);
    }
    map.set(key, list);
  };

  for (const tx of existing) {
    if (!isActiveTransaction(tx)) {
      continue;
    }
    const marker = trustedMarker(tx);
    if (marker?.id != null) {
      add(byIdKind, wiseIdKindKey(marker.id, marker.kind), tx.id);
    }
    add(
      bySignature,
      signatureParts({
        date: tx.date,
        type: tx.type,
        currency: tx.cl_currencies_id,
        amount: tx.amount,
        counterparty: tx.bank_account_name,
        reference: tx.ref_number,
        description: stripWiseMarker(tx.description),
      }),
      tx.id,
    );
  }

  return { byIdKind, bySignature };
}

export function findWiseDuplicate(
  entry: WiseImportEntry,
  index: WiseDuplicateIndex,
): WiseDuplicateMatch | undefined {
  const idKey = wiseIdKindKey(entry.wiseId, entry.kind);
  const idHits = index.byIdKind.get(idKey);
  if (idHits != null && idHits.length > 0) {
    return {
      transaction_ids: idHits,
      reason:
        entry.kind === "fee"
          ? "Fee already imported (Wise ID match)"
          : "Already imported (Wise ID match)",
    };
  }
  const sigKey = entrySignatureParts(entry);
  const sigHits = index.bySignature.get(sigKey);
  if (sigHits != null && sigHits.length > 0) {
    return {
      transaction_ids: sigHits,
      reason:
        entry.kind === "fee"
          ? "Fee already imported (date/amount/counterparty match)"
          : "Already imported (date/amount/counterparty/reference match)",
    };
  }
  return undefined;
}

export function rememberWiseEntry(index: WiseDuplicateIndex, entry: WiseImportEntry, id = 0): void {
  const add = (map: Map<string, number[]>, key: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) {
      list.push(id);
    }
    map.set(key, list);
  };
  add(index.byIdKind, wiseIdKindKey(entry.wiseId, entry.kind));
  add(index.bySignature, entrySignatureParts(entry));
}
