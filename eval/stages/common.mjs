import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { CACHE_DIR, WRAITH_BIN } from "../config.mjs";

export function flattenJson(obj, prefix = "", out = {}) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenJson(v, key, out);
    } else if (v !== null && v !== undefined) {
      out[key] = String(v);
    }
  }
  return out;
}

export function unflattenJson(flat) {
  const root = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return root;
}

export function parseYamlCatalog(yamlText, expectedRootLocale = null) {
  const parsed = YAML.parse(yamlText);
  if (!parsed || typeof parsed !== "object") return {};
  const topKeys = Object.keys(parsed);
  if (
    expectedRootLocale &&
    parsed[expectedRootLocale] &&
    typeof parsed[expectedRootLocale] === "object"
  ) {
    return flattenJson(parsed[expectedRootLocale]);
  }
  if (topKeys.length === 1 && typeof parsed[topKeys[0]] === "object") {
    return flattenJson(parsed[topKeys[0]]);
  }
  return flattenJson(parsed);
}

export function writeYamlCatalog(locale, flatMap) {
  const nested = unflattenJson(flatMap);
  return YAML.stringify({ [locale]: nested });
}

export function parsePoCatalog(poText) {
  const out = {};
  const blocks = poText.split(/\r?\n\r?\n+/);
  const unescape = (s) =>
    s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  for (const block of blocks) {
    if (/^#,.*\bfuzzy\b/m.test(block)) continue;
    if (/^msgid_plural\b/m.test(block)) continue;
    const lines = block.split(/\r?\n/);
    let mode = null;
    let msgid = "";
    let msgstr = "";
    let hasCtx = false;
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith("msgctxt ")) {
        hasCtx = true;
        mode = null;
      } else if (t.startsWith("msgid ")) {
        mode = "id";
        const m = /^msgid\s+"(.*)"$/.exec(t);
        if (m) msgid += unescape(m[1]);
      } else if (t.startsWith("msgstr ")) {
        mode = "str";
        const m = /^msgstr\s+"(.*)"$/.exec(t);
        if (m) msgstr += unescape(m[1]);
      } else if (t.startsWith('"') && t.endsWith('"')) {
        const s = unescape(t.slice(1, -1));
        if (mode === "id") msgid += s;
        else if (mode === "str") msgstr += s;
      } else {
        mode = null;
      }
    }
    if (!hasCtx && msgid) {
      out[msgid] = msgstr;
    }
  }
  return out;
}

export function writePoCatalogFromSkeleton(skeletonPo, translationsByMsgid) {
  const esc = (s) =>
    String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
  const blocks = skeletonPo.split(/\r?\n\r?\n/);
  const updated = blocks.map((block) => {
    if (/^msgid\s+""\s*$/m.test(block) && /^msgstr\s+""\s*$/m.test(block)) return block;
    if (/^msgid_plural\b/m.test(block)) {
      const m1 = /^msgid\s+"((?:\\.|[^"\\])*)"$/m.exec(block);
      const m2 = /^msgid_plural\s+"((?:\\.|[^"\\])*)"$/m.exec(block);
      const trSing = m1 ? translationsByMsgid[m1[1]] : undefined;
      const trPlur = m2 ? translationsByMsgid[m2[1]] : undefined;
      if (!trSing && !trPlur) return block;
      return block.replace(/^msgstr\[(\d+)\]\s+"(?:\\.|[^"\\])*"$/gm, (_full, idx) => {
        const chosen = Number(idx) === 0 ? (trSing ?? trPlur) : (trPlur ?? trSing);
        return `msgstr[${idx}] "${esc(chosen)}"`;
      });
    }
    const m = /^msgid\s+"((?:\\.|[^"\\])*)"$/m.exec(block);
    if (!m) return block;
    const unesc = m[1]
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    const tr = translationsByMsgid[unesc];
    if (tr === undefined) return block;
    return block.replace(/^msgstr\s+"(?:\\.|[^"\\])*"$/m, `msgstr "${esc(tr)}"`);
  });
  return updated.join("\n\n") + "\n";
}

export function runWraithCli(cwd, args) {
  try {
    const out = execFileSync(WRAITH_BIN, ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: out, stderr: "" };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? String(err.message),
    };
  }
}

export function parseWraithJson(cliRes) {
  try {
    return JSON.parse(cliRes.stdout);
  } catch {
    return { parseError: (cliRes.stdout || cliRes.stderr).slice(0, 400) };
  }
}

export function seedWraithProject(dir, targetLocales, glossaryEntries = [], configPatch = null) {
  runWraithCli(dir, ["init", "-s", "en", "-t", targetLocales.join(","), "--no-agent-rule"]);
  if (glossaryEntries && glossaryEntries.length > 0) {
    const fixedTs = "2026-01-01T00:00:00.000Z";
    const glossaryFile = {
      version: 1,
      entries: glossaryEntries.map((g) => ({
        term: g.term,
        doNotTranslate: Boolean(g.doNotTranslate),
        caseSensitive: Boolean(g.caseSensitive),
        translations: g.translations ?? {},
        notes: g.notes,
        origin: "user",
        updatedAt: fixedTs,
      })),
    };
    fs.writeFileSync(
      path.join(dir, ".wraith", "glossary.json"),
      JSON.stringify(glossaryFile, null, 2) + "\n"
    );
  }
  if (configPatch) {
    const cfgPath = path.join(dir, ".wraith", "config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      configPatch(cfg);
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    }
  }
}

export function extractGlossaryForLocale(glossaryEntries, locale) {
  return (glossaryEntries ?? []).map((g) => ({
    term: g.term,
    doNotTranslate: Boolean(g.doNotTranslate),
    caseSensitive: Boolean(g.caseSensitive),
    expectedTranslation: g.translations?.[locale] ?? null,
    notes: g.notes,
  }));
}

/**
 * Build DeepL `context` parameter strings (~300 chars max) for System B+ctx (Change #2):
 * key path + component name + nearby UI strings from the same component + compact code snippet.
 */
export function buildContextMapForApp(items, componentsByBasename) {
  const byComp = new Map();
  for (const it of items) {
    const c = it.component ?? "app";
    if (!byComp.has(c)) byComp.set(c, []);
    byComp.get(c).push(it);
  }

  const contextByKey = {};
  for (const it of items) {
    const compName = it.component ?? "app";
    const siblings = (byComp.get(compName) ?? [])
      .filter((s) => s.key !== it.key)
      .slice(0, 4)
      .map((s) => `${s.key}="${s.source}"`)
      .join("; ");

    const rawCode = componentsByBasename[compName] ?? "";
    // Prefer comments + lines referencing this key or short compact JSX snippet
    const codeLines = rawCode
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("import ") && !l.startsWith("from "));
    const leaf = it.key.split(".").pop();
    const matchIdx = codeLines.findIndex(
      (l) => l.includes(it.key) || (leaf && l.includes(leaf)) || l.includes(it.source.slice(0, 20))
    );
    let snippet = "";
    if (matchIdx >= 0) {
      const start = Math.max(0, matchIdx - 2);
      const end = Math.min(codeLines.length, matchIdx + 2);
      snippet = codeLines.slice(start, end).join(" ");
    } else {
      snippet = codeLines.slice(0, 3).join(" ");
    }

    const parts = [`Key: ${it.key}`, `Component: ${compName}`];
    if (siblings) parts.push(`Nearby: ${siblings}`);
    if (snippet) parts.push(`Code: ${snippet}`);
    contextByKey[it.key] = parts.join(" | ").replace(/\s+/g, " ").slice(0, 300);
  }
  return contextByKey;
}

/**
 * Normalize per-1,000-strings token & MCP telemetry (Change #5).
 */
export function normalizeTelemetryPer1k(telemetry, stringCount) {
  const n = Math.max(1, stringCount);
  const scale = 1000 / n;
  const uncachedInputTokens =
    telemetry.uncachedInputTokens ??
    Math.max(0, (telemetry.inputTokens ?? 0) - (telemetry.cachedInputTokens ?? 0));
  return {
    stringCount: n,
    modelTurns: telemetry.modelTurns ?? 0,
    inputTokens: telemetry.inputTokens ?? 0,
    cachedInputTokens: telemetry.cachedInputTokens ?? 0,
    uncachedInputTokens,
    outputTokens: telemetry.outputTokens ?? 0,
    inputTokensPer1k: Math.round((telemetry.inputTokens ?? 0) * scale),
    uncachedInputTokensPer1k: Math.round(uncachedInputTokens * scale),
    outputTokensPer1k: Math.round((telemetry.outputTokens ?? 0) * scale),
    totalMcpResponseBytes: telemetry.totalMcpResponseBytes ?? 0,
    totalMcpApproxTokens: telemetry.totalMcpApproxTokens ?? 0,
    mcpBytesPer1k: Math.round((telemetry.totalMcpResponseBytes ?? 0) * scale),
    mcpApproxTokensPer1k: Math.round((telemetry.totalMcpApproxTokens ?? 0) * scale),
    mcpTotalsByTool: telemetry.mcpTotalsByTool ?? {},
    checkIterations: telemetry.checkIterations ?? 0,
    prepareCalls: telemetry.prepareCalls ?? 0,
    applyCalls: telemetry.applyCalls ?? 0,
  };
}

/**
 * Inspect Pilot DeepL cache entries for the exact raw DeepL responses behind Change #4
 * (`icu.orderPipeline` harness bug vs `rich.backupNotice` genuine DeepL XML bug).
 */
export function extractPilotIcuRawDiagnostics() {
  const dir = path.join(CACHE_DIR, "deepl-text");
  if (!fs.existsSync(dir)) return [];
  const findings = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const val = String(obj.value ?? "");
      if (val.includes("{número, plural,") || val.includes("{Anzahl, Plural,")) {
        const isEs = val.includes("{número");
        findings.push({
          key: "icu.orderPipeline",
          targetLang: isEs ? "ES" : "DE",
          cacheFile: f,
          rawInputXml:
            '{count, plural, one {<ph id="0"/> pending order} other {<ph id="1"/> pending orders}}',
          rawDeeplResponse: val,
          rootCause: "HARNESS_BUG",
          explanation:
            "Pilot splitIcuTopLevel() did not recurse into nested {count, plural, ...} inside {status, select, ...}, so raw ICU syntax was sent to DeepL, which translated keywords ('plural', 'one', 'other') and variable name ('count' -> 'número'/'Anzahl'). Fixed in Stage 3 via splitIcuRecursive().",
        });
      }
      if (val.includes("LedgerVault") && val.includes("&lt;img")) {
        findings.push({
          key: "rich.backupNotice",
          targetLang: "DE",
          cacheFile: f,
          rawInputXml:
            'Automatic snapshots are stored in <ph id="0"/>LedgerVault<ph id="1"/> every <ph id="2"/>24h<ph id="3"/>.',
          rawDeeplResponse: val,
          rootCause: "DEEPL_API_XML_BUG",
          explanation:
            "Genuine DeepL XML tag_handling corruption: input had four self-closing <ph id='0..3'/> tags; DeepL hallucinated a literal '&lt;img id=\"4\"/&gt;' and cross-nested <ph id=\"3\"/> after 'gespeichert', causing unbalanced <codeTag> in restored output. Stage 3 also upgraded rich text protection to paired <rt0>...</rt0> tags.",
        });
      }
    } catch {
      // ignore unreadable cache entries
    }
  }
  return findings;
}
