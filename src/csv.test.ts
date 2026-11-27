import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";

function parseOne(record: string, delimiter = ","): string[] {
  const rows = parseCsv(`${record}\n`, delimiter);
  const first = rows[0];
  if (first == null) {
    throw new Error("expected a CSV record");
  }
  return first;
}

describe("parseCsv (single record)", () => {
  it("splits on commas and keeps empty fields", () => {
    expect(parseOne("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseOne("a,,c")).toEqual(["a", "", "c"]);
    expect(parseOne(",b,")).toEqual(["", "b", ""]);
    expect(parseOne("hello")).toEqual(["hello"]);
    expect(parseOne("")).toEqual([""]);
  });

  it("keeps commas inside quotes and unescapes doubled quotes", () => {
    expect(parseOne('"hello, world",b,c')).toEqual(["hello, world", "b", "c"]);
    expect(parseOne('a,"x,y,z",c')).toEqual(["a", "x,y,z", "c"]);
    expect(parseOne('"say ""hi""",b')).toEqual(['say "hi"', "b"]);
    expect(parseOne('"a""b""c"')).toEqual(['a"b"c']);
    expect(parseOne('"hello"')).toEqual(["hello"]);
  });

  it("accepts a custom delimiter", () => {
    expect(parseOne("a;b;c", ";")).toEqual(["a", "b", "c"]);
    expect(parseOne('"a;b";c;d', ";")).toEqual(["a;b", "c", "d"]);
  });
});

describe("parseCsv", () => {
  it("returns no records for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("splits CRLF rows without leaving carriage returns in fields", () => {
    expect(parseCsv("ID,Note\r\n1,Jar top-up\r\n2,Other\r\n")).toEqual([
      ["ID", "Note"],
      ["1", "Jar top-up"],
      ["2", "Other"],
    ]);
  });

  it("keeps lone CR as a record break", () => {
    expect(parseCsv("a,b\rc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("preserves embedded newlines inside quoted fields", () => {
    expect(parseCsv('ID,Note\r\n1,"line 1\r\nline 2"\r\n')).toEqual([
      ["ID", "Note"],
      ["1", "line 1\r\nline 2"],
    ]);
  });

  it("keeps a final record when the document has no trailing newline", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("treats an unclosed quote as part of the last field", () => {
    expect(parseCsv('a,"b,c')).toEqual([["a", "b,c"]]);
  });
});
