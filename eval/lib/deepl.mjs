import fs from "node:fs";
import path from "node:path";
import {
  DEEPL_ENV_PATH,
  DEEPL_LANG_MAP,
  DEEPL_STAGE_CHAR_CAP,
} from "../config.mjs";
import { getCached, setCached, sha256Buffer, withCache } from "./cache.mjs";
import { recordCost } from "./cost.mjs";

const GLOSSARY_PREFIX = "polyglot-eval-";
const glossaryDeletionLog = [];

export function getGlossaryDeletionLog() {
  return [...glossaryDeletionLog];
}

/**
 * Load DEEPL_API_KEY strictly in memory at runtime from ../LocRAG/.env.
 * NEVER prints, logs, caches, or persists the key anywhere.
 */
function loadDeepLCredentials() {
  if (!fs.existsSync(DEEPL_ENV_PATH)) {
    throw new Error(`DeepL .env file not found at ${DEEPL_ENV_PATH}`);
  }
  const raw = fs.readFileSync(DEEPL_ENV_PATH, "utf8");
  const m = /^DEEPL_API_KEY\s*=\s*(.+)$/m.exec(raw);
  if (!m) {
    throw new Error(`DEEPL_API_KEY not found in ${DEEPL_ENV_PATH}`);
  }
  const key = m[1].trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("DEEPL_API_KEY is empty");
  const isFree = key.endsWith(":fx");
  return {
    key,
    isFree,
    tier: isFree ? "free" : "pro",
    baseUrl: isFree ? "https://api-free.deepl.com" : "https://api.deepl.com",
  };
}

export async function getDeepLUsage() {
  const { key, baseUrl, tier } = loadDeepLCredentials();
  const res = await fetch(`${baseUrl}/v2/usage`, {
    headers: { Authorization: `DeepL-Auth-Key ${key}` },
  });
  if (!res.ok) {
    throw new Error(`DeepL /v2/usage failed with HTTP ${res.status}`);
  }
  const data = await res.json();
  return {
    tier,
    baseUrl,
    character_count: Number(data.character_count ?? 0),
    character_limit: Number(data.character_limit ?? 0),
    remaining: Math.max(0, Number(data.character_limit ?? 0) - Number(data.character_count ?? 0)),
    checkedAt: new Date().toISOString(),
  };
}

export function assertDeepLStageCap(stageName, beforeUsage, projectedNewChars, cap = DEEPL_STAGE_CHAR_CAP) {
  if (projectedNewChars > cap) {
    throw new Error(
      `DeepL stage cap exceeded for "${stageName}": projected ${projectedNewChars} chars > cap ${cap}.`
    );
  }
  if (beforeUsage && beforeUsage.character_count + projectedNewChars > beforeUsage.character_limit) {
    throw new Error(
      `DeepL account quota exceeded for "${stageName}": ${beforeUsage.character_count} + ${projectedNewChars} > ${beforeUsage.character_limit}.`
    );
  }
}

export async function getSupportedGlossaryPairs() {
  const cached = await withCache("deepl-meta", { endpoint: "glossary-language-pairs" }, async () => {
    const { key, baseUrl } = loadDeepLCredentials();
    const res = await fetch(`${baseUrl}/v2/glossary-language-pairs`, {
      headers: { Authorization: `DeepL-Auth-Key ${key}` },
    });
    if (!res.ok) return { supported_languages: [] };
    return res.json();
  });
  return cached.value?.supported_languages ?? [];
}

/**
 * Delete ONLY DeepL glossaries whose name starts with `polyglot-eval-` (NEVER touches
 * glossaries from other projects sharing this API key) and logs every deletion by ID.
 */
export async function cleanupPolyglotEvalGlossaries(reason = "slot-release") {
  const { key, baseUrl } = loadDeepLCredentials();
  const res = await fetch(`${baseUrl}/v2/glossaries`, {
    headers: { Authorization: `DeepL-Auth-Key ${key}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const ours = (data.glossaries ?? []).filter((g) => String(g.name ?? "").startsWith(GLOSSARY_PREFIX));
  const deleted = [];
  for (const g of ours) {
    const del = await fetch(`${baseUrl}/v2/glossaries/${g.glossary_id}`, {
      method: "DELETE",
      headers: { Authorization: `DeepL-Auth-Key ${key}` },
    });
    if (del.ok || del.status === 204) {
      const entry = {
        glossary_id: g.glossary_id,
        name: g.name,
        source_lang: g.source_lang,
        target_lang: g.target_lang,
        reason,
        deletedAt: new Date().toISOString(),
      };
      deleted.push(entry);
      glossaryDeletionLog.push(entry);
      console.log(`[DeepL glossary deleted] id=${g.glossary_id} name=${g.name} (${reason})`);
    }
  }
  return deleted;
}

/**
 * Create a temporary DeepL glossary for a supported language pair (cleans up any prior
 * `polyglot-eval-*` glossaries first so Free-tier's 1-glossary limit never blocks a language).
 * Returns `{ glossaryId, glossaryHash }` or `{ glossaryId: null, glossaryHash: null }`.
 */
export async function createDeepLGlossaryForRun(name, targetLocale, entries) {
  const cfg = DEEPL_LANG_MAP[targetLocale];
  if (!cfg?.glossaryTarget || !entries || entries.length === 0) {
    return { glossaryId: null, glossaryHash: null };
  }

  const pairs = await getSupportedGlossaryPairs();
  const supported = pairs.some(
    (p) =>
      String(p.source_lang).toLowerCase() === "en" &&
      String(p.target_lang).toLowerCase() === cfg.glossaryTarget.toLowerCase()
  );
  if (!supported) return { glossaryId: null, glossaryHash: null };

  const dedup = new Map();
  for (const e of entries) {
    const src = String(e.term ?? "").trim();
    const tgt = e.doNotTranslate ? src : String(e.expectedTranslation ?? "").trim();
    if (!src || !tgt) continue;
    if (!dedup.has(src.toLowerCase())) dedup.set(src.toLowerCase(), [src, tgt]);
  }
  if (dedup.size === 0) return { glossaryId: null, glossaryHash: null };

  const tsv = [...dedup.values()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, t]) => `${s}\t${t}`)
    .join("\n");
  const glossaryHash = sha256Buffer(Buffer.from(`${cfg.glossaryTarget}\n${tsv}`, "utf8")).slice(0, 16);

  return {
    glossaryHash,
    async ensureLiveId() {
      // Free up any stale `polyglot-eval-*` glossary slot before creating
      await cleanupPolyglotEvalGlossaries(`before-${name}-${cfg.glossaryTarget}`);
      const { key, baseUrl } = loadDeepLCredentials();
      const res = await fetch(`${baseUrl}/v2/glossaries`, {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `${GLOSSARY_PREFIX}${name}-${cfg.glossaryTarget}`,
          source_lang: "en",
          target_lang: cfg.glossaryTarget,
          entries: tsv,
          entries_format: "tsv",
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.warn(`[DeepL glossary warning] ${targetLocale}: HTTP ${res.status} ${errText.slice(0, 140)}`);
        return null;
      }
      const data = await res.json();
      return data.glossary_id ?? null;
    },
  };
}

function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Recursively split nested ICU plural/select/selectordinal blocks (FIX for Change #4:
 * previously only split top-level blocks, leaking nested `{count, plural, ...}` to DeepL!).
 */
export function splitIcuRecursive(text) {
  const out = [];
  let i = 0;
  let plainStart = 0;

  while (i < text.length) {
    if (text[i] === "{") {
      const headMatch = /^\{\s*([a-zA-Z0-9_]+)\s*,\s*(plural|select|selectordinal)\s*,/.exec(
        text.slice(i)
      );
      if (headMatch) {
        if (i > plainStart) out.push({ type: "plain", text: text.slice(plainStart, i) });
        let depth = 0;
        let end = i;
        for (; end < text.length; end++) {
          if (text[end] === "{") depth++;
          else if (text[end] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth === 0) {
          const block = text.slice(i, end + 1);
          const headerLen = headMatch[0].length;
          const body = block.slice(headerLen, -1);
          const branches = [];
          let b = 0;
          while (b < body.length) {
            while (b < body.length && /\s/.test(body[b])) b++;
            if (b >= body.length) break;
            const selStart = b;
            while (b < body.length && body[b] !== "{" && !/\s/.test(body[b])) b++;
            const selector = body.slice(selStart, b).trim();
            while (b < body.length && /\s/.test(body[b])) b++;
            if (body[b] !== "{") break;
            let bd = 0;
            const valStart = b + 1;
            for (; b < body.length; b++) {
              if (body[b] === "{") bd++;
              else if (body[b] === "}") {
                bd--;
                if (bd === 0) break;
              }
            }
            const val = body.slice(valStart, b);
            // RECURSE into branch value so nested plural/select blocks are protected!
            branches.push({ selector, children: splitIcuRecursive(val) });
            b++;
          }
          if (branches.length > 0) {
            out.push({ type: "icu_choice", header: headMatch[0], branches });
            i = end + 1;
            plainStart = i;
            continue;
          }
        }
      }
    }
    i++;
  }
  if (plainStart < text.length) out.push({ type: "plain", text: text.slice(plainStart) });
  return out;
}

/**
 * Protect placeholders (`<ph id="N"/>` with ignore_tags=["ph"]) AND paired rich-text tags
 * (`<rt0>...</rt0>` so DeepL understands open/close XML pairing rather than splitting tags).
 */
export function protectPlaceholdersXml(text) {
  const tokens = [];
  const pairedTags = [];

  // Step 1: Identify balanced paired rich-text tags like <b>...</b>, <link>...</link>, <codeTag>...</codeTag>
  const pairedRe = /<([a-zA-Z][a-zA-Z0-9_-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g;
  const withPairedMarkers = text.replace(pairedRe, (_full, tagName, attrs = "", inner) => {
    const idx = pairedTags.length;
    pairedTags.push({ open: `<${tagName}${attrs ?? ""}>`, close: `</${tagName}>` });
    return `\uE001RT_OPEN_${idx}\uE002${inner}\uE001RT_CLOSE_${idx}\uE002`;
  });

  // Step 2: Protect placeholders, printf, Rails %{x}, remaining single HTML tags, and '#'
  const tokenRe =
    /(\{\{[^}]+\}\}|%\{[^}]+\}|%<[^>]+>[.0-9]*[a-zA-Z]|%\([^)]+\)[#0\- +]*(?:\d+)?(?:\.\d+)?[diouxXeEfFgGcrsa]|(?<!%)%(?:[#0\-+]*(?:\d+)?(?:\.\d+)?[diouxXeEfFgGcrsa])|\{[a-zA-Z0-9_.-]+(?:,\s*(?:number|date|time)[^}]*)?\}|<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s+[^>]*)?\/?>|#|\uE001RT_(?:OPEN|CLOSE)_\d+\uE002)/g;

  let xml = "";
  let last = 0;
  for (const m of withPairedMarkers.matchAll(tokenRe)) {
    const idx = m.index ?? 0;
    if (idx > last) xml += xmlEscape(withPairedMarkers.slice(last, idx));
    const tok = m[0];
    const openM = /^\uE001RT_OPEN_(\d+)\uE002$/.exec(tok);
    const closeM = /^\uE001RT_CLOSE_(\d+)\uE002$/.exec(tok);
    if (openM) {
      xml += `<rt${openM[1]}>`;
    } else if (closeM) {
      xml += `</rt${closeM[1]}>`;
    } else {
      const id = tokens.length;
      tokens.push(tok);
      xml += `<ph id="${id}"/>`;
    }
    last = idx + tok.length;
  }
  if (last < withPairedMarkers.length) xml += xmlEscape(withPairedMarkers.slice(last));
  return { xml, tokens, pairedTags };
}

export function restorePlaceholdersXml(translatedXml, tokens, pairedTags = []) {
  let out = translatedXml.replace(/<ph\s+id=["'](\d+)["']\s*\/?>/g, (_full, idStr) => {
    const idx = Number(idStr);
    return tokens[idx] ?? "";
  });
  out = out.replace(/<rt(\d+)>/g, (_full, idStr) => pairedTags[Number(idStr)]?.open ?? "");
  out = out.replace(/<\/rt(\d+)>/g, (_full, idStr) => pairedTags[Number(idStr)]?.close ?? "");
  return xmlUnescape(out);
}

/**
 * Translate a list of XML-protected jobs (each optionally having a `context` string for System B+ctx).
 * Groups jobs by identical `context` so DeepL batch requests remain fast while passing exact context!
 */
async function translateXmlJobs(stageName, targetLocale, jobs, { glossaryHandle = null, useContext = false } = {}) {
  const cfg = DEEPL_LANG_MAP[targetLocale];
  if (!cfg) throw new Error(`Unsupported DeepL targetLocale: ${targetLocale}`);

  const glossaryKey = glossaryHandle?.glossaryHash ?? null;
  const results = new Array(jobs.length);
  const uncached = [];

  for (let i = 0; i < jobs.length; i++) {
    const ctx = useContext ? (jobs[i].context ?? null) : null;
    const keyPayload = {
      op: "translate-text-v2",
      targetLang: cfg.targetLang,
      formality: cfg.formality,
      glossaryKey,
      context: ctx,
      xml: jobs[i].xml,
    };
    const c = getCached("deepl-text", keyPayload);
    if (c.hit) {
      results[i] = c.value;
      recordCost({
        stage: stageName,
        provider: "deepl",
        model: `deepl-${cfg.targetLang}${useContext ? "+ctx" : ""}`,
        label: `cache-hit-${targetLocale}`,
        cacheHit: true,
        chars: jobs[i].xml.length,
      });
    } else {
      uncached.push({ idx: i, keyPayload, xml: jobs[i].xml, context: ctx });
    }
  }

  if (uncached.length === 0) {
    return { texts: results, liveChars: 0, cacheHits: jobs.length, usedGlossary: Boolean(glossaryKey) };
  }

  // Only create the live DeepL glossary if we actually have uncached items to send!
  let liveGlossaryId = null;
  if (glossaryHandle?.ensureLiveId) {
    liveGlossaryId = await glossaryHandle.ensureLiveId();
  }

  const { key, baseUrl } = loadDeepLCredentials();
  let liveChars = 0;

  try {
    // Group uncached jobs by identical context string (so B batches up to 40, and B+ctx batches by component/context)
    const groups = new Map();
    for (const item of uncached) {
      const gKey = item.context ?? "";
      if (!groups.has(gKey)) groups.set(gKey, []);
      groups.get(gKey).push(item);
    }

    for (const [ctxStr, groupItems] of groups) {
      for (let start = 0; start < groupItems.length; start += 40) {
        const chunk = groupItems.slice(start, start + 40);
        const t0 = Date.now();
        const body = {
          text: chunk.map((c) => c.xml),
          source_lang: "EN",
          target_lang: cfg.targetLang,
          tag_handling: "xml",
          ignore_tags: ["ph"],
        };
        if (cfg.formality) body.formality = cfg.formality;
        if (liveGlossaryId) body.glossary_id = liveGlossaryId;
        if (ctxStr) body.context = ctxStr.slice(0, 320);

        const res = await fetch(`${baseUrl}/v2/translate`, {
          method: "POST",
          headers: {
            Authorization: `DeepL-Auth-Key ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(
            `DeepL /v2/translate failed (${targetLocale}): HTTP ${res.status} ${errText.slice(0, 200)}`
          );
        }

        const data = await res.json();
        const wallMs = Date.now() - t0;
        const translations = data.translations ?? [];
        if (translations.length !== chunk.length) {
          throw new Error(`DeepL returned ${translations.length} items, expected ${chunk.length}`);
        }

        let chunkChars = 0;
        for (let j = 0; j < chunk.length; j++) {
          const item = chunk[j];
          const outText = translations[j].text;
          const billed = Number(translations[j].billed_characters ?? item.xml.length);
          chunkChars += billed;
          setCached("deepl-text", item.keyPayload, outText);
          results[item.idx] = outText;
        }
        liveChars += chunkChars;
        recordCost({
          stage: stageName,
          provider: "deepl",
          model: `deepl-${cfg.targetLang}${useContext ? "+ctx" : ""}`,
          label: `${targetLocale}${useContext ? "+ctx" : ""} (${chunk.length} strings)`,
          cacheHit: false,
          chars: chunkChars,
          wallMs,
        });
      }
    }
  } finally {
    // Release our temporary `polyglot-eval-*` glossary immediately after use (Change #10)
    if (liveGlossaryId) {
      await cleanupPolyglotEvalGlossaries(`after-${stageName}-${targetLocale}`);
    }
  }

  return {
    texts: results,
    liveChars,
    cacheHits: jobs.length - uncached.length,
    usedGlossary: Boolean(liveGlossaryId),
  };
}

/**
 * Translate a flat key->string catalog with System B (or System B+ctx when `contextByKey` is provided).
 */
export async function translateCatalogWithDeepL({
  stageName,
  targetLocale,
  sourceMap,
  glossaryName = null,
  glossaryEntries = [],
  contextByKey = null,
  stageCharCap = DEEPL_STAGE_CHAR_CAP,
}) {
  const beforeUsage = await getDeepLUsage();
  const keys = Object.keys(sourceMap);
  const useContext = Boolean(contextByKey);

  const jobs = [];
  const collectPlan = (nodes, ctxStr) =>
    nodes.map((n) => {
      if (n.type === "plain") {
        if (!n.text.trim()) return { type: "literal", text: n.text };
        const { xml, tokens, pairedTags } = protectPlaceholdersXml(n.text);
        const jobIdx = jobs.length;
        jobs.push({ xml, tokens, pairedTags, context: ctxStr });
        return { type: "plain", jobIdx };
      }
      return {
        type: "icu_choice",
        header: n.header,
        branches: n.branches.map((br) => ({
          selector: br.selector,
          children: collectPlan(br.children, ctxStr),
        })),
      };
    });

  const rebuildFromPlan = (planNodes, translatedTexts) =>
    planNodes
      .map((p) => {
        if (p.type === "literal") return p.text;
        if (p.type === "plain") {
          const j = jobs[p.jobIdx];
          return restorePlaceholdersXml(translatedTexts[p.jobIdx], j.tokens, j.pairedTags);
        }
        const inner = p.branches
          .map((br) => `${br.selector} {${rebuildFromPlan(br.children, translatedTexts)}}`)
          .join(" ");
        return `${p.header} ${inner}}`;
      })
      .join("");

  const keyPlans = keys.map((k) => {
    const src = String(sourceMap[k] ?? "");
    const ctxStr = useContext ? (contextByKey[k] ?? null) : null;
    const ast = splitIcuRecursive(src);
    return { key: k, planNodes: collectPlan(ast, ctxStr) };
  });

  const totalEstimatedChars = jobs.reduce((sum, j) => sum + j.xml.length, 0);
  const glossaryHandle =
    glossaryName && glossaryEntries.length > 0
      ? await createDeepLGlossaryForRun(glossaryName, targetLocale, glossaryEntries)
      : { glossaryId: null, glossaryHash: null };

  const cfg = DEEPL_LANG_MAP[targetLocale];
  let uncachedEstimatedChars = 0;
  for (const j of jobs) {
    const hit = getCached("deepl-text", {
      op: "translate-text-v2",
      targetLang: cfg.targetLang,
      formality: cfg.formality,
      glossaryKey: glossaryHandle.glossaryHash ?? null,
      context: useContext ? (j.context ?? null) : null,
      xml: j.xml,
    }).hit;
    if (!hit) uncachedEstimatedChars += j.xml.length;
  }
  assertDeepLStageCap(stageName, beforeUsage, uncachedEstimatedChars, stageCharCap);

  const t0 = Date.now();
  const batchRes = await translateXmlJobs(stageName, targetLocale, jobs, {
    glossaryHandle,
    useContext,
  });
  const wallMs = Date.now() - t0;

  const targetMap = {};
  for (const kp of keyPlans) {
    targetMap[kp.key] = rebuildFromPlan(kp.planNodes, batchRes.texts);
  }

  const afterUsage = await getDeepLUsage();
  return {
    targetLocale,
    deeplTargetLang: cfg.targetLang,
    formality: cfg.formality,
    usedGlossary: batchRes.usedGlossary,
    glossaryKey: glossaryHandle.glossaryHash ?? null,
    useContext,
    translations: targetMap,
    liveChars: batchRes.liveChars,
    totalEstimatedChars,
    cacheHits: batchRes.cacheHits,
    wallMs,
    usageBefore: beforeUsage,
    usageAfter: afterUsage,
  };
}

/**
 * Translate a DOCX file via DeepL Document API (/v2/document), cached by content hash.
 */
export async function translateDocxWithDeepL({
  stageName,
  sourceDocxPath,
  outputDocxPath,
  targetLocale,
  glossaryName = null,
  glossaryEntries = [],
  stageCharCap = DEEPL_STAGE_CHAR_CAP,
}) {
  const cfg = DEEPL_LANG_MAP[targetLocale];
  if (!cfg) throw new Error(`Unsupported DeepL targetLocale: ${targetLocale}`);

  const glossaryHandle =
    glossaryName && glossaryEntries.length > 0
      ? await createDeepLGlossaryForRun(glossaryName, targetLocale, glossaryEntries)
      : { glossaryId: null, glossaryHash: null };

  const docBytes = fs.readFileSync(sourceDocxPath);
  const docHash = sha256Buffer(docBytes);
  const cacheKey = {
    op: "translate-document",
    docHash,
    targetLang: cfg.targetLang,
    formality: cfg.formality,
    glossaryId: glossaryHandle.glossaryHash ?? null,
  };

  const cached = getCached("deepl-docx", cacheKey);
  if (cached.hit && cached.value?.base64) {
    fs.mkdirSync(path.dirname(outputDocxPath), { recursive: true });
    fs.writeFileSync(outputDocxPath, Buffer.from(cached.value.base64, "base64"));
    recordCost({
      stage: stageName,
      provider: "deepl",
      model: `deepl-doc-${cfg.targetLang}`,
      label: `docx cache-hit ${path.basename(sourceDocxPath)} (${targetLocale})`,
      cacheHit: true,
      chars: cached.value.billedCharacters ?? 0,
    });
    return {
      cacheHit: true,
      outputDocxPath,
      billedCharacters: cached.value.billedCharacters ?? 0,
      usedGlossary: Boolean(glossaryHandle.glossaryHash),
      wallMs: 0,
    };
  }

  const beforeUsage = await getDeepLUsage();
  assertDeepLStageCap(stageName, beforeUsage, 50_000, stageCharCap);

  let liveGlossaryId = null;
  if (glossaryHandle?.ensureLiveId) {
    liveGlossaryId = await glossaryHandle.ensureLiveId();
  }

  const { key, baseUrl } = loadDeepLCredentials();
  const t0 = Date.now();
  let billedCharacters = 0;
  let outBuf;

  try {
    const form = new FormData();
    form.append("file", new Blob([docBytes]), path.basename(sourceDocxPath));
    form.append("source_lang", "EN");
    form.append("target_lang", cfg.targetLang);
    if (cfg.formality) form.append("formality", cfg.formality);
    if (liveGlossaryId) form.append("glossary_id", liveGlossaryId);

    const upRes = await fetch(`${baseUrl}/v2/document`, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${key}` },
      body: form,
    });
    if (!upRes.ok) {
      const errText = await upRes.text().catch(() => "");
      throw new Error(`DeepL /v2/document upload failed: HTTP ${upRes.status} ${errText.slice(0, 200)}`);
    }
    const { document_id, document_key } = await upRes.json();

    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const stRes = await fetch(`${baseUrl}/v2/document/${document_id}`, {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ document_key }),
      });
      if (!stRes.ok) {
        throw new Error(`DeepL /v2/document status poll failed: HTTP ${stRes.status}`);
      }
      const st = await stRes.json();
      if (st.status === "error") {
        throw new Error(`DeepL document translation error: ${st.error_message ?? "unknown"}`);
      }
      if (st.status === "done") {
        billedCharacters = Number(st.billed_characters ?? 0);
        break;
      }
    }

    const dlRes = await fetch(`${baseUrl}/v2/document/${document_id}/result`, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ document_key }),
    });
    if (!dlRes.ok) {
      throw new Error(`DeepL /v2/document result download failed: HTTP ${dlRes.status}`);
    }
    outBuf = Buffer.from(await dlRes.arrayBuffer());
  } finally {
    if (liveGlossaryId) {
      await cleanupPolyglotEvalGlossaries(`after-docx-${targetLocale}`);
    }
  }

  const wallMs = Date.now() - t0;
  fs.mkdirSync(path.dirname(outputDocxPath), { recursive: true });
  fs.writeFileSync(outputDocxPath, outBuf);

  setCached("deepl-docx", cacheKey, {
    base64: outBuf.toString("base64"),
    billedCharacters,
  });

  const afterUsage = await getDeepLUsage();
  const actualDelta = Math.max(billedCharacters, afterUsage.character_count - beforeUsage.character_count);
  recordCost({
    stage: stageName,
    provider: "deepl",
    model: `deepl-doc-${cfg.targetLang}`,
    label: `docx ${path.basename(sourceDocxPath)} (${targetLocale})`,
    cacheHit: false,
    chars: actualDelta,
    wallMs,
  });

  return {
    cacheHit: false,
    outputDocxPath,
    billedCharacters,
    actualDeltaChars: actualDelta,
    usedGlossary: Boolean(liveGlossaryId),
    wallMs,
    usageBefore: beforeUsage,
    usageAfter: afterUsage,
  };
}
