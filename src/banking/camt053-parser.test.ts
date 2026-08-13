import { describe, expect, it } from "vitest";
import { parseCamt053 } from "./camt053-parser.js";

function wrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT1</Id>
      <FrToDt><FrDt>2025-06-01</FrDt><ToDt>2025-06-30</ToDt></FrToDt>
      <Acct>
        <Id><IBAN>EE123456789</IBAN></Id>
        <Ccy>EUR</Ccy>
        <Svcr><FinInstnId><BIC>LHVBEE22</BIC><Nm>LHV</Nm></FinInstnId></Svcr>
      </Acct>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">1000.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt><Dt>2025-06-01</Dt></Dt>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">1100.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt><DtTm>2025-06-30T23:59:00</DtTm></Dt>
      </Bal>
      ${inner}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

describe("parseCamt053", () => {
  it("parses a single credit entry without TxDtls", () => {
    const xml = wrap(`
      <Ntry>
        <Amt Ccy="EUR">25.50</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2025-06-05</Dt></BookgDt>
        <AcctSvcrRef>BANKREF1</AcctSvcrRef>
      </Ntry>`);
    const result = parseCamt053(xml);
    expect(result.statement_metadata).toMatchObject({
      statement_id: "STMT1",
      iban: "EE123456789",
      currency: "EUR",
      bank_bic: "LHVBEE22",
      bank_name: "LHV",
      period: { from: "2025-06-01", to: "2025-06-30" },
    });
    expect(result.statement_metadata.opening_balance?.amount).toBe(1000);
    expect(result.statement_metadata.closing_balance?.date).toBe("2025-06-30");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      date: "2025-06-05",
      amount: 25.5,
      currency: "EUR",
      direction: "CRDT",
      bank_reference: "BANKREF1",
    });
  });

  it("extracts counterparties, remittance, and EndToEndId for CRDT and DBIT", () => {
    const xml = wrap(`
      <Ntry>
        <Amt Ccy="EUR">10</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><DtTm>2025-06-06T12:00:00</DtTm></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><AcctSvcrRef>TXREF</AcctSvcrRef><EndToEndId>E2E1</EndToEndId></Refs>
          <RltdPties>
            <Dbtr>
              <Nm>Acme OÜ</Nm>
              <Id><OrgId><Othr><Id>12345678</Id><SchmeNm><Cd>COID</Cd></SchmeNm></Othr></OrgId></Id>
            </Dbtr>
            <DbtrAcct><Id><IBAN>EE999</IBAN></Id></DbtrAcct>
          </RltdPties>
          <RmtInf>
            <Ustrd>Invoice</Ustrd>
            <Ustrd>A1</Ustrd>
            <Strd></Strd>
            <Strd><CdtrRefInf><Ref>RF123</Ref></CdtrRefInf></Strd>
          </RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">4</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2025-06-07</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
          <RltdPties>
            <Cdtr><Nm>Supplier</Nm></Cdtr>
            <CdtrAcct><Id><IBAN>EE888</IBAN></Id></CdtrAcct>
          </RltdPties>
        </TxDtls></NtryDtls>
      </Ntry>`);
    const result = parseCamt053(xml);
    expect(result.entries[0]).toMatchObject({
      date: "2025-06-06",
      bank_reference: "TXREF",
      end_to_end_id: "E2E1",
      reference_number: "RF123",
      description: "Invoice | A1",
      counterparty_name: "Acme OÜ",
      counterparty_iban: "EE999",
      counterparty_reg_code: "12345678",
    });
    expect(result.entries[1]).toMatchObject({
      direction: "DBIT",
      counterparty_name: "Supplier",
      counterparty_iban: "EE888",
      end_to_end_id: undefined,
    });
  });

  it("splits batched TxDtls proportionally by original amounts", () => {
    const xml = wrap(`
      <Ntry>
        <Amt Ccy="EUR">27</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2025-06-08</Dt></BookgDt>
        <AcctSvcrRef>PARENT</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <AmtDtls><TxAmt><Amt Ccy="USD">10</Amt></TxAmt></AmtDtls>
          </TxDtls>
          <TxDtls>
            <AmtDtls><InstdAmt><Amt Ccy="USD">20</Amt></InstdAmt></AmtDtls>
          </TxDtls>
        </NtryDtls>
      </Ntry>`);
    const result = parseCamt053(xml);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.amount).toBe(9);
    expect(result.entries[1]?.amount).toBe(18);
    expect(result.entries[0]?.original_currency).toBe("USD");
    expect(result.entries[0]?.bank_reference).toBe("PARENT");
  });

  it("splits equally when original amounts are missing", () => {
    const xml = wrap(`
      <Ntry>
        <Amt Ccy="EUR">10</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2025-06-08</Dt></BookgDt>
        <NtryDtls>
          <TxDtls></TxDtls>
          <TxDtls></TxDtls>
        </NtryDtls>
      </Ntry>`);
    const result = parseCamt053(xml);
    expect(result.entries.map((e) => e.amount)).toEqual([5, 5]);
  });

  it("uses FrDtTm/ToDtTm and default EUR when account currency omitted", () => {
    const xml = `<?xml version="1.0"?>
<Document><BkToCstmrStmt><Stmt>
  <Acct><Id><IBAN>EE1</IBAN></Id></Acct>
  <FrToDt><FrDtTm>2025-01-01T00:00:00</FrDtTm><ToDtTm>2025-01-31T23:59:59</ToDtTm></FrToDt>
  <Ntry>
    <Amt>3</Amt>
    <CdtDbtInd>CRDT</CdtDbtInd>
    <BookgDt><Dt>2025-01-02</Dt></BookgDt>
  </Ntry>
</Stmt></BkToCstmrStmt></Document>`;
    const result = parseCamt053(xml);
    expect(result.statement_metadata.currency).toBe("EUR");
    expect(result.statement_metadata.period).toEqual({ from: "2025-01-01", to: "2025-01-31" });
    expect(result.entries[0]?.currency).toBe("EUR");
  });

  it("rejects DOCTYPE, ENTITY, multi-statement, missing IBAN, bad direction, bad amount", () => {
    expect(() => parseCamt053("<!DOCTYPE foo><Document></Document>")).toThrow(/DOCTYPE/);
    expect(() => parseCamt053("<!ENTITY x SYSTEM 'x'><Document></Document>")).toThrow(/ENTITY/);
    expect(() => parseCamt053("<Nope></Nope>")).toThrow(/BkToCstmrStmt/);
    expect(() =>
      parseCamt053(
        "<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>EE1</IBAN></Id></Acct></Stmt><Stmt><Acct><Id><IBAN>EE2</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>",
      ),
    ).toThrow(/multiple statements/);
    expect(() => parseCamt053("<Document><BkToCstmrStmt></BkToCstmrStmt></Document>")).toThrow(
      /no statement/,
    );
    expect(() =>
      parseCamt053(
        "<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>EE1</IBAN><IBAN>EE2</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>",
      ),
    ).toThrow(/IBAN/);
    expect(() =>
      parseCamt053(
        "<BkToCstmrStmt><Stmt><Acct><Id><IBAN>EE1</IBAN></Id></Acct></Stmt></BkToCstmrStmt>",
      ),
    ).not.toThrow();
    expect(() =>
      parseCamt053(wrap(`<Ntry><Amt>1</Amt><BookgDt><Dt>2025-06-01</Dt></BookgDt></Ntry>`)),
    ).toThrow(/CdtDbtInd/);
    expect(() =>
      parseCamt053(
        "<Document><BkToCstmrStmt><Stmt><Acct></Acct></Stmt></BkToCstmrStmt></Document>",
      ),
    ).toThrow(/IBAN/);
    expect(() =>
      parseCamt053(
        wrap(
          `<Ntry><Amt>1</Amt><CdtDbtInd>FOO</CdtDbtInd><BookgDt><Dt>2025-06-01</Dt></BookgDt></Ntry>`,
        ),
      ),
    ).toThrow(/CdtDbtInd/);
    expect(() =>
      parseCamt053(
        wrap(
          `<Ntry><Amt>abc</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2025-06-01</Dt></BookgDt></Ntry>`,
        ),
      ),
    ).toThrow(/not a number/);
    expect(() =>
      parseCamt053(
        wrap(`<Ntry><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2025-06-01</Dt></BookgDt></Ntry>`),
      ),
    ).toThrow(/missing an amount/);
    expect(() =>
      parseCamt053(wrap(`<Ntry><Amt>1</Amt><CdtDbtInd>CRDT</CdtDbtInd></Ntry>`)),
    ).toThrow(/booking date/);
  });

  it("rejects when entry count exceeds maxEntries", () => {
    const xml = wrap(`
      <Ntry><Amt>1</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2025-06-01</Dt></BookgDt></Ntry>
      <Ntry><Amt>1</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2025-06-02</Dt></BookgDt></Ntry>`);
    expect(() => parseCamt053(xml, { maxEntries: 1 })).toThrow(/more than 1/);
  });

  it("falls back to EndToEndId when creditor reference is absent", () => {
    const xml = wrap(`
      <Ntry>
        <Amt>1</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2025-06-01</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>ONLYE2E</EndToEndId></Refs>
          <AmtDtls></AmtDtls>
          <RltdPties>
            <Dbtr>
              <Nm>X</Nm>
              <Id><OrgId><Othr><Id>99</Id><SchmeNm><Cd>TXID</Cd></SchmeNm></Othr></OrgId></Id>
            </Dbtr>
          </RltdPties>
        </TxDtls></NtryDtls>
      </Ntry>`);
    const parsed = parseCamt053(xml).entries[0];
    expect(parsed?.reference_number).toBe("ONLYE2E");
    expect(parsed?.counterparty_reg_code).toBeUndefined();
    expect(parsed?.original_amount).toBeUndefined();
  });

  it("splits equally when some original amounts are zero", () => {
    const xml = wrap(`
      <Ntry>
        <Amt Ccy="EUR">10</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2025-06-08</Dt></BookgDt>
        <NtryDtls>
          <TxDtls><AmtDtls><TxAmt><Amt Ccy="EUR">0</Amt></TxAmt></AmtDtls></TxDtls>
          <TxDtls><AmtDtls><TxAmt><Amt Ccy="EUR">4</Amt></TxAmt></AmtDtls></TxDtls>
        </NtryDtls>
      </Ntry>`);
    expect(parseCamt053(xml).entries.map((e) => e.amount)).toEqual([5, 5]);
  });

  it("ignores non-object NtryDtls and unknown balance types", () => {
    const xml = wrap(`
      <Bal>
        <Tp><CdOrPrtry><Cd>FWAV</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">1</Amt>
      </Bal>
      <Ntry>
        <Amt>2</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2025-06-01</Dt></BookgDt>
        <NtryDtls>skip</NtryDtls>
      </Ntry>
      <Bal>skip</Bal>
      <Ntry>skip</Ntry>
      <Ntry>
        <Amt>3</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2025-06-02</Dt></BookgDt>
        <NtryDtls><TxDtls>1</TxDtls></NtryDtls>
      </Ntry>`);
    expect(parseCamt053(xml).entries).toHaveLength(2);
  });
});
