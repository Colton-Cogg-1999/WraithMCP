import fs from "node:fs";
import path from "node:path";

export function walkFiles(
  rootDir: string,
  sourcePaths: string[],
  ignore: string[],
  extensions: Set<string>
): string[] {
  const ignoreSet = new Set(ignore);
  const results: string[] = [];

  function visit(absPath: string) {
    if (!fs.existsSync(absPath)) return;
    const stat = fs.statSync(absPath);
    if (stat.isFile()) {
      const ext = path.extname(absPath).toLowerCase();
      if (extensions.has(ext) || extensions.has(path.basename(absPath).toLowerCase())) {
        results.push(absPath);
      }
      return;
    }
    if (!stat.isDirectory()) return;

    const entries = fs.readdirSync(absPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".polyglot") continue;
      const child = path.join(absPath, entry.name);
      const rel = path.relative(rootDir, child).replace(/\\/g, "/");
      if (ignoreSet.has(rel)) continue;
      visit(child);
    }
  }

  for (const sp of sourcePaths) {
    visit(path.resolve(rootDir, sp));
  }
  return [...new Set(results)].sort();
}

export const USER_FACING_ATTRIBUTES = new Set([
  "placeholder",
  "title",
  "alt",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "label",
  "helperText",
  "helper-text",
  "errorMessage",
  "error-message",
  "emptyText",
  "empty-text",
  "confirmText",
  "cancelText",
  "tooltip",
]);

const TECHNICAL_TOKEN_RE =
  /^(?:https?:\/\/|mailto:|tel:|\/[a-z0-9/_-]*|#[0-9a-fA-F]{3,8}|[a-z]+(?:-[a-z0-9]+){2,}|[a-z0-9_]+\.[a-z0-9_]+|[\d\s.,:%$€£¥+\-*/=<>!?()[\]{}|\\/@#^&~`'";:]+)$/;

const CSS_UTILITY_RE =
  /^(?:[a-z]+:(?:[a-z0-9-[\]/]+)|(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min-w|max-w|text|bg|border|rounded|shadow|gap|space|items|justify|font|leading|tracking|opacity|z|cursor|transition|duration|hover|focus|dark)(?:-[a-z0-9/[\].%]+)?(?:\s+|$)){2,}$/;

/**
 * Heuristic filter to identify likely user-facing copy while ignoring code identifiers,
 * URLs, CSS classes, pure numbers/punctuation, and single characters.
 */
export function isLikelyUserFacingText(raw: string): boolean {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 2) return false;
  // Must contain at least one letter (any Unicode script)
  if (!/\p{L}/u.test(text)) return false;
  if (TECHNICAL_TOKEN_RE.test(text)) return false;
  if (CSS_UTILITY_RE.test(text)) return false;
  // Ignore camelCase / snake_case / SCREAMING_SNAKE identifiers with no spaces
  if (!text.includes(" ")) {
    if (/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(text)) return false;
    if (/^[a-z0-9]+_[a-z0-9_]+$/.test(text)) return false;
    if (/^[A-Z0-9]+_[A-Z0-9_]+$/.test(text)) return false;
    // Ignore file paths or mime types
    if (text.includes("/") || text.includes("\\")) return false;
  }
  return true;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface DetectedClassRisk {
  kind: "truncation_or_fixed_width" | "rtl_physical_direction";
  constraint: string;
  suggestion: string;
}

const TIGHT_WIDTH_CLASS_RE = /\b(?:truncate|whitespace-nowrap|line-clamp-1|w-(?:1[0-9]|2[0-8]|3[0-2]|\[[0-9]{1,3}px\])|max-w-(?:xs|\[[0-9]{1,3}px\]))\b/g;
const RTL_PHYSICAL_CLASS_RE = /\b(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)(?:-[a-z0-9[\].]+)?\b/g;

/**
 * Inspect className / class strings for layout constraints that frequently break
 * under 30-40% text expansion (pseudo-locale, German, French) or RTL mirroring.
 */
export function inspectLayoutClasses(classText: string): DetectedClassRisk[] {
  const risks: DetectedClassRisk[] = [];
  const tightMatches = [...new Set([...classText.matchAll(TIGHT_WIDTH_CLASS_RE)].map((m) => m[0]))];
  const hasOverflowClip = /\boverflow-hidden\b/.test(classText);

  if (
    tightMatches.length > 0 &&
    (tightMatches.includes("truncate") ||
      tightMatches.includes("whitespace-nowrap") ||
      tightMatches.includes("line-clamp-1") ||
      hasOverflowClip)
  ) {
    risks.push({
      kind: "truncation_or_fixed_width",
      constraint: [...tightMatches, ...(hasOverflowClip ? ["overflow-hidden"] : [])].join(" "),
      suggestion:
        "Tight width or nowrap/truncate constraint may clip expanded translations (+30-40% in pseudo-locale / German / French). Prefer min-w, allow wrapping, or verify visually in pseudo-locale.",
    });
  }

  const rtlMatches = [...new Set([...classText.matchAll(RTL_PHYSICAL_CLASS_RE)].map((m) => m[0]))];
  if (rtlMatches.length > 0) {
    risks.push({
      kind: "rtl_physical_direction",
      constraint: rtlMatches.slice(0, 4).join(" "),
      suggestion:
        "Physical left/right spacing or alignment breaks visual continuity in RTL locales (e.g. Arabic/Hebrew). Prefer CSS logical utilities (ms-/me-, ps-/pe-, start-/end-, text-start/text-end).",
    });
  }

  return risks;
}

export function readPackageJson(rootDir: string): Record<string, unknown> | null {
  const p = path.join(rootDir, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getAllDependencies(pkg: Record<string, unknown> | null): Record<string, string> {
  if (!pkg) return {};
  return {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
    ...((pkg.peerDependencies as Record<string, string>) ?? {}),
  };
}

/**
 * Discover JSON locale files inside candidate directories.
 * Supports both flat `<dir>/<locale>.json` (next-intl, vue-i18n, paraglide)
 * and nested `<dir>/<locale>/<namespace>.json` (react-i18next).
 */
export function discoverJsonLocaleFiles(
  rootDir: string,
  candidateDirs: string[]
): { localesDir: string | null; localeFiles: Record<string, string[]> } {
  const localePattern = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?(?:-[A-Za-z0-9]{2,8})*$/;

  for (const rel of candidateDirs) {
    const abs = path.resolve(rootDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;

    const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const localeFiles: Record<string, string[]> = {};

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const stem = entry.name.slice(0, -5);
        if (localePattern.test(stem) || stem === "en-x-pseudo" || stem === "pseudo") {
          localeFiles[stem] = localeFiles[stem] ?? [];
          localeFiles[stem].push(path.join(abs, entry.name));
        }
      } else if (entry.isDirectory()) {
        if (localePattern.test(entry.name) || entry.name === "en-x-pseudo" || entry.name === "pseudo") {
          const nested = fs
            .readdirSync(path.join(abs, entry.name))
            .filter((f) => f.endsWith(".json"))
            .sort()
            .map((f) => path.join(abs, entry.name, f));
          if (nested.length > 0) {
            localeFiles[entry.name] = [...(localeFiles[entry.name] ?? []), ...nested];
          }
        }
      }
    }

    if (Object.keys(localeFiles).length > 0) {
      return {
        localesDir: path.relative(rootDir, abs).replace(/\\/g, "/") || ".",
        localeFiles,
      };
    }
  }

  return { localesDir: null, localeFiles: {} };
}
