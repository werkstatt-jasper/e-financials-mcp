import { createHash } from "node:crypto";
import { roundMoney } from "../money.js";
import type { Transaction } from "../types/transaction.js";
import type { CamtDirection, CamtEntry } from "./camt053-parser.js";

export const CAMT_MARKER_PREFIX = "[e-financials-mcp:camt";
export const DESCRIPTION_MAX_LEN = 150;

export type DuplicateKind = "exact" | "bank_ref" | "batch";

export interface DuplicateMatch {
  kind: DuplicateKind;
  transaction_ids: number[];
  reason: string;
}

export interface PossibleDuplicateMatch {
  id: number;
  status: Transaction["status"];
  match_reasons: string[];
}

export interface DuplicateIndex {
  exactByKey: Map<string, number[]>;
  byBankRefHash: Map<string, number[]>;
  possibleByAmountKey: Map<string, Transaction[]>;
  repeatedBankReferences: Set<string>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function bankReferenceHash(normalizedRef: string): string {
  return `sha256:${sha256Hex(normalizedRef)}`;
}

/** RIK: C = money in (CAMT CRDT), D = money out (CAMT DBIT). */
export function transactionTypeFromDirection(direction: CamtDirection): "C" | "D" {
  return direction === "CRDT" ? "C" : "D";
}

export function stripCamtMarker(description: string | null | undefined): string {
  if (description == null || description === "") {
    return "";
  }
  return description.replace(/\s*\[e-financials-mcp:camt[^\]]*\]/g, "").trim();
}

export function normalizeMatchText(value: string | null | undefined): string {
  return stripCamtMarker(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function amountKey(amount: number): string {
  return roundMoney(amount).toFixed(2);
}

function pipeJoin(parts: Array<string | undefined>): string {
  return parts.map((p) => p ?? "").join("|");
}

export function entryExactKey(entry: CamtEntry): string {
  const type = transactionTypeFromDirection(entry.direction);
  const refKey = entry.bank_reference ? bankReferenceHash(entry.bank_reference) : "";
  return pipeJoin([
    refKey,
    entry.date,
    type,
    entry.currency,
    amountKey(entry.amount),
    normalizeMatchText(entry.reference_number),
    normalizeMatchText(entry.counterparty_iban),
    normalizeMatchText(entry.counterparty_name),
    normalizeMatchText(entry.description),
  ]);
}

export function entryBatchKey(entry: CamtEntry): string {
  return pipeJoin([
    entry.bank_reference,
    entry.date,
    entry.direction,
    entry.currency,
    amountKey(entry.amount),
    entry.reference_number,
    entry.end_to_end_id,
    entry.counterparty_iban,
    entry.counterparty_name,
    entry.description,
  ]);
}

function amountTypeKey(tx: {
  date: string;
  type: string;
  cl_currencies_id: string;
  amount: number;
}): string {
  return pipeJoin([tx.date, tx.type, tx.cl_currencies_id, amountKey(tx.amount)]);
}

function entryAmountTypeKey(entry: CamtEntry): string {
  return pipeJoin([
    entry.date,
    transactionTypeFromDirection(entry.direction),
    entry.currency,
    amountKey(entry.amount),
  ]);
}

function signaturePayload(args: {
  bankRefHash: string;
  date: string;
  type: string;
  currency: string;
  amount: number;
  reference_number?: string | null;
  iban?: string | null;
  name?: string | null;
  description?: string | null;
}): string[] {
  return [
    args.bankRefHash,
    args.date,
    args.type,
    args.currency,
    amountKey(args.amount),
    normalizeMatchText(args.reference_number),
    normalizeMatchText(args.iban),
    normalizeMatchText(args.name),
    normalizeMatchText(args.description),
  ];
}

export function entrySignatureHex(entry: CamtEntry): string {
  return sha256Hex(
    JSON.stringify(
      signaturePayload({
        bankRefHash: entry.bank_reference ? bankReferenceHash(entry.bank_reference) : "",
        date: entry.date,
        type: transactionTypeFromDirection(entry.direction),
        currency: entry.currency,
        amount: entry.amount,
        reference_number: entry.reference_number,
        iban: entry.counterparty_iban,
        name: entry.counterparty_name,
        description: entry.description,
      }),
    ),
  ).slice(0, 16);
}

interface MarkerFields {
  br?: string;
  brh?: string;
  iban?: string;
  sig?: string;
}

function decodeField(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseMarkerBlock(description: string): MarkerFields | undefined {
  const match = description.match(/\[e-financials-mcp:camt([^\]]*)\]/);
  if (match == null) {
    return undefined;
  }
  const body = match[0].slice(CAMT_MARKER_PREFIX.length, -1);
  const fields: MarkerFields = {};
  for (const part of body.split("|")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = decodeField(trimmed.slice(eq + 1).trim());
    if (key === "br" || key === "bank_ref_number") {
      fields.br = value;
    } else if (key === "brh" || key === "bank_ref_hash") {
      fields.brh = value;
    } else if (key === "iban" || key === "bank_account_no") {
      fields.iban = value;
    } else if (key === "sig" || key === "entry_sig") {
      fields.sig = value;
    }
  }
  return fields;
}

function storedBankRefKey(tx: Transaction): string {
  const direct = tx.bank_ref_number?.trim();
  if (direct) {
    return bankReferenceHash(direct);
  }
  const marker = parseMarkerBlock(tx.description);
  if (marker?.sig == null) {
    return "";
  }
  const bankRefHash = marker.brh ?? (marker.br ? bankReferenceHash(marker.br) : "");
  const recomputed = sha256Hex(
    JSON.stringify(
      signaturePayload({
        bankRefHash,
        date: tx.date,
        type: tx.type,
        currency: tx.cl_currencies_id,
        amount: tx.amount,
        reference_number: tx.ref_number,
        iban: marker.iban ?? tx.bank_account_no,
        name: tx.bank_account_name,
        description: stripCamtMarker(tx.description),
      }),
    ),
  ).slice(0, 16);
  if (recomputed !== marker.sig) {
    return "";
  }
  return bankRefHash;
}

function isActiveTransaction(tx: Transaction): boolean {
  return tx.status !== "VOID" && tx.is_deleted !== true;
}

export function buildDuplicateIndex(
  existing: Transaction[],
  entries: CamtEntry[],
  accountsDimensionsId?: number,
): DuplicateIndex {
  const exactByKey = new Map<string, number[]>();
  const byBankRefHash = new Map<string, number[]>();
  const possibleByAmountKey = new Map<string, Transaction[]>();

  for (const tx of existing) {
    if (!isActiveTransaction(tx)) {
      continue;
    }
    const refKey = storedBankRefKey(tx);
    const exactKey = pipeJoin([
      refKey,
      tx.date,
      tx.type,
      tx.cl_currencies_id,
      amountKey(tx.amount),
      normalizeMatchText(tx.ref_number),
      normalizeMatchText(tx.bank_account_no),
      normalizeMatchText(tx.bank_account_name),
      normalizeMatchText(stripCamtMarker(tx.description)),
    ]);
    const exactList = exactByKey.get(exactKey) ?? [];
    exactList.push(tx.id);
    exactByKey.set(exactKey, exactList);

    if (refKey) {
      const refList = byBankRefHash.get(refKey) ?? [];
      refList.push(tx.id);
      byBankRefHash.set(refKey, refList);
    }

    const dimOk =
      accountsDimensionsId == null || tx.accounts_dimensions_id === accountsDimensionsId;
    const noDirectRef = !tx.bank_ref_number?.trim();
    if (dimOk && noDirectRef) {
      const k = amountTypeKey(tx);
      const list = possibleByAmountKey.get(k) ?? [];
      list.push(tx);
      possibleByAmountKey.set(k, list);
    }
  }

  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.bank_reference) {
      counts.set(entry.bank_reference, (counts.get(entry.bank_reference) ?? 0) + 1);
    }
  }
  const repeatedBankReferences = new Set<string>();
  for (const [ref, n] of counts) {
    if (n > 1) {
      repeatedBankReferences.add(ref);
    }
  }

  return { exactByKey, byBankRefHash, possibleByAmountKey, repeatedBankReferences };
}

export function findExactDuplicate(
  entry: CamtEntry,
  index: DuplicateIndex,
): DuplicateMatch | undefined {
  const ids = index.exactByKey.get(entryExactKey(entry));
  if (ids != null && ids.length > 0) {
    return {
      kind: "exact",
      transaction_ids: ids,
      reason: "Existing transaction matched by bank reference",
    };
  }
  if (entry.bank_reference && !index.repeatedBankReferences.has(entry.bank_reference)) {
    const hashed = bankReferenceHash(entry.bank_reference);
    const refIds = index.byBankRefHash.get(hashed);
    if (refIds != null && refIds.length > 0) {
      return {
        kind: "bank_ref",
        transaction_ids: refIds,
        reason: "Existing transaction matched by bank reference",
      };
    }
  }
  return undefined;
}

export function findPossibleDuplicates(
  entry: CamtEntry,
  index: DuplicateIndex,
): PossibleDuplicateMatch[] {
  const candidates = index.possibleByAmountKey.get(entryAmountTypeKey(entry)) ?? [];
  const out: PossibleDuplicateMatch[] = [];
  for (const tx of candidates) {
    const reasons: string[] = [];
    if (
      entry.reference_number &&
      normalizeMatchText(tx.ref_number) === normalizeMatchText(entry.reference_number)
    ) {
      reasons.push("reference_number");
    }
    if (
      entry.counterparty_iban &&
      normalizeMatchText(tx.bank_account_no) === normalizeMatchText(entry.counterparty_iban)
    ) {
      reasons.push("counterparty_iban");
    }
    if (
      entry.counterparty_name &&
      normalizeMatchText(tx.bank_account_name) === normalizeMatchText(entry.counterparty_name)
    ) {
      reasons.push("counterparty_name");
    }
    if (
      entry.description &&
      normalizeMatchText(tx.description) === normalizeMatchText(entry.description)
    ) {
      reasons.push("description");
    }
    if (reasons.length > 0) {
      out.push({ id: tx.id, status: tx.status, match_reasons: reasons });
    }
  }
  return out;
}

function encodeField(value: string): string {
  return encodeURIComponent(value);
}

function markerBody(parts: Array<[string, string | undefined]>): string {
  return parts
    .filter((pair): pair is [string, string] => pair[1] != null && pair[1] !== "")
    .map(([k, v]) => `${k}=${encodeField(v)}`)
    .join(" | ");
}

function formatMarker(fields: { br?: string; brh?: string; iban?: string; sig: string }): string {
  const body = markerBody([
    ["br", fields.br],
    ["brh", fields.brh],
    ["iban", fields.iban],
    ["sig", fields.sig],
  ]);
  return `${CAMT_MARKER_PREFIX} ${body}]`;
}

export function buildCamtDescription(entry: CamtEntry): string | undefined {
  const userRaw = entry.description ?? "";
  const escaped = userRaw.replace(/\[e-financials-mcp:camt/g, "\\[e-financials-mcp:camt");
  const sig = entrySignatureHex(entry);
  const brh = entry.bank_reference ? bankReferenceHash(entry.bank_reference) : undefined;
  if (!entry.bank_reference && !entry.counterparty_iban) {
    return escaped === "" ? undefined : escaped.slice(0, DESCRIPTION_MAX_LEN);
  }

  const variants: Array<{ br?: string; brh?: string; iban?: string }> = [
    { br: entry.bank_reference, iban: entry.counterparty_iban },
    { br: entry.bank_reference },
    { brh, iban: entry.counterparty_iban },
    { brh },
    { iban: entry.counterparty_iban },
    {},
  ];

  let marker = formatMarker({ sig });
  for (const fields of variants) {
    const candidate = formatMarker({ ...fields, sig });
    if (candidate.length <= DESCRIPTION_MAX_LEN) {
      marker = candidate;
      break;
    }
  }
  if (escaped === "") {
    return marker;
  }
  const budget = DESCRIPTION_MAX_LEN - marker.length - 1;
  if (budget <= 0) {
    return marker;
  }
  return `${escaped.slice(0, budget)} ${marker}`;
}

export function isTrustedCamtMarker(tx: Transaction): boolean {
  return storedBankRefKey(tx) !== "" && !tx.bank_ref_number?.trim();
}
