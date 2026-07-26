import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { resolveUploadFilePath } from "./upload-file-path.js";

/** Max decoded payload size for inline base64 uploads (10 MiB). */
export const MAX_BASE64_UPLOAD_BYTES = 10 * 1024 * 1024;

const BASE64_PREFIX = "base64:";

const ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".xml", ".csv"]);

export interface ResolvedFileInput {
  buffer: Buffer;
  filename: string;
  /** Extension including leading dot, e.g. `.pdf`. */
  extension: string;
}

interface MagicSignature {
  extensions: [string, ...string[]];
  prefix: Uint8Array;
  allowsUtf8Bom?: boolean;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  { extensions: [".pdf"], prefix: Buffer.from("%PDF-") },
  {
    extensions: [".png"],
    prefix: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { extensions: [".jpg", ".jpeg"], prefix: Buffer.from([0xff, 0xd8, 0xff]) },
  { extensions: [".xml"], prefix: Buffer.from("<?xml"), allowsUtf8Bom: true },
];

function hasUtf8Bom(content: Buffer): boolean {
  return content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
}

function normalizeExtensionHint(hint: string): string {
  const trimmed = hint.trim().toLowerCase().replace(/^\./, "");
  return `.${trimmed || "bin"}`;
}

function sniffExtension(content: Buffer): string | undefined {
  const bomPresent = hasUtf8Bom(content);
  for (const sig of MAGIC_SIGNATURES) {
    const offset = sig.allowsUtf8Bom && bomPresent ? 3 : 0;
    if (
      content.length - offset >= sig.prefix.length &&
      sig.prefix.every((byte, i) => content[offset + i] === byte)
    ) {
      return sig.extensions[0];
    }
  }
  return undefined;
}

function decodeBase64Strict(encoded: string, maxSize: number): Buffer {
  const cleaned = encoded.replace(/\s+/g, "");
  if (cleaned.length === 0) {
    throw new Error("base64 payload is empty");
  }
  const padCount = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const approxDecoded = Math.floor(cleaned.length / 4) * 3 - padCount;
  if (approxDecoded > maxSize) {
    throw new Error(
      `file_too_large: base64 payload too large (~${(approxDecoded / 1024 / 1024).toFixed(1)} MB; max ${maxSize / 1024 / 1024} MB)`,
    );
  }
  const buf = Buffer.from(cleaned, "base64");
  if (
    buf.length === 0 ||
    buf.toString("base64").replace(/=+$/, "") !== cleaned.replace(/=+$/, "")
  ) {
    throw new Error("base64 payload could not be decoded cleanly");
  }
  return buf;
}

function resolveBase64Input(payload: string): ResolvedFileInput {
  const body = payload.slice(BASE64_PREFIX.length);
  let explicitExt: string | undefined;
  let b64Data: string;
  const firstColon = body.indexOf(":");
  if (firstColon > 0 && firstColon <= 5 && /^[A-Za-z0-9]+$/.test(body.slice(0, firstColon))) {
    explicitExt = normalizeExtensionHint(body.slice(0, firstColon));
    b64Data = body.slice(firstColon + 1);
  } else {
    b64Data = body;
  }

  const buffer = decodeBase64Strict(b64Data, MAX_BASE64_UPLOAD_BYTES);
  let extension = explicitExt;
  if (!extension) {
    extension = sniffExtension(buffer);
  }
  if (!extension) {
    throw new Error(
      'Ambiguous base64 payload: provide an extension hint, e.g. "base64:csv:<data>" or "base64:pdf:<data>"',
    );
  }
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported file extension "${extension}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
    );
  }

  const filename = `upload${extension === ".jpeg" ? ".jpg" : extension}`;
  return { buffer, filename, extension };
}

/**
 * Resolve a tool `file_path` that is either a filesystem path or an inline
 * `base64:<data>` / `base64:<ext>:<data>` payload (for remote MCP clients).
 */
export async function resolveFileInput(filePath: string): Promise<ResolvedFileInput> {
  const trimmed = filePath.trim();
  if (trimmed === "") {
    throw new Error("file_path must be a non-empty path or base64 payload");
  }

  if (trimmed.toLowerCase().startsWith(BASE64_PREFIX)) {
    return resolveBase64Input(trimmed);
  }

  const resolvedPath = await resolveUploadFilePath(trimmed);
  const buffer = await readFile(resolvedPath);
  if (buffer.length > MAX_BASE64_UPLOAD_BYTES) {
    throw new Error(
      `file_too_large: file exceeds ${MAX_BASE64_UPLOAD_BYTES / 1024 / 1024} MB limit`,
    );
  }
  const filename = basename(resolvedPath);
  const parts = filename.split(".");
  const extPart = parts.length > 1 ? parts[parts.length - 1] : "bin";
  const extension = normalizeExtensionHint(extPart);
  return { buffer, filename, extension };
}
