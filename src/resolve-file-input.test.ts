import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BASE64_UPLOAD_BYTES, resolveFileInput } from "./resolve-file-input.js";

describe("resolveFileInput", () => {
  beforeEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
  });

  afterEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
  });

  it("reads a filesystem path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "file-input-"));
    const file = path.join(dir, "doc.pdf");
    await writeFile(file, "%PDF-1.4 hello");
    const result = await resolveFileInput(file);
    expect(result.filename).toBe("doc.pdf");
    expect(result.buffer.toString("utf8")).toContain("%PDF");
    expect(result.extension).toBe(".pdf");
  });

  it("uses .bin extension for path files without a suffix", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "file-input-"));
    const file = path.join(dir, "nosuffix");
    await writeFile(file, "raw");
    const result = await resolveFileInput(file);
    expect(result.extension).toBe(".bin");
  });

  it("uses .bin when path ends with a trailing dot", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "file-input-"));
    const file = path.join(dir, "foo.");
    await writeFile(file, "raw");
    const result = await resolveFileInput(file);
    expect(result.extension).toBe(".bin");
  });

  it("decodes base64 with extension hint", async () => {
    const payload = Buffer.from("a,b\n1,2\n").toString("base64");
    const result = await resolveFileInput(`base64:csv:${payload}`);
    expect(result.filename).toBe("upload.csv");
    expect(result.extension).toBe(".csv");
    expect(result.buffer.toString("utf8")).toBe("a,b\n1,2\n");
  });

  it("sniffs PDF magic without extension hint", async () => {
    const payload = Buffer.from("%PDF-1.7 content").toString("base64");
    const result = await resolveFileInput(`base64:${payload}`);
    expect(result.extension).toBe(".pdf");
  });

  it("sniffs PNG magic", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const result = await resolveFileInput(`base64:${png.toString("base64")}`);
    expect(result.extension).toBe(".png");
  });

  it("sniffs JPEG magic", async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const result = await resolveFileInput(`base64:${jpg.toString("base64")}`);
    expect(result.extension).toBe(".jpg");
  });

  it("sniffs XML with BOM", async () => {
    const xml = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("<?xml version='1.0'?>"),
    ]);
    const result = await resolveFileInput(`base64:${xml.toString("base64")}`);
    expect(result.extension).toBe(".xml");
  });

  it("accepts extension hint without leading dot and jpeg alias", async () => {
    const payload = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64");
    const result = await resolveFileInput(`base64:JPEG:${payload}`);
    expect(result.filename).toBe("upload.jpg");
  });

  it("rejects ambiguous base64 without hint", async () => {
    const payload = Buffer.from("hello,world").toString("base64");
    await expect(resolveFileInput(`base64:${payload}`)).rejects.toThrow(/extension hint/);
  });

  it("rejects empty file_path", async () => {
    await expect(resolveFileInput("   ")).rejects.toThrow(/non-empty/);
  });

  it("rejects empty base64 payload", async () => {
    await expect(resolveFileInput("base64:")).rejects.toThrow(/empty/);
  });

  it("rejects corrupt base64", async () => {
    await expect(resolveFileInput("base64:pdf:!!!!")).rejects.toThrow(/decoded cleanly/);
  });

  it("rejects unsupported extension hint", async () => {
    const payload = Buffer.from("x").toString("base64");
    await expect(resolveFileInput(`base64:exe:${payload}`)).rejects.toThrow(/Unsupported/);
  });

  it("rejects oversized base64 before decode when approximate size exceeds limit", async () => {
    // Construct a base64 string that would decode larger than the limit
    const charsNeeded = Math.ceil(((MAX_BASE64_UPLOAD_BYTES + 1000) * 4) / 3);
    const huge = "A".repeat(charsNeeded);
    await expect(resolveFileInput(`base64:pdf:${huge}`)).rejects.toThrow(/file_too_large/);
  });

  it("rejects path files over size limit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "file-input-big-"));
    const file = path.join(dir, "big.bin");
    await writeFile(file, Buffer.alloc(MAX_BASE64_UPLOAD_BYTES + 1));
    await expect(resolveFileInput(file)).rejects.toThrow(/file_too_large/);
  });

  it("respects MCP_FILE_UPLOAD_ROOT for path inputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    await writeFile(path.join(root, "a.pdf"), "%PDF-1.4");
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    const result = await resolveFileInput("a.pdf");
    expect(result.filename).toBe("a.pdf");
    await expect(resolveFileInput("/etc/passwd")).rejects.toThrow(/relative path/);
  });
});
