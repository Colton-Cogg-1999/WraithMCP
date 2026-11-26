import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";

export class SecurityBoundaryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SecurityBoundaryError";
    this.code = code;
  }
}

/**
 * Strict BCP-47 locale tag validator (also accepting underscore separators like pt_BR
 * and private-use pseudo tags like en-x-pseudo / pseudo).
 * Rejects path separators, '..', whitespace, control characters, and non-locale strings.
 */
const BCP47_SAFE_RE =
  /^(?:pseudo|[a-zA-Z]{2,3}(?:[-_][a-zA-Z]{4})?(?:[-_](?:[a-zA-Z]{2}|\d{3}))?(?:[-_][a-zA-Z0-9]{4,8})*(?:[-_]x(?:[-_][a-zA-Z0-9]{1,8})+)?)$/;

export function isValidLocaleTag(locale: string): boolean {
  if (!locale || locale.length > 64) return false;
  if (
    locale.includes("/") ||
    locale.includes("\\") ||
    locale.includes("..") ||
    locale.includes("\0") ||
    locale.includes(":")
  ) {
    return false;
  }
  return BCP47_SAFE_RE.test(locale);
}

export function validateLocaleTag(locale: string, label = "locale"): string {
  const trimmed = typeof locale === "string" ? locale.trim() : "";
  if (!isValidLocaleTag(trimmed)) {
    throw new SecurityBoundaryError(
      "invalid_locale",
      `Invalid ${label} "${locale}". Expected a valid BCP-47 locale tag (e.g. "en", "es-MX", "zh-Hans", "pt-BR").`
    );
  }
  return trimmed;
}

/**
 * Normalize a BCP-47 or underscore locale code to canonical BCP-47 casing
 * (e.g. "EN-US" -> "en-US", "pt_br" -> "pt-BR", "zh_hans" -> "zh-Hans").
 */
export function canonicalizeLocaleTag(locale: string): string {
  const trimmed = locale.trim().replace(/_/g, "-");
  if (!trimmed) return trimmed;
  if (trimmed.toLowerCase() === "pseudo") return "pseudo";
  try {
    return new Intl.Locale(trimmed).toString();
  } catch {
    const parts = trimmed.split("-");
    return parts
      .map((p, idx) => {
        if (idx === 0) return p.toLowerCase();
        if (p.length === 4) return p[0].toUpperCase() + p.slice(1).toLowerCase();
        if (p.length === 2) return p.toUpperCase();
        return p.toLowerCase();
      })
      .join("-");
  }
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Resolve the nearest existing ancestor of `targetPath` via `fs.realpathSync`,
 * following dangling symlinks via `fs.lstatSync` + `fs.readlinkSync`,
 * then reconstruct the remaining relative segments so symlinks on existing OR
 * non-existent target paths (including dangling symlinks) cannot escape the root.
 */
function resolveRealPathWithAncestor(targetPath: string, depth = 0): string {
  if (depth > 40) {
    throw new SecurityBoundaryError("symlink_loop", `Too many symlink levels while resolving "${targetPath}".`);
  }

  const abs = path.resolve(targetPath);
  const trailing: string[] = [];
  let curr = abs;

  while (true) {
    let lstat: fs.Stats | null = null;
    try {
      lstat = fs.lstatSync(curr);
    } catch {
      lstat = null;
    }

    if (lstat) {
      if (lstat.isSymbolicLink()) {
        // Resolve even dangling symlinks by following readlink recursively
        const linkTarget = fs.readlinkSync(curr);
        const resolvedLink = path.resolve(path.dirname(curr), linkTarget);
        const nextTarget = trailing.length > 0 ? path.join(resolvedLink, ...trailing) : resolvedLink;
        return resolveRealPathWithAncestor(nextTarget, depth + 1);
      }
      const realBase = safeRealpath(curr);
      return trailing.length > 0 ? path.join(realBase, ...trailing) : realBase;
    }

    const parent = path.dirname(curr);
    if (parent === curr) {
      const realBase = safeRealpath(curr);
      return trailing.length > 0 ? path.join(realBase, ...trailing) : realBase;
    }
    trailing.unshift(path.basename(curr));
    curr = parent;
  }
}

export interface ConfinedPathOptions {
  label?: string;
  /** Additional explicitly user-authorized roots outside project rootDir */
  authorizedRoots?: string[];
}

/**
 * Resolve `candidatePath` relative to `rootDir` and strictly enforce that BOTH the
 * lexical path AND the symlink-resolved real path remain inside `rootDir`
 * (or an explicitly authorized additional root).
 */
export function resolveConfinedPath(
  rootDir: string,
  candidatePath: string,
  options?: ConfinedPathOptions
): string {
  const label = options?.label ?? "path";
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    throw new SecurityBoundaryError("invalid_path", `Empty ${label} is not allowed.`);
  }
  if (candidatePath.includes("\0")) {
    throw new SecurityBoundaryError("invalid_path", `Null byte in ${label} is not allowed.`);
  }

  const realRoot = safeRealpath(path.resolve(rootDir));
  const allowedRoots = [
    realRoot,
    ...(options?.authorizedRoots ?? []).map((r) => safeRealpath(path.resolve(r))),
  ];

  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(realRoot, candidatePath);

  const realResolved = resolveRealPathWithAncestor(resolved);
  const inside = allowedRoots.some((allowed) => isPathInsideRoot(realResolved, allowed));
  if (!inside) {
    throw new SecurityBoundaryError(
      "path_outside_workspace",
      `Refused ${label} "${candidatePath}": resolved path escapes authorized project workspace "${realRoot}".`
    );
  }

  return realResolved;
}

/**
 * Check whether an existing filesystem path (following symlinks) stays inside `rootDir`.
 * Used during directory traversal so symlinks pointing outside the repo are never followed.
 */
export function isRealPathWithinRoot(rootDir: string, targetPath: string): boolean {
  try {
    const realRoot = safeRealpath(path.resolve(rootDir));
    const realTarget = fs.realpathSync(targetPath);
    return isPathInsideRoot(realTarget, realRoot);
  } catch {
    return false;
  }
}

/**
 * Confine MCP tool `rootDir` overrides to the server's launch workspace (and any
 * roots explicitly authorized via options or WRAITH_ALLOWED_ROOTS).
 */
export function resolveMcpRootDir(
  launchRoot: string,
  requestedRoot?: string,
  authorizedRoots?: string[]
): string {
  const envRoots = (process.env.WRAITH_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const allAuthorized = [...(authorizedRoots ?? []), ...envRoots];
  if (!requestedRoot) return safeRealpath(path.resolve(launchRoot));
  return resolveConfinedPath(launchRoot, requestedRoot, {
    label: "rootDir",
    authorizedRoots: allAuthorized,
  });
}

/**
 * Atomically write a file by writing to a unique sibling temp file and renaming.
 * Prevents partially written or truncated files if a write is interrupted.
 */
export function atomicWriteFileSync(
  filePath: string,
  content: string | Uint8Array
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = `.wraith-tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    if (typeof content === "string") {
      fs.writeFileSync(tmpPath, content, "utf8");
    } else {
      fs.writeFileSync(tmpPath, content);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        break;
      } catch (renameErr: unknown) {
        const code = (renameErr as NodeJS.ErrnoException)?.code;
        if (process.platform === "win32" && (code === "EPERM" || code === "EACCES") && attempt < 5) {
          sleepSync(10 * (attempt + 1));
          continue;
        }
        throw renameErr;
      }
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

const activeWorkspaceLocks = new Map<string, number>();

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

export interface WorkspaceLockOptions {
  /** Max time to wait to acquire the lock before throwing (default 15000ms) */
  timeoutMs?: number;
  /** Age after which an unowned/abandoned lock file is considered stale (default 30000ms) */
  staleMs?: number;
}

/**
 * Exclusive file lock under `.wraith/.lock` coordinating concurrent multi-process
 * read-modify-write operations on locale files and `.wraith/` state files.
 * - Re-entrant within the same process.
 * - Enforces workspace confinement before creating `.wraith/.lock`.
 * - Recovers stale locks left behind by crashed processes (dead PID or age > staleMs).
 */
export function withWorkspaceLock<T>(
  rootDir: string,
  fn: () => T,
  options?: WorkspaceLockOptions
): T {
  const realRoot = safeRealpath(path.resolve(rootDir));
  const depth = activeWorkspaceLocks.get(realRoot) ?? 0;
  if (depth > 0) {
    activeWorkspaceLocks.set(realRoot, depth + 1);
    try {
      return fn();
    } finally {
      activeWorkspaceLocks.set(realRoot, depth);
    }
  }

  const wraithDir = resolveConfinedPath(realRoot, ".wraith", {
    label: ".wraith directory",
  });
  const lockPath = resolveConfinedPath(realRoot, path.join(".wraith", ".lock"), {
    label: ".wraith/.lock",
  });

  const existedBefore = fs.existsSync(wraithDir);
  fs.mkdirSync(wraithDir, { recursive: true });

  const timeoutMs = options?.timeoutMs ?? 15_000;
  const staleMs = options?.staleMs ?? 30_000;
  const start = Date.now();
  const token = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }) + "\n",
          "utf8"
        );
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // On Windows, concurrent exclusive-create ("wx") or rename while another process touches the path can surface EPERM/EACCES
      if (code !== "EEXIST" && !(process.platform === "win32" && (code === "EPERM" || code === "EACCES"))) {
        throw err;
      }

      // Check for stale lock (age exceeded OR owning PID no longer alive after brief grace window)
      try {
        const stat = fs.statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        let stale = ageMs > staleMs;
        if (!stale && ageMs > 500) {
          try {
            const raw = fs.readFileSync(lockPath, "utf8").trim();
            if (raw) {
              const meta = JSON.parse(raw) as { pid?: number };
              if (typeof meta.pid === "number" && !isPidAlive(meta.pid)) {
                stale = true;
              }
            }
          } catch {
            // Lock may still be mid-write or corrupt; fall back to staleMs timeout
          }
        }
        if (stale) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Another waiter may have already cleaned it up
          }
          continue;
        }
      } catch {
        // Lock was just released between openSync and statSync; retry immediately
        continue;
      }

      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for workspace lock "${path.relative(realRoot, lockPath)}". If no other Wraith process is running, delete the lock file and retry.`
        );
      }
      sleepSync(8 + Math.floor(Math.random() * 12));
    }
  }

  activeWorkspaceLocks.set(realRoot, 1);
  try {
    return fn();
  } finally {
    activeWorkspaceLocks.delete(realRoot);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore if already removed
    }
    if (!existedBefore) {
      try {
        fs.rmdirSync(wraithDir);
      } catch {
        // Directory is non-empty (files were intentionally persisted), keep it
      }
    }
  }
}

export interface ArchiveLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalUncompressedBytes?: number;
  maxCompressionRatio?: number;
}

const DEFAULT_ARCHIVE_LIMITS: Required<ArchiveLimits> = {
  maxEntries: 2000,
  maxEntryBytes: 32 * 1024 * 1024, // 32 MB per entry
  maxTotalUncompressedBytes: 64 * 1024 * 1024, // 64 MB total
  maxCompressionRatio: 120,
};

/**
 * Parse ZIP Central Directory headers BEFORE decompression to enforce strict
 * entry count, per-entry size, total uncompressed size, compression ratio,
 * and path-traversal limits. Protects against zip bombs in DOCX & XLSX files.
 */
export function safeUnzipSync(
  zipBytes: Uint8Array,
  limits?: ArchiveLimits
): Record<string, Uint8Array> {
  const cfg = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);

  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end of buffer
  let eocdOffset = -1;
  const minSearch = Math.max(0, zipBytes.length - 65557);
  for (let i = zipBytes.length - 22; i >= minSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new SecurityBoundaryError("invalid_archive", "Invalid ZIP archive: missing central directory.");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (totalEntries > cfg.maxEntries) {
    throw new SecurityBoundaryError(
      "archive_limit_exceeded",
      `Archive contains ${totalEntries} entries, exceeding safety limit of ${cfg.maxEntries}.`
    );
  }

  let totalUncompressed = 0;
  let pos = cdOffset;
  const cdEnd = Math.min(zipBytes.length, cdOffset + cdSize);

  while (pos + 46 <= cdEnd) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);

    const nameBytes = zipBytes.subarray(pos + 46, pos + 46 + nameLen);
    const entryName = new TextDecoder().decode(nameBytes);

    const segments = entryName.split("/");
    if (entryName.startsWith("/") || segments.includes("..") || entryName.includes("\\")) {
      throw new SecurityBoundaryError(
        "archive_path_traversal",
        `Archive entry "${entryName}" contains unsafe path traversal.`
      );
    }

    // Handle ZIP64 sentinel 0xffffffff conservatively
    if (uncompSize === 0xffffffff || uncompSize > cfg.maxEntryBytes) {
      throw new SecurityBoundaryError(
        "archive_limit_exceeded",
        `Archive entry "${entryName}" uncompressed size (${uncompSize} bytes) exceeds limit of ${cfg.maxEntryBytes} bytes.`
      );
    }

    totalUncompressed += uncompSize;
    if (totalUncompressed > cfg.maxTotalUncompressedBytes) {
      throw new SecurityBoundaryError(
        "archive_limit_exceeded",
        `Archive total uncompressed size (${totalUncompressed} bytes) exceeds limit of ${cfg.maxTotalUncompressedBytes} bytes.`
      );
    }

    if (uncompSize > 1024 * 1024 && compSize > 0 && uncompSize / compSize > cfg.maxCompressionRatio) {
      throw new SecurityBoundaryError(
        "archive_limit_exceeded",
        `Archive entry "${entryName}" compression ratio (${Math.round(uncompSize / compSize)}x) exceeds safety limit of ${cfg.maxCompressionRatio}x.`
      );
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  // Second defense layer via fflate's filter callback
  let seenEntries = 0;
  let seenTotal = 0;
  return unzipSync(zipBytes, {
    filter(file) {
      seenEntries++;
      if (seenEntries > cfg.maxEntries) {
        throw new SecurityBoundaryError("archive_limit_exceeded", "Archive entry count limit exceeded.");
      }
      if (file.originalSize > cfg.maxEntryBytes) {
        throw new SecurityBoundaryError("archive_limit_exceeded", `Archive entry "${file.name}" exceeds size limit.`);
      }
      seenTotal += file.originalSize;
      if (seenTotal > cfg.maxTotalUncompressedBytes) {
        throw new SecurityBoundaryError("archive_limit_exceeded", "Archive total uncompressed size limit exceeded.");
      }
      return true;
    },
  });
}
