import { XMLParser } from "fast-xml-parser";
import { roundMoney } from "../money.js";

export const DEFAULT_MAX_CAMT_ENTRIES = 50_000;

export type CamtDirection = "CRDT" | "DBIT";

export interface CamtBalance {
  amount: number;
  currency: string;
  date?: string;
  credit_debit?: string;
}

export interface CamtStatementMetadata {
  statement_id?: string;
  iban: string;
  currency?: string;
  bank_bic?: string;
  bank_name?: string;
  period: { from?: string; to?: string };
  opening_balance?: CamtBalance;
  closing_balance?: CamtBalance;
}

export interface CamtEntry {
  date: string;
  amount: number;
  currency: string;
  direction: CamtDirection;
  original_amount?: number;
  original_currency?: string;
  counterparty_name?: string;
  counterparty_iban?: string;
  counterparty_reg_code?: string;
  description?: string;
  reference_number?: string;
  end_to_end_id?: string;
  bank_reference?: string;
}

export interface CamtParseResult {
  statement_metadata: CamtStatementMetadata;
  entries: CamtEntry[];
}

export interface ParseCamt053Options {
  maxEntries?: number;
}

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asNode(value: unknown): XmlNode | undefined {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as XmlNode;
  }
  return undefined;
}

function xmlText(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    const s = value.trim();
    return s === "" ? undefined : s;
  }
  const node = asNode(value);
  if (node == null) {
    return undefined;
  }
  return xmlText(node["#text"]);
}

function xmlAttr(value: unknown, name: string): string | undefined {
  const node = asNode(value);
  if (node == null) {
    return undefined;
  }
  return xmlText(node[`@_${name}`]);
}

function parseAmount(value: unknown): number {
  const raw = xmlText(value);
  if (raw == null) {
    throw new Error("CAMT.053 entry is missing an amount");
  }
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) {
    throw new Error(`CAMT.053 amount is not a number: ${raw}`);
  }
  return n;
}

function isoDate(value: unknown): string | undefined {
  const raw = xmlText(value);
  if (raw == null) {
    return undefined;
  }
  return raw.slice(0, 10);
}

function bookingDate(ntry: XmlNode): string {
  const bookg = asNode(ntry.BookgDt);
  const date = isoDate(bookg?.Dt) ?? isoDate(bookg?.DtTm);
  if (date == null) {
    throw new Error("CAMT.053 entry is missing a booking date");
  }
  return date;
}

export function normalizeReference(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (trimmed == null || trimmed === "") {
    return undefined;
  }
  if (trimmed.toUpperCase() === "NOTPROVIDED") {
    return undefined;
  }
  return trimmed;
}

function directionOf(ntry: XmlNode): CamtDirection {
  const ind = xmlText(ntry.CdtDbtInd);
  if (ind !== "CRDT" && ind !== "DBIT") {
    throw new Error(`CAMT.053 entry has invalid CdtDbtInd: ${ind ?? "(missing)"}`);
  }
  return ind;
}

function amountCurrency(amtNode: unknown, fallback: string): { amount: number; currency: string } {
  return {
    amount: parseAmount(amtNode),
    currency: xmlAttr(amtNode, "Ccy") ?? fallback,
  };
}

function pickOriginalAmount(tx: XmlNode | undefined): {
  original_amount?: number;
  original_currency?: string;
} {
  if (tx == null) {
    return {};
  }
  const amtDtls = asNode(tx.AmtDtls);
  const txAmt = asNode(amtDtls?.TxAmt)?.Amt ?? asNode(amtDtls?.InstdAmt)?.Amt;
  if (txAmt == null) {
    return {};
  }
  const currency = xmlAttr(txAmt, "Ccy");
  return {
    original_amount: parseAmount(txAmt),
    original_currency: currency,
  };
}

function orgOthers(party: XmlNode | undefined): XmlNode[] {
  const id = asNode(party?.Id);
  const orgId = asNode(id?.OrgId);
  return asArray(orgId?.Othr)
    .map(asNode)
    .filter((n): n is XmlNode => n != null);
}

function counterpartyRegCode(party: XmlNode | undefined): string | undefined {
  for (const othr of orgOthers(party)) {
    const schemeCd = xmlText(asNode(othr.SchmeNm)?.Cd);
    if (schemeCd === "COID") {
      return xmlText(othr.Id);
    }
  }
  return undefined;
}

function relatedParties(
  tx: XmlNode | undefined,
  direction: CamtDirection,
): {
  counterparty_name?: string;
  counterparty_iban?: string;
  counterparty_reg_code?: string;
} {
  const rltd = asNode(tx?.RltdPties);
  const party = direction === "CRDT" ? asNode(rltd?.Dbtr) : asNode(rltd?.Cdtr);
  const acct = direction === "CRDT" ? asNode(rltd?.DbtrAcct) : asNode(rltd?.CdtrAcct);
  const name = xmlText(party?.Nm);
  const iban = xmlText(asNode(acct?.Id)?.IBAN);
  const reg = counterpartyRegCode(party);
  return {
    counterparty_name: name,
    counterparty_iban: iban,
    counterparty_reg_code: reg,
  };
}

function remittance(tx: XmlNode | undefined): {
  description?: string;
  reference_number?: string;
} {
  const rmt = asNode(tx?.RmtInf);
  const ustrd = asArray(rmt?.Ustrd)
    .map(xmlText)
    .filter((s): s is string => s != null);
  const description = ustrd.length > 0 ? ustrd.join(" | ") : undefined;
  const strd = asArray(rmt?.Strd);
  let reference_number: string | undefined;
  for (const block of strd) {
    const ref = xmlText(asNode(asNode(block)?.CdtrRefInf)?.Ref);
    if (ref != null) {
      reference_number = ref;
      break;
    }
  }
  return { description, reference_number };
}

function splitBookedAmount(total: number, weights: number[]): number[] {
  const positive = weights.every((w) => w > 0);
  const used = positive ? weights : weights.map(() => 1);
  const sum = used.reduce((a, b) => a + b, 0);
  const allocated: number[] = [];
  let running = 0;
  for (const [i, weight] of used.entries()) {
    if (i === used.length - 1) {
      allocated.push(roundMoney(total - running));
    } else {
      const part = roundMoney(total * (weight / sum));
      allocated.push(part);
      running = roundMoney(running + part);
    }
  }
  return allocated;
}

function flattenTxDetails(ntry: XmlNode): Array<XmlNode | undefined> {
  const blocks = asArray(ntry.NtryDtls);
  const details: XmlNode[] = [];
  for (const block of blocks) {
    const node = asNode(block);
    if (node == null) {
      continue;
    }
    for (const tx of asArray(node.TxDtls)) {
      if (tx === "") {
        details.push({});
        continue;
      }
      const txNode = asNode(tx);
      if (txNode != null) {
        details.push(txNode);
      }
    }
  }
  return details.length > 0 ? details : [undefined];
}

function parseBalance(bal: XmlNode, fallbackCcy: string): CamtBalance {
  const amt = amountCurrency(bal.Amt, fallbackCcy);
  const dt = asNode(bal.Dt);
  return {
    amount: amt.amount,
    currency: amt.currency,
    date: isoDate(dt?.Dt) ?? isoDate(dt?.DtTm),
    credit_debit: xmlText(bal.CdtDbtInd),
  };
}

function parseStatement(stmt: XmlNode, maxEntries: number): CamtParseResult {
  const acct = asNode(stmt.Acct);
  const iban = xmlText(asNode(acct?.Id)?.IBAN);
  if (iban == null) {
    throw new Error("CAMT.053 statement is missing account IBAN");
  }
  const accountCcy = xmlText(acct?.Ccy) ?? "EUR";
  const svcr = asNode(asNode(acct?.Svcr)?.FinInstnId);
  const frTo = asNode(stmt.FrToDt);
  const period = {
    from: isoDate(frTo?.FrDtTm) ?? isoDate(frTo?.FrDt),
    to: isoDate(frTo?.ToDtTm) ?? isoDate(frTo?.ToDt),
  };

  let opening_balance: CamtBalance | undefined;
  let closing_balance: CamtBalance | undefined;
  for (const raw of asArray(stmt.Bal)) {
    const bal = asNode(raw);
    if (bal == null) {
      continue;
    }
    const code = xmlText(asNode(asNode(bal.Tp)?.CdOrPrtry)?.Cd);
    if (code === "OPBD") {
      opening_balance = parseBalance(bal, accountCcy);
    } else if (code === "CLBD") {
      closing_balance = parseBalance(bal, accountCcy);
    }
  }

  const entries: CamtEntry[] = [];
  for (const raw of asArray(stmt.Ntry)) {
    const ntry = asNode(raw);
    if (ntry == null) {
      continue;
    }
    const dir = directionOf(ntry);
    const booked = amountCurrency(ntry.Amt, accountCcy);
    const date = bookingDate(ntry);
    const ntryBankRef = normalizeReference(xmlText(ntry.AcctSvcrRef));
    const details = flattenTxDetails(ntry);
    const originals = details.map((tx) => pickOriginalAmount(tx).original_amount ?? 0);
    const split = splitBookedAmount(booked.amount, originals);

    for (const [i, tx] of details.entries()) {
      const refs = asNode(tx?.Refs);
      const endToEnd = normalizeReference(xmlText(refs?.EndToEndId));
      const txBankRef = normalizeReference(xmlText(refs?.AcctSvcrRef));
      const rmt = remittance(tx);
      const parties = relatedParties(tx, dir);
      const original = pickOriginalAmount(tx);
      const reference_number = normalizeReference(rmt.reference_number) ?? endToEnd;
      entries.push({
        date,
        amount: split[i],
        currency: booked.currency,
        direction: dir,
        original_amount: original.original_amount,
        original_currency: original.original_currency,
        counterparty_name: parties.counterparty_name,
        counterparty_iban: parties.counterparty_iban,
        counterparty_reg_code: parties.counterparty_reg_code,
        description: rmt.description,
        reference_number,
        end_to_end_id: endToEnd,
        bank_reference: txBankRef ?? ntryBankRef,
      });
      if (entries.length > maxEntries) {
        throw new Error(`CAMT.053 has more than ${maxEntries} entries`);
      }
    }
  }

  return {
    statement_metadata: {
      statement_id: xmlText(stmt.Id),
      iban,
      currency: accountCcy,
      bank_bic: xmlText(svcr?.BIC),
      bank_name: xmlText(svcr?.Nm),
      period,
      opening_balance,
      closing_balance,
    },
    entries,
  };
}

/**
 * Parse ISO 20022 CAMT.053 XML into statement metadata and flattened entries.
 */
export function parseCamt053(xml: string, options: ParseCamt053Options = {}): CamtParseResult {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CAMT_ENTRIES;
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new Error("CAMT.053 XML with DOCTYPE or ENTITY declarations is not allowed");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    trimValues: true,
    parseTagValue: false,
  });
  const parsed: unknown = parser.parse(xml);
  const root = asNode(parsed);
  const document = asNode(root?.Document) ?? root;
  const rawContainer = document?.BkToCstmrStmt;
  if (rawContainer == null) {
    throw new Error("Not a CAMT.053 document (missing BkToCstmrStmt)");
  }
  const container = asNode(rawContainer) ?? {};
  const stmts = asArray(container.Stmt)
    .map(asNode)
    .filter((n): n is XmlNode => n != null);
  const stmt = stmts[0];
  if (stmt == null) {
    throw new Error("CAMT.053 document has no statement");
  }
  if (stmts.length > 1) {
    throw new Error("CAMT.053 file has multiple statements — split into separate files");
  }
  return parseStatement(stmt, maxEntries);
}
