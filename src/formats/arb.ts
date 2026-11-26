import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../core/security.js";
import { FormatAdapter, FormatWriteUpdate, LocaleEntry, LocaleFileData } from "./types.js";

/**
 * Lossless Flutter Application Resource Bundle (.arb) format adapter.
 *
 * - Reads all non-`@` string keys into normalized `LocaleEntry` records, attaching
 *   `@<key>.description` as `entry.comment` so translators and QE reviewers see
 *   developer-authored ARB metadata automatically.
 * - Preserves `@@locale`, `@<key>` metadata blocks, indentation, and key ordering on write.
 */
export class ArbFormatAdapter implements FormatAdapter {
  readonly id = "arb";
  readonly extensions = [".arb"] as const;
  readonly placeholderSyntaxes = ["icu", "single-brace"] as const;

  readFile(filePath: string, locale: string): LocaleFileData {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = new Map<string, LocaleEntry>();

    for (const [key, val] of Object.entries(parsed)) {
      if (key.startsWith("@")) continue;
      if (typeof val !== "string") continue;
      const meta = parsed[`@${key}`];
      const comment =
        meta && typeof meta === "object" && typeof (meta as { description?: unknown }).description === "string"
          ? ((meta as { description: string }).description)
          : undefined;
      entries.set(key, {
        key,
        value: val,
        comment,
        file: filePath,
      });
    }

    return {
      locale,
      filePath,
      entries,
    };
  }

  applyUpdates(
    filePath: string,
    locale: string,
    updates: FormatWriteUpdate[],
    options?: { sourceFilePath?: string; write?: boolean }
  ): string {
    let existing: Record<string, unknown> = {};
    let indent = 2;
    let trailingNewline = true;

    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      trailingNewline = raw.endsWith("\n");
      const m = raw.match(/\n([ \t]+)"/);
      if (m) indent = m[1].length;
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }

    if (typeof existing["@@locale"] !== "string") {
      existing = { "@@locale": locale.replace(/-/g, "_"), ...existing };
    }

    const updateMap = new Map(updates.map((u) => [u.key, u.value]));
    const next: Record<string, unknown> = {};

    // Follow source key order if sourceFilePath is available
    let sourceOrder: string[] = [];
    if (options?.sourceFilePath && fs.existsSync(options.sourceFilePath)) {
      try {
        const srcObj = JSON.parse(fs.readFileSync(options.sourceFilePath, "utf8")) as Record<string, unknown>;
        sourceOrder = Object.keys(srcObj);
      } catch {
        sourceOrder = [];
      }
    }

    if (existing["@@locale"] !== undefined) {
      next["@@locale"] = existing["@@locale"];
    }

    for (const k of sourceOrder) {
      if (k === "@@locale") continue;
      if (k.startsWith("@")) {
        if (existing[k] !== undefined) next[k] = existing[k];
        continue;
      }
      if (updateMap.has(k)) {
        next[k] = updateMap.get(k);
        updateMap.delete(k);
      } else if (existing[k] !== undefined) {
        next[k] = existing[k];
      }
    }

    // Preserve any remaining existing keys
    for (const [k, v] of Object.entries(existing)) {
      if (k in next) continue;
      next[k] = updateMap.has(k) ? updateMap.get(k) : v;
      updateMap.delete(k);
    }

    // Append any brand new keys
    for (const [k, v] of updateMap.entries()) {
      next[k] = v;
    }

    const out = JSON.stringify(next, null, indent) + (trailingNewline ? "\n" : "");
    if (options?.write !== false) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      atomicWriteFileSync(filePath, out);
    }
    return out;
  }
}
