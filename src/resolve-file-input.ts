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

export interface ResolveFileInputOptions {
  /** Archive name; wins over Content-Disposition and the URL/path name. */
  filename?: string;
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

const URL_FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "text/xml": ".xml",
  "application/xml": ".xml",
  "text/csv": ".csv",
  "application/csv": ".csv",
};

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function extensionFromContentType(contentType: string | null): string | undefined {
  if (!contentType) {
    return undefined;
  }
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  return mime ? CONTENT_TYPE_EXTENSION[mime] : undefined;
}

function extensionFromUrlPath(url: string): string | undefined {
  const pathname = new URL(url).pathname;
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return normalizeExtensionHint(last.slice(dot + 1));
}

function filenameFromUrl(url: string): string | undefined {
  const pathname = new URL(url).pathname;
  const last = pathname.split("/").filter(Boolean).pop();
  if (!last?.includes(".")) {
    return undefined;
  }
  const ext = normalizeExtensionHint(last.slice(last.lastIndexOf(".") + 1));
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return undefined;
  }
  return last;
}

/**
 * Parse `Content-Disposition` `filename` / `filename*` (RFC 5987).
 * Returns the basename only; does not validate the extension.
 */
export function parseContentDispositionFilename(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const star = /filename\*\s*=\s*(?:UTF-8|iso-8859-1)''([^;\s]+)/i.exec(header);
  if (star?.[1]) {
    try {
      const decoded = decodeURIComponent(star[1].replace(/['"]/g, ""));
      const base = basename(decoded.replace(/\\/g, "/"));
      if (base && base !== "." && base !== "..") {
        return base;
      }
    } catch {
      /* ignore malformed percent-encoding */
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted?.[1]) {
    const unescaped = quoted[1].replace(/\\(.)/g, "$1");
    const base = basename(unescaped.replace(/\\/g, "/"));
    if (base && base !== "." && base !== "..") {
      return base;
    }
  }
  const unquoted = /filename\s*=\s*([^;]+)/i.exec(header);
  if (unquoted?.[1]) {
    const raw = unquoted[1].trim().replace(/^["']|["']$/g, "");
    const base = basename(raw.replace(/\\/g, "/"));
    if (base && base !== "." && base !== "..") {
      return base;
    }
  }
  return undefined;
}

/**
 * Turn a caller- or header-supplied name into a safe basename with an allowed
 * extension. Missing/unsupported extensions fall back to `fallbackExtension`.
 */
export function sanitizeUploadFilename(name: string, fallbackExtension: string): string {
  const base = basename(name.replace(/\\/g, "/")).trim();
  if (!base || base === "." || base === "..") {
    throw new Error("filename is empty or invalid");
  }
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  const hinted = dot > 0 ? normalizeExtensionHint(base.slice(dot + 1)) : undefined;
  const extension = hinted && ALLOWED_EXTENSIONS.has(hinted) ? hinted : fallbackExtension;
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported file extension "${extension}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
    );
  }
  const safeStem = stem.replace(/[/\\]/g, "_").slice(0, 180);
  return `${safeStem}${extension === ".jpeg" ? ".jpg" : extension}`;
}

export function applyFilenameOverride(
  resolved: ResolvedFileInput,
  override?: string,
): ResolvedFileInput {
  if (override == null || override.trim() === "") {
    return resolved;
  }
  const filename = sanitizeUploadFilename(override, resolved.extension);
  const extPart = filename.slice(filename.lastIndexOf("."));
  return { ...resolved, filename, extension: normalizeExtensionHint(extPart.replace(/^\./, "")) };
}

type FetchedUrl = {
  buffer: Buffer;
  finalUrl: string;
  contentType: string | null;
  contentDisposition: string | null;
};

async function fetchHttpUrl(url: string, hops = 0): Promise<FetchedUrl> {
  if (hops > MAX_REDIRECTS) {
    throw new Error("file_path URL exceeded redirect limit");
  }
  if (!isHttpUrl(url)) {
    throw new Error("file_path URL must be http:// or https://");
  }

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error("file_path URL fetch timed out");
    }
    throw new Error(
      `file_path URL fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) {
      throw new Error("file_path URL redirect missing Location header");
    }
    const next = new URL(location, url).toString();
    return fetchHttpUrl(next, hops + 1);
  }

  if (!res.ok) {
    throw new Error(`file_path URL fetch failed: HTTP ${res.status}`);
  }

  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BASE64_UPLOAD_BYTES) {
    throw new Error(
      `file_too_large: URL payload too large (${(contentLength / 1024 / 1024).toFixed(1)} MB; max ${MAX_BASE64_UPLOAD_BYTES / 1024 / 1024} MB)`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BASE64_UPLOAD_BYTES) {
    throw new Error(
      `file_too_large: URL payload too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB; max ${MAX_BASE64_UPLOAD_BYTES / 1024 / 1024} MB)`,
    );
  }

  return {
    buffer,
    finalUrl: url,
    contentType: res.headers.get("content-type"),
    contentDisposition: res.headers.get("content-disposition"),
  };
}

async function resolveUrlInput(url: string): Promise<ResolvedFileInput> {
  const { buffer, finalUrl, contentType, contentDisposition } = await fetchHttpUrl(url);
  let extension = extensionFromContentType(contentType);
  const dispositionName = parseContentDispositionFilename(contentDisposition);
  const pathName = filenameFromUrl(finalUrl);
  const pathExt = extensionFromUrlPath(finalUrl);
  if (!extension && dispositionName?.includes(".")) {
    const hinted = normalizeExtensionHint(
      dispositionName.slice(dispositionName.lastIndexOf(".") + 1),
    );
    if (ALLOWED_EXTENSIONS.has(hinted)) {
      extension = hinted;
    }
  }
  if (!extension && pathName) {
    extension = normalizeExtensionHint(pathName.slice(pathName.lastIndexOf(".") + 1));
  }
  if (!extension) {
    extension = sniffExtension(buffer);
  }
  if (!extension) {
    if (pathExt && !ALLOWED_EXTENSIONS.has(pathExt)) {
      throw new Error(
        `Unsupported file extension "${pathExt}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
      );
    }
    throw new Error(
      "Ambiguous URL payload: could not determine file type from Content-Type, URL path, or file bytes",
    );
  }
  const picked = dispositionName
    ? sanitizeUploadFilename(dispositionName, extension)
    : (pathName ?? sanitizeUploadFilename("upload", extension));
  return { buffer, filename: picked, extension };
}

/**
 * Resolve a tool `file_path` that is a filesystem path, an `https://` URL,
 * or an inline `base64:<data>` / `base64:<ext>:<data>` payload.
 */
export async function resolveFileInput(
  filePath: string,
  options?: ResolveFileInputOptions,
): Promise<ResolvedFileInput> {
  const trimmed = filePath.trim();
  if (trimmed === "") {
    throw new Error("file_path must be a non-empty path or base64 payload");
  }

  let resolved: ResolvedFileInput;
  if (trimmed.toLowerCase().startsWith(BASE64_PREFIX)) {
    resolved = resolveBase64Input(trimmed);
  } else if (URL_SCHEME.test(trimmed)) {
    resolved = await resolveUrlInput(trimmed);
  } else {
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
    resolved = { buffer, filename, extension };
  }
  return applyFilenameOverride(resolved, options?.filename);
}
