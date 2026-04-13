import { mkdir, mkdtemp, realpath as nodeRealpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUploadFilePath } from "./upload-file-path.js";
import { realpath as mockableRealpath } from "./upload-file-path-fs.js";

vi.mock("./upload-file-path-fs.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./upload-file-path-fs.js")>();
  return {
    realpath: vi
      .fn()
      .mockImplementation((p: Parameters<typeof mod.realpath>[0]) => mod.realpath(p)),
  };
});

describe("resolveUploadFilePath", () => {
  beforeEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
    vi.mocked(mockableRealpath).mockImplementation((p) => nodeRealpath(p));
  });

  afterEach(() => {
    delete process.env.MCP_FILE_UPLOAD_ROOT;
  });

  it("returns trimmed path unchanged when MCP_FILE_UPLOAD_ROOT is unset", async () => {
    expect(await resolveUploadFilePath("  /tmp/x.pdf  ")).toBe("/tmp/x.pdf");
  });

  it("throws when trimmed path is empty", async () => {
    await expect(resolveUploadFilePath("   ")).rejects.toThrow(/non-empty/);
  });

  it("resolves allowed relative file under root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    const inner = path.join(root, "inner");
    await mkdir(inner);
    const filePath = path.join(inner, "doc.pdf");
    await writeFile(filePath, "x");
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    const rel = path.join("inner", "doc.pdf");
    const resolved = await resolveUploadFilePath(rel);
    expect(resolved).toBe(await nodeRealpath(filePath));
  });

  it("rejects absolute userPath when root is set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    await expect(resolveUploadFilePath("/etc/passwd")).rejects.toThrow(/relative path/);
  });

  it("rejects path traversal via .. segments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    await writeFile(path.join(root, "a.txt"), "x");
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    await expect(
      resolveUploadFilePath(`..${path.sep}..${path.sep}etc${path.sep}passwd`),
    ).rejects.toThrow(/outside the allowed upload directory/);
  });

  it("rejects missing file under root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    await expect(resolveUploadFilePath("nope.pdf")).rejects.toThrow(/not found/);
  });

  it("rejects when MCP_FILE_UPLOAD_ROOT cannot be resolved", async () => {
    process.env.MCP_FILE_UPLOAD_ROOT = path.join(tmpdir(), "nonexistent-root-xyz-12345");
    await expect(resolveUploadFilePath("a.pdf")).rejects.toThrow(/cannot be resolved/);
  });

  it("rejects symlink inside root pointing outside", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    const secret = await mkdtemp(path.join(tmpdir(), "secret-"));
    const secretFile = path.join(secret, "x.txt");
    await writeFile(secretFile, "secret");
    const link = path.join(root, "evil");
    await symlink(secretFile, link);
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    await expect(resolveUploadFilePath("evil")).rejects.toThrow(
      /outside the allowed upload directory/,
    );
  });

  it("allows symlink whose target stays inside root", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    const target = path.join(root, "real.pdf");
    await writeFile(target, "p");
    const link = path.join(root, "via-link");
    await symlink("real.pdf", link);
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    const resolved = await resolveUploadFilePath("via-link");
    expect(resolved).toBe(await nodeRealpath(target));
  });

  it("accepts . under root (containment edge: path equals root)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    const resolved = await resolveUploadFilePath(".");
    expect(resolved).toBe(await nodeRealpath(root));
  });

  it("throws when realpath fails for a reason other than ENOENT", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    const doc = path.join(root, "doc.pdf");
    await writeFile(doc, "x");
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    vi.mocked(mockableRealpath).mockImplementation(async (p) => {
      const s = String(p);
      if (path.basename(s) === "doc.pdf") {
        const err = new Error("simulated") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return nodeRealpath(p);
    });
    await expect(resolveUploadFilePath("doc.pdf")).rejects.toThrow(/could not be resolved/);
  });

  it("throws when realpath fails with an object error that has no code field", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "upload-root-"));
    const doc = path.join(root, "doc.pdf");
    await writeFile(doc, "x");
    process.env.MCP_FILE_UPLOAD_ROOT = root;
    vi.mocked(mockableRealpath).mockImplementation(async (p) => {
      const s = String(p);
      if (path.basename(s) === "doc.pdf") {
        throw { message: "weird" };
      }
      return nodeRealpath(p);
    });
    await expect(resolveUploadFilePath("doc.pdf")).rejects.toThrow(/could not be resolved/);
  });
});
