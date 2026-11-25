import fs from "node:fs";
import path from "node:path";
import { resolveConfinedPath, validateLocaleTag } from "../core/security.js";
import { UsageSite } from "../core/types.js";
import { RailsYamlFormatAdapter } from "../formats/yaml.js";
import {
  ConcatenationFinding,
  FrameworkDetection,
  HardcodedStringFinding,
  LayoutRiskFinding,
  ScannerAdapter,
  ScanSourceResult,
} from "./types.js";
import {
  inspectLayoutClasses,
  isLikelyUserFacingText,
  normalizeWhitespace,
  USER_FACING_ATTRIBUTES,
  walkFiles,
} from "./utils.js";

const RAILS_EXTS = new Set([".erb", ".rb"]);

function offsetToLine(src: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function resolveRailsLazyKey(relFile: string, rawKey: string): string {
  if (!rawKey.startsWith(".")) return rawKey;
  // Rails lazy lookup: app/views/users/index.html.erb + ".title" -> "users.index.title"
  // Partials strip leading underscore: app/views/users/_form.html.erb -> "users.form.title"
  const norm = relFile.replace(/\\/g, "/");
  const m = /(?:^|\/)app\/views\/(.+?)(?:\.[a-z0-9]+)*\.erb$/i.exec(norm);
  if (!m) return rawKey.slice(1);
  const segments = m[1]
    .split("/")
    .map((seg) => (seg.startsWith("_") ? seg.slice(1) : seg));
  return `${segments.join(".")}${rawKey}`;
}

function scanErbTemplate(
  relFile: string,
  source: string,
  out: {
    hardcoded: HardcodedStringFinding[];
    concats: ConcatenationFinding[];
    usageByKey: Record<string, UsageSite[]>;
    layoutRisks: LayoutRiskFinding[];
  }
): void {
  const lines = source.split(/\r?\n/);
  const comp = path.basename(relFile, ".html.erb");

  // 1. Scan ERB tags <% ... %> / <%= ... %> for I18n.t / t(...), view helper strings, and concatenations
  for (const m of source.matchAll(/<%[=-]?([\s\S]*?)%>/g)) {
    const code = m[1];
    const line = offsetToLine(source, m.index ?? 0);
    const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);

    for (const tm of code.matchAll(/(?:\bI18n\.t|\bt)\s*\(?\s*(['"])([^'"]+)\1\s*(?=[,)\n]|$)/g)) {
      if (tm[2].includes("#{")) continue;
      const key = resolveRailsLazyKey(relFile, tm[2]);
      out.usageByKey[key] = out.usageByKey[key] ?? [];
      out.usageByKey[key].push({
        file: relFile,
        line,
        component: comp,
        element: "erb",
        surrounding: [],
      });
    }

    // Rails view helpers with hardcoded UI strings: link_to, button_to, f.submit, f.label, submit_tag, label_tag
    const helperRe =
      /\b(?:link_to|button_to|submit_tag|button_tag|[a-zA-Z_]\w*\.(?:submit|button))\s*(?:\(\s*|\s+)(['"])([^'"]+)\1/g;
    for (const hm of code.matchAll(helperRe)) {
      const txt = normalizeWhitespace(hm[2]);
      if (isLikelyUserFacingText(txt)) {
        out.hardcoded.push({
          file: relFile,
          line,
          column: 0,
          text: txt,
          kind: "ruby-string",
          component: comp,
          snippet,
        });
      }
    }
    const labelHelperRe =
      /\b(?:[a-zA-Z_]\w*\.label|label_tag)\s*(?:\(\s*|\s+):?[a-zA-Z0-9_]+\s*,\s*(['"])([^'"]+)\1/g;
    for (const lm of code.matchAll(labelHelperRe)) {
      const txt = normalizeWhitespace(lm[2]);
      if (isLikelyUserFacingText(txt)) {
        out.hardcoded.push({
          file: relFile,
          line,
          column: 0,
          text: txt,
          kind: "ruby-string",
          component: comp,
          snippet,
        });
      }
    }

    if (/"[^"]*\p{L}{2,}[^"]*#\{[^}]+\}[^"]*"/u.test(code) || /['"][^'"]*\p{L}{2,}[^'"]*['"]\s*\+/u.test(code)) {
      out.concats.push({
        file: relFile,
        line,
        column: 0,
        expression: code.trim().slice(0, 120),
        reason: "Ruby string interpolation/concatenation inside ERB breaks word order. Use Rails I18n with %{param}.",
        component: comp,
      });
    }
  }

  // 2. Strip ERB tags with equal-length spaces so line offsets remain exact, then scan HTML text & attrs
  const htmlOnly = source.replace(/<%[\s\S]*?%>/g, (s) => s.replace(/[^\n]/g, " "));

  // Scan attributes (class, placeholder, title, alt, aria-label, etc.)
  for (const attrMatch of htmlOnly.matchAll(/\b([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g)) {
    const attrName = attrMatch[1];
    const attrVal = attrMatch[2];
    const line = offsetToLine(source, attrMatch.index ?? 0);
    const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);
    if (attrName === "class") {
      for (const risk of inspectLayoutClasses(attrVal)) {
        out.layoutRisks.push({
          file: relFile,
          line,
          kind: risk.kind,
          constraint: risk.constraint,
          component: comp,
          suggestion: risk.suggestion,
          snippet,
        });
      }
    } else if (USER_FACING_ATTRIBUTES.has(attrName) && isLikelyUserFacingText(attrVal)) {
      out.hardcoded.push({
        file: relFile,
        line,
        column: 0,
        text: normalizeWhitespace(attrVal),
        kind: "attribute",
        attribute: attrName,
        component: comp,
        snippet,
      });
    }
  }

  // Scan HTML text nodes between > ... <
  for (const txtMatch of htmlOnly.matchAll(/>([^<>]+)</g)) {
    const raw = txtMatch[1];
    const text = normalizeWhitespace(raw);
    if (!isLikelyUserFacingText(text)) continue;
    const line = offsetToLine(source, (txtMatch.index ?? 0) + 1);
    const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);
    out.hardcoded.push({
      file: relFile,
      line,
      column: 0,
      text,
      kind: "template-text",
      component: comp,
      snippet,
    });
  }
}

function scanRubyFile(
  relFile: string,
  source: string,
  out: {
    hardcoded: HardcodedStringFinding[];
    concats: ConcatenationFinding[];
    usageByKey: Record<string, UsageSite[]>;
  }
): void {
  const lines = source.split(/\r?\n/);
  const comp = path.basename(relFile, ".rb");

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("#")) return;

    // Key usages: I18n.t("key") / t("key") — ignore interpolated/concatenated dynamic keys
    for (const m of trimmed.matchAll(/(?:\bI18n\.t|\bt)\s*\(\s*(['"])([^'"]+)\1\s*(?=[,)])/g)) {
      if (m[2].includes("#{")) continue;
      const key = m[2];
      out.usageByKey[key] = out.usageByKey[key] ?? [];
      out.usageByKey[key].push({
        file: relFile,
        line: lineNum,
        component: comp,
        element: "ruby",
        surrounding: [],
      });
    }

    // Hardcoded flash/notice/alert strings
    const flashMatch = /\b(?:flash\[[^\]]+\]\s*=|notice:|alert:)\s*(['"])([^'"]+)\1/.exec(trimmed);
    if (flashMatch && isLikelyUserFacingText(flashMatch[2])) {
      if (/#\{[^}]+\}/.test(flashMatch[2])) {
        out.concats.push({
          file: relFile,
          line: lineNum,
          column: 0,
          expression: trimmed.slice(0, 120),
          reason: "Interpolated flash/notice string in Ruby controller. Use I18n.t with %{param}.",
          component: comp,
        });
      } else {
        out.hardcoded.push({
          file: relFile,
          line: lineNum,
          column: 0,
          text: normalizeWhitespace(flashMatch[2]),
          kind: "ruby-string",
          component: comp,
          snippet: trimmed.slice(0, 120),
        });
      }
    }
  });
}

export class RailsAdapter implements ScannerAdapter {
  readonly id = "rails";
  readonly frameworks = ["rails"] as const;
  readonly format = new RailsYamlFormatAdapter();

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const gemfilePath = path.join(rootDir, "Gemfile");
    const hasGemfileRails =
      fs.existsSync(gemfilePath) && /\bgem\s+['"]rails['"]/.test(fs.readFileSync(gemfilePath, "utf8"));
    const hasRailsConfig = fs.existsSync(path.join(rootDir, "config", "application.rb"));

    if (!hasGemfileRails && !hasRailsConfig) return null;

    const localesDirRel = localesPathOverride ?? "config/locales";
    const localesDirAbs = path.resolve(rootDir, localesDirRel);
    const localeFiles: Record<string, string[]> = {};

    if (fs.existsSync(localesDirAbs) && fs.statSync(localesDirAbs).isDirectory()) {
      // Walk nested config/locales/** directories (standard Rails structure: config/locales/models/en.yml)
      const ymlFiles = walkFiles(rootDir, [localesDirRel], [".git", "node_modules"], new Set([".yml", ".yaml"]));
      for (const full of ymlFiles) {
        const f = path.basename(full);
        const stem = f.replace(/\.(?:yml|yaml)$/, "");
        const parts = stem.split(".");
        const locale = parts[parts.length - 1];
        localeFiles[locale] = localeFiles[locale] ?? [];
        localeFiles[locale].push(full);
      }
    }

    return {
      framework: "rails",
      i18nLibrary: "rails-i18n",
      confidence: Object.keys(localeFiles).length > 0 ? 0.98 : 0.95,
      localesDir: fs.existsSync(localesDirAbs) ? localesDirRel : null,
      localeFiles,
      placeholderSyntaxes: ["percent-brace"],
      notes: [],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[] }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, options.ignore, RAILS_EXTS).filter(
      (f) => {
        const rel = path.relative(rootDir, f).replace(/\\/g, "/");
        return !rel.startsWith("spec/") && !rel.startsWith("test/") && !rel.startsWith("db/");
      }
    );

    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};
    const layoutRisks: LayoutRiskFinding[] = [];

    for (const absFile of files) {
      const relFile = path.relative(rootDir, absFile).replace(/\\/g, "/");
      const source = fs.readFileSync(absFile, "utf8");
      if (absFile.endsWith(".erb")) {
        scanErbTemplate(relFile, source, {
          hardcoded: hardcodedStrings,
          concats: concatenations,
          usageByKey,
          layoutRisks,
        });
      } else if (absFile.endsWith(".rb")) {
        scanRubyFile(relFile, source, {
          hardcoded: hardcodedStrings,
          concats: concatenations,
          usageByKey,
        });
      }
    }

    return {
      filesScanned: files.length,
      hardcodedStrings,
      concatenations,
      usageByKey,
      layoutRisks,
    };
  }

  resolveTargetLocaleFile(
    rootDir: string,
    sourceLocale: string,
    targetLocale: string,
    sourceFile: string
  ): string {
    const safeLocale = validateLocaleTag(targetLocale, "targetLocale");
    const confinedSource = resolveConfinedPath(rootDir, sourceFile, { label: "sourceFile" });
    const dir = path.dirname(confinedSource);
    const base = path.basename(confinedSource);
    const ext = path.extname(base);
    const stem = base.slice(0, -ext.length);
    let candidate: string;
    if (stem === sourceLocale) {
      candidate = path.join(dir, `${safeLocale}${ext}`);
    } else if (stem.endsWith(`.${sourceLocale}`)) {
      candidate = path.join(dir, `${stem.slice(0, -sourceLocale.length)}${safeLocale}${ext}`);
    } else {
      candidate = path.join(dir, `${safeLocale}${ext}`);
    }
    return resolveConfinedPath(rootDir, candidate, { label: "targetLocaleFile" });
  }
}
