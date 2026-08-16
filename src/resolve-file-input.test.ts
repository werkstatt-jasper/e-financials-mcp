import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BASE64_UPLOAD_BYTES, resolveFileInput } from "./resolve-file-input.js";

describe("resolveFileInput", () => {
  beforeEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
  });

  afterEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
    vi.unstubAllGlobals();
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

function mockResponse(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}): Response {
  const body = init.body ?? Buffer.from("%PDF-1.4 test");
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status: init.status ?? 200,
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    headers: new Headers(init.headers),
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  } as Response;
}

describe("resolveFileInput URL mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches https URL and uses Content-Type plus path filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        headers: { "content-type": "application/pdf; charset=binary" },
        body: Buffer.from("%PDF-1.4 hello"),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveFileInput("https://files.example.com/invoices/scan.pdf");
    expect(result.filename).toBe("scan.pdf");
    expect(result.extension).toBe(".pdf");
    expect(result.buffer.toString()).toContain("%PDF-1.4");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://files.example.com/invoices/scan.pdf",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("follows a single http(s) redirect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          status: 302,
          headers: { location: "https://cdn.example.com/a.png" },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          headers: { "content-type": "image/png" },
          body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveFileInput("https://example.com/go");
    expect(result.extension).toBe(".png");
    expect(result.filename).toBe("a.png");
  });

  it("rejects file:// and other non-http schemes", async () => {
    await expect(resolveFileInput("file:///tmp/x.pdf")).rejects.toThrow(/http:\/\/ or https:\/\//);
    await expect(resolveFileInput("ftp://files.example.com/a.pdf")).rejects.toThrow(
      /http:\/\/ or https:\/\//,
    );
    await expect(resolveFileInput("http://[")).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  it("rejects redirect to a non-http location", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          status: 302,
          headers: { location: "file:///etc/passwd" },
        }),
      ),
    );
    await expect(resolveFileInput("https://example.com/x")).rejects.toThrow(
      /http:\/\/ or https:\/\//,
    );
  });

  it("rejects redirect without Location", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({ status: 301 })));
    await expect(resolveFileInput("https://example.com/x")).rejects.toThrow(/Location/);
  });

  it("rejects too many redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) =>
        mockResponse({
          status: 302,
          headers: { location: `${url}/next` },
        }),
      ),
    );
    await expect(resolveFileInput("https://example.com/r")).rejects.toThrow(/redirect limit/);
  });

  it("rejects HTTP error status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({ status: 404 })));
    await expect(resolveFileInput("https://example.com/missing.pdf")).rejects.toThrow(/HTTP 404/);
  });

  it("rejects Content-Length over the size cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          headers: { "content-length": String(11 * 1024 * 1024) },
        }),
      ),
    );
    await expect(resolveFileInput("https://example.com/big.pdf")).rejects.toThrow(/file_too_large/);
  });

  it("rejects a body over the size cap when Content-Length is absent", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({ body: big })));
    await expect(resolveFileInput("https://example.com/big")).rejects.toThrow(/file_too_large/);
  });

  it("maps timeout/abort to a fetch timeout error", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    await expect(resolveFileInput("https://example.com/slow.pdf")).rejects.toThrow(/timed out/);

    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(resolveFileInput("https://example.com/slow.pdf")).rejects.toThrow(/timed out/);
  });

  it("wraps other fetch failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(resolveFileInput("https://example.com/x.pdf")).rejects.toThrow(/ECONNREFUSED/);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("boom"));
    await expect(resolveFileInput("https://example.com/x.pdf")).rejects.toThrow(/boom/);
  });

  it("sniffs magic bytes when Content-Type and path have no extension", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          body: Buffer.from("%PDF-1.7"),
        }),
      ),
    );
    const result = await resolveFileInput("https://example.com/");
    expect(result.extension).toBe(".pdf");
    expect(result.filename).toBe("upload.pdf");
  });

  it("uses URL path extension when Content-Type is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ body: Buffer.from("a,b\n1,2\n") })),
    );
    const result = await resolveFileInput("https://example.com/data.csv");
    expect(result.extension).toBe(".csv");
    expect(result.filename).toBe("data.csv");
  });

  it("rejects unknown type and unsupported extension", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({ body: Buffer.from("xxxx") })));
    await expect(resolveFileInput("https://example.com/blob")).rejects.toThrow(/Ambiguous URL/);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({ body: Buffer.from("xxxx") })));
    await expect(resolveFileInput("https://example.com/x.exe")).rejects.toThrow(/Unsupported/);
  });

  it("uses Content-Type fallbacks for jpeg/xml/csv aliases", async () => {
    const cases: Array<[string, string]> = [
      ["image/jpeg", ".jpg"],
      ["image/jpg", ".jpg"],
      ["text/xml", ".xml"],
      ["application/xml", ".xml"],
      ["text/csv", ".csv"],
      ["application/csv", ".csv"],
    ];
    for (const [contentType, ext] of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockResponse({
            headers: { "content-type": contentType },
            body: Buffer.from("xx"),
          }),
        ),
      );
      const result = await resolveFileInput("https://example.com/download");
      expect(result.extension).toBe(ext);
    }
  });

  it("ignores empty Content-Type mime and falls back to path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          headers: { "content-type": ";" },
          body: Buffer.from("a,b\n"),
        }),
      ),
    );
    const result = await resolveFileInput("https://example.com/export.csv");
    expect(result.extension).toBe(".csv");
  });
});
