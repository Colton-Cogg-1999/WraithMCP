import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, withWorkspaceLock } from "./security.js";
import { WraithStore } from "./store.js";

/* ------------------------------------------------------------------------------------------------
 * Run log: what Wraith caught during a run and what was fixed afterwards, so the report can say
 * "N errors were caught and fixed" (Mitigations). Local working state, not project memory: it is
 * gitignored, pruned to 14 days, and a "run" is a burst of activity (a new run starts after an
 * hour of inactivity).
 * ---------------------------------------------------------------------------------------------- */

export type RunEvent =
  | { type: "caught"; by: "apply" | "qe"; locale: string; key: string; code: string; message: string; at: string }
  | { type: "applied"; locale: string; key: string; at: string };

const LOG_FILE = "run-log.jsonl";
const RETENTION_MS = 14 * 24 * 3600 * 1000;
export const RUN_GAP_MS = 3600 * 1000;

function logPath(rootDir: string): string {
  return new WraithStore(rootDir).filePath(LOG_FILE);
}

export function readRunLog(rootDir: string): RunEvent[] {
  const p = logPath(rootDir);
  if (!fs.existsSync(p)) return [];
  const out: RunEvent[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RunEvent);
    } catch {
      // a torn last line from a crash is not worth failing a report over
    }
  }
  return out;
}

export function ensureWraithGitignore(rootDir: string): void {
  const store = new WraithStore(rootDir);
  store.ensureDir();
  const ignorePath = store.filePath(".gitignore");
  const required = [LOG_FILE, "qe-tasks.json"];
  if (!fs.existsSync(ignorePath)) {
    atomicWriteFileSync(ignorePath, `${required.join("\n")}\n`);
    return;
  }
  const existing = fs.readFileSync(ignorePath, "utf8");
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = required.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  atomicWriteFileSync(ignorePath, `${existing}${sep}${missing.join("\n")}\n`);
}

export function normalizeSince(since: string | undefined): string | undefined {
  if (since === undefined) return undefined;
  const trimmed = since.trim();
  if (!trimmed) throw new Error('Invalid --since timestamp "": expected an ISO-8601 date or timestamp.');
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --since timestamp "${since}": expected a valid ISO-8601 date or timestamp (e.g. "2026-11-26T10:00:00Z").`);
  }
  return new Date(ms).toISOString();
}

export function appendRunEvents(rootDir: string, events: RunEvent[]): void {
  if (events.length === 0) return;
  withWorkspaceLock(rootDir, () => {
    ensureWraithGitignore(rootDir);
    const cutoff = Date.now() - RETENTION_MS;
    const existing = readRunLog(rootDir);
    if (existing.length > 0 && Date.parse(existing[0].at) < cutoff) {
      const kept = existing.filter((e) => Date.parse(e.at) >= cutoff);
      const nextLines = [...kept, ...events].map((e) => JSON.stringify(e)).join("\n") + "\n";
      atomicWriteFileSync(logPath(rootDir), nextLines);
      return;
    }
    fs.appendFileSync(logPath(rootDir), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });
}

/** Start of the current run: the first event after the last gap of more than an hour. */
export function currentRunStart(events: RunEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  let start = events[0].at;
  for (let i = 1; i < events.length; i++) {
    if (Date.parse(events[i].at) - Date.parse(events[i - 1].at) > RUN_GAP_MS) start = events[i].at;
  }
  return start;
}

export interface Mitigation {
  locale: string;
  key: string;
  by: "apply" | "qe";
  code: string;
  message: string;
  caughtAt: string;
  fixedAt: string;
}

/** Every catch in the window that a later successful apply of the same string fixed. */
export function mitigationsSince(events: RunEvent[], since?: string): Mitigation[] {
  const normalizedSince = normalizeSince(since);
  const sinceMs = normalizedSince ? Date.parse(normalizedSince) : undefined;
  const inWindow = sinceMs !== undefined ? events.filter((e) => Date.parse(e.at) >= sinceMs) : events;
  const out: Mitigation[] = [];
  const seen = new Set<string>();
  for (const e of inWindow) {
    if (e.type !== "caught") continue;
    const eMs = Date.parse(e.at);
    const fix = inWindow.find((f) => f.type === "applied" && f.locale === e.locale && f.key === e.key && Date.parse(f.at) > eMs);
    if (!fix) continue;
    const id = `${e.locale}\0${e.key}\0${e.code}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ locale: e.locale, key: e.key, by: e.by, code: e.code, message: e.message, caughtAt: e.at, fixedAt: fix.at });
  }
  return out;
}

export function relLogPath(): string {
  return path.join(".wraith", LOG_FILE);
}
