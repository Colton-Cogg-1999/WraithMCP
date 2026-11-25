import fs from "node:fs";
import path from "node:path";
import { resolveConfinedPath, validateLocaleTag } from "../core/security.js";
import { UsageSite } from "../core/types.js";
import { GettextPoFormatAdapter } from "../formats/po.js";
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

const DJANGO_EXTS = new Set([".html", ".py"]);

function offsetToLine(src: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function scanDjangoTemplate(
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
  const comp = path.basename(relFile, ".html");

  // 1. {% trans "..." %} and {% translate "..." %} usage sites
  for (const m of source.matchAll(/\{%\s*(?:trans|translate)\s+(['"])([^'"]+)\1/g)) {
    const key = m[2];
    const line = offsetToLine(source, m.index ?? 0);
    out.usageByKey[key] = out.usageByKey[key] ?? [];
    out.usageByKey[key].push({
      file: relFile,
      line,
      component: comp,
      element: "django-template",
      surrounding: [],
    });
  }

  // 2. {% blocktrans %}...{% endblocktrans %} usage sites
  for (const m of source.matchAll(
    /\{%\s*blocktrans(?:late)?[^%]*%\}([\s\S]*?)\{%\s*endblocktrans(?:late)?\s*%\}/g
  )) {
    const key = normalizeWhitespace(m[1]);
    if (!key) continue;
    const line = offsetToLine(source, m.index ?? 0);
    out.usageByKey[key] = out.usageByKey[key] ?? [];
    out.usageByKey[key].push({
      file: relFile,
      line,
      component: comp,
      element: "blocktrans",
      surrounding: [],
    });
  }

  // Strip Django template tags & blocktrans blocks preserving line breaks so offsets match
  const stripped = source
    .replace(
      /\{%\s*blocktrans(?:late)?[^%]*%\}[\s\S]*?\{%\s*endblocktrans(?:late)?\s*%\}/g,
      (s) => s.replace(/[^\n]/g, " ")
    )
    .replace(/\{%[\s\S]*?%\}/g, (s) => s.replace(/[^\n]/g, " "))
    .replace(/\{#[\s\S]*?#\}/g, (s) => s.replace(/[^\n]/g, " "));

  // Attributes (class, placeholder, aria-label, title, alt)
  for (const attrMatch of stripped.matchAll(/\b([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g)) {
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
    } else if (
      USER_FACING_ATTRIBUTES.has(attrName) &&
      !attrVal.includes("{{") &&
      isLikelyUserFacingText(attrVal)
    ) {
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

  // HTML text nodes & mixed {{ var }} fragments
  for (const txtMatch of stripped.matchAll(/>([^<>]+)</g)) {
    const raw = txtMatch[1];
    const line = offsetToLine(source, (txtMatch.index ?? 0) + 1);
    const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);

    if (/\{\{[^}]+\}\}/.test(raw)) {
      const withoutVars = normalizeWhitespace(raw.replace(/\{\{[^}]+\}\}/g, " "));
      if (isLikelyUserFacingText(withoutVars)) {
        out.concats.push({
          file: relFile,
          line,
          column: 0,
          expression: snippet,
          reason: "Sentence split around Django template variable {{ ... }}. Wrap in {% blocktranslate %}.",
          component: comp,
        });
      }
      continue;
    }

    const text = normalizeWhitespace(raw);
    if (isLikelyUserFacingText(text)) {
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
}

function scanPythonFile(
  relFile: string,
  source: string,
  out: {
    hardcoded: HardcodedStringFinding[];
    concats: ConcatenationFinding[];
    usageByKey: Record<string, UsageSite[]>;
  }
): void {
  const lines = source.split(/\r?\n/);
  const comp = path.basename(relFile, ".py");

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("#")) return;

    // gettext / gettext_lazy / _(...) usage sites
    for (const m of trimmed.matchAll(/(?:\bgettext_lazy|\bgettext|\b_)\s*\(\s*(['"])([^'"]+)\1/g)) {
      const key = m[2];
      out.usageByKey[key] = out.usageByKey[key] ?? [];
      out.usageByKey[key].push({
        file: relFile,
        line: lineNum,
        component: comp,
        element: "python",
        surrounding: [],
      });
    }

    // Django messages.success / messages.error / HttpResponse hardcoded or f-string messages
    const msgMatch = /\bmessages\.(?:success|error|warning|info)\s*\(\s*[^,]+,\s*(f?)(['"])([^'"]+)\2/.exec(
      trimmed
    );
    if (msgMatch) {
      const isFString = msgMatch[1] === "f";
      const text = msgMatch[3];
      if (isFString && /\{[^}]+\}/.test(text)) {
        out.concats.push({
          file: relFile,
          line: lineNum,
          column: 0,
          expression: trimmed.slice(0, 120),
          reason: "Python f-string in Django user message cannot be extracted by gettext. Use _('... %(x)s') % {'x': val}.",
          component: comp,
        });
      } else if (isLikelyUserFacingText(text)) {
        out.hardcoded.push({
          file: relFile,
          line: lineNum,
          column: 0,
          text: normalizeWhitespace(text),
          kind: "python-string",
          component: comp,
          snippet: trimmed.slice(0, 120),
        });
      }
    }
  });
}

function normalizeDjangoLocaleFromDir(dirName: string): string {
  // Django uses `es_MX` or `zh_Hans` on disk; map to BCP-47 `es-MX`, `zh-Hans`
  return dirName.replace(/_/g, "-");
}

function toDjangoLocaleDir(bcp47: string): string {
  return bcp47.replace(/-/g, "_");
}

export class DjangoAdapter implements ScannerAdapter {
  readonly id = "django";
  readonly frameworks = ["django"] as const;
  readonly format = new GettextPoFormatAdapter();

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const hasManagePy = fs.existsSync(path.join(rootDir, "manage.py"));
    const reqPath = path.join(rootDir, "requirements.txt");
    const pyprojPath = path.join(rootDir, "pyproject.toml");
    const hasDjangoDep =
      (fs.existsSync(reqPath) && /\bdjango\b/i.test(fs.readFileSync(reqPath, "utf8"))) ||
      (fs.existsSync(pyprojPath) && /\bdjango\b/i.test(fs.readFileSync(pyprojPath, "utf8")));

    if (!hasManagePy && !hasDjangoDep) return null;

    const candidates = [
      ...(localesPathOverride ? [localesPathOverride] : []),
      "locale",
      "locales",
    ];
    let localesDir: string | null = null;
    const localeFiles: Record<string, string[]> = {};

    for (const rel of candidates) {
      const abs = path.resolve(rootDir, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const lcDir = path.join(abs, entry.name, "LC_MESSAGES");
        if (!fs.existsSync(lcDir)) continue;
        const poFiles = fs
          .readdirSync(lcDir)
          .filter((f) => f.endsWith(".po"))
          .sort()
          .map((f) => path.join(lcDir, f));
        if (poFiles.length > 0) {
          const bcp47 = normalizeDjangoLocaleFromDir(entry.name);
          localeFiles[bcp47] = poFiles;
          localesDir = rel;
        }
      }
      if (localesDir) break;
    }

    return {
      framework: "django",
      i18nLibrary: "django-gettext",
      confidence: 0.95,
      localesDir,
      localeFiles,
      placeholderSyntaxes: ["python-printf", "single-brace"],
      notes: [],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[] }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, options.ignore, DJANGO_EXTS).filter(
      (f) =>
        !f.endsWith("manage.py") &&
        !f.includes("/migrations/") &&
        !f.includes("/tests/") &&
        !f.endsWith("settings.py")
    );

    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};
    const layoutRisks: LayoutRiskFinding[] = [];

    for (const absFile of files) {
      const relFile = path.relative(rootDir, absFile).replace(/\\/g, "/");
      const source = fs.readFileSync(absFile, "utf8");
      if (absFile.endsWith(".html")) {
        scanDjangoTemplate(relFile, source, {
          hardcoded: hardcodedStrings,
          concats: concatenations,
          usageByKey,
          layoutRisks,
        });
      } else if (absFile.endsWith(".py")) {
        scanPythonFile(relFile, source, {
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
    const absRoot = fs.realpathSync(path.resolve(rootDir));
    const relFromRoot = path.relative(absRoot, confinedSource);

    // Rewrite ONLY the <locale>/LC_MESSAGES segment inside the repo-relative path (never touch parent dirs like /clients/en/shop)
    const tgtDir = toDjangoLocaleDir(safeLocale);
    const lcPattern = new RegExp(
      `(^|[\\\\/])${toDjangoLocaleDir(sourceLocale).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\\\/]LC_MESSAGES[\\\\/])`
    );
    let candidateRel: string;
    if (lcPattern.test(relFromRoot)) {
      candidateRel = relFromRoot.replace(lcPattern, `$1${tgtDir}$2`);
    } else {
      // Handle standard makemessages layout where sourceFile is itself a target .po (e.g. locale/fr/LC_MESSAGES/django.po)
      const genericLcPattern = /(^|[\\/])[^\\/]+([\\/]LC_MESSAGES[\\/])/;
      if (genericLcPattern.test(relFromRoot)) {
        candidateRel = relFromRoot.replace(genericLcPattern, `$1${tgtDir}$2`);
      } else {
        candidateRel = path.join("locale", tgtDir, "LC_MESSAGES", path.basename(confinedSource));
      }
    }
    return resolveConfinedPath(rootDir, candidateRel, { label: "targetLocaleFile" });
  }
}
