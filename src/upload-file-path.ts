import path from "node:path";
import { realpath } from "./upload-file-path-fs.js";

const MSG_RELATIVE =
  "file_path must be a relative path under MCP_FILE_UPLOAD_ROOT when that variable is set";
const MSG_OUTSIDE = "file_path resolves outside the allowed upload directory";
const MSG_ROOT = "MCP_FILE_UPLOAD_ROOT cannot be resolved; check that the path exists";
const MSG_NOT_FOUND = "Upload file not found";
const MSG_RESOLVE = "file_path could not be resolved";

/** True when `resolvedPath` is `rootReal` or a path strictly under it (no `..` escape). */
function isResolvedPathInsideRoot(rootReal: string, resolvedPath: string): boolean {
  const rel = path.relative(rootReal, resolvedPath);
  if (rel === "") {
    return true;
  }
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves a tool-supplied upload path for `readFile`.
 * When `MCP_FILE_UPLOAD_ROOT` is unset or empty, returns the trimmed path unchanged.
 * When set, requires a relative path, resolves the root and file with `realpath`, and
 * rejects paths that escape the root (including via symlinks).
 */
export async function resolveUploadFilePath(userPath: string): Promise<string> {
  const trimmed = userPath.trim();
  if (trimmed === "") {
    throw new Error("file_path must be a non-empty path");
  }

  const rootRaw = process.env.MCP_FILE_UPLOAD_ROOT?.trim();
  if (!rootRaw) {
    return trimmed;
  }

  if (path.isAbsolute(trimmed)) {
    throw new Error(MSG_RELATIVE);
  }

  let rootReal: string;
  try {
    rootReal = await realpath(rootRaw);
  } catch {
    throw new Error(MSG_ROOT);
  }

  const candidate = path.resolve(rootReal, trimmed);
  if (!isResolvedPathInsideRoot(rootReal, candidate)) {
    throw new Error(MSG_OUTSIDE);
  }

  let fileReal: string;
  try {
    fileReal = await realpath(candidate);
  } catch (e) {
    const code =
      e && typeof e === "object" && "code" in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      throw new Error(MSG_NOT_FOUND);
    }
    throw new Error(MSG_RESOLVE);
  }

  if (!isResolvedPathInsideRoot(rootReal, fileReal)) {
    throw new Error(MSG_OUTSIDE);
  }

  return fileReal;
}
