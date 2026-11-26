import fs from "node:fs";
import path from "node:path";
import { applyTranslations } from "./apply.js";
import { runCheck } from "./check.js";
import { prepareBatch, PreparedItem } from "./prepare.js";
import { markHumanVerified, qeIndex, QeStatus, qeStatusOf } from "./qe.js";
import { isBindingCharLimit, latestAnswerAt, listQuestions, Question } from "./context.js";
import { atomicWriteFileSync, resolveConfinedPath } from "./security.js";
import { WraithStore } from "./store.js";
import { findTmMatches, readTm, TmEntry, upsertTmEntries } from "./tm.js";
import { runVisualQa } from "./visual-qa.js";

/* ------------------------------------------------------------------------------------------------
 * Lossless TMS externalization: XLIFF 2.0 (+ mda metadata & notes) or XLIFF 1.2 (notes + maxwidth,
 * the dialect Crowdin documents), TMX 1.4b, TBX-Basic.
 * Fully deterministic — 0 LLM tokens.
 * ---------------------------------------------------------------------------------------------- */

export interface TmsExportOptions {
  rootDir: string;
  /** xliff2 (default; mda metadata) or xliff12 (what Crowdin documents: <note> context, maxwidth limits). */
  format?: "xliff2" | "xliff12";
  outDir?: string;
  locales?: string[];
  onlyFlagged?: boolean;
  includeTm?: boolean;
  includeGlossary?: boolean;
  bundleScreenshots?: boolean;
}

export interface TmsExportResult {
  format: "xliff2" | "xliff12";
  outDir: string;
  files: string[];
  unitsByLocale: Record<string, number>;
  skippedPluralObjectKeys: number;
  tmEntries?: number;
  glossaryEntries?: number;
  screenshots?: number;
}

export interface TmsImportOptions {
  rootDir: string;
  /** XLIFF file or a directory containing .xliff/.xlf files (workspace-relative or absolute inside workspace) */
  input: string;
  runVerification?: boolean;
}

export interface TmsImportResult {
  ok: boolean;
  files: string[];
  locales: string[];
  unitsParsed: number;
  applied: number;
  unchanged: number;
  /** Units imported or left unchanged without a reviewed/approved state: not recorded as human-verified. */
  notReviewed: number;
  rejected: Array<{ key: string; locale: string; code: string; message: string }>;
  tmUpserted: number;
  qeHumanVerified: number;
  diff: Array<{ key: string; locale: string; before: string | null; after: string; state: string }>;
  check?: { outcome: string; errorCount: number; warningCount: number };
  visualQa?: { outcome: string; defectCount: number; inconclusiveReason?: string };
}

/* ------------------------------- XML helpers ------------------------------------------------- */

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

const ICU_COMPLEX_RE = /\{\s*[\w.]+\s*,\s*(?:plural|select|selectordinal)\s*,/;
const INLINE_TOKEN_RE =
  /\{\{\s*[\w.-]+\s*\}\}|\{[\w.-]+(?:\s*,\s*(?:number|date|time)(?:\s*,\s*[\w-]+)?)?\}|%\{[\w.-]+\}|%\([\w.-]+\)[sdif]|%(?:\d+\$)?[sdif@]|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<\/?\d+\/?>/g;

/**
 * Encode a message as XLIFF 2.0 inline content. Simple placeholders and inline markup become
 * `<ph id disp/>` (ids shared by source & target through `idMap`). ICU plural/select messages are
 * kept as escaped literal text so every branch round-trips byte-for-byte.
 */
export function toXliffInline(text: string, idMap: Map<string, string>): string {
  if (ICU_COMPLEX_RE.test(text)) return escapeXml(text);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE_TOKEN_RE)) {
    const idx = m.index ?? 0;
    out += escapeXml(text.slice(last, idx));
    let id = idMap.get(m[0]);
    if (!id) {
      id = `ph${idMap.size + 1}`;
      idMap.set(m[0], id);
    }
    out += `<ph id="${id}" disp="${escapeXml(m[0])}"/>`;
    last = idx + m[0].length;
  }
  out += escapeXml(text.slice(last));
  return out;
}

/** Decode XLIFF inline content back to the original message string. */
export function fromXliffInline(xml: string): string {
  const withPh = xml.replace(/<ph\b([^>]*?)\/>/g, (_m, attrs: string) => {
    const disp = /\bdisp="([^"]*)"/.exec(attrs);
    return disp ? `\u0000PH${Buffer.from(unescapeXml(disp[1]), "utf8").toString("base64")}\u0000` : "";
  });
  // Drop any other markup a TMS may have added (e.g. <mrk>), keep its text
  const stripped = withPh.replace(/<\/?(?:mrk|pc|sm|em)\b[^>]*>/g, "");
  return unescapeXml(stripped).replace(/\u0000PH([A-Za-z0-9+/=]*)\u0000/g, (_m, b64: string) =>
    Buffer.from(b64, "base64").toString("utf8")
  );
}

/** XLIFF 1.2 inline: placeholders and tags become <ph id="n">original</ph> so a TMS keeps them intact. */
export function toXliff12Inline(text: string): string {
  if (ICU_COMPLEX_RE.test(text)) return escapeXml(text);
  let out = "";
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE_TOKEN_RE)) {
    const idx = m.index ?? 0;
    out += escapeXml(text.slice(last, idx));
    out += `<ph id="${++n}">${escapeXml(m[0])}</ph>`;
    last = idx + m[0].length;
  }
  return out + escapeXml(text.slice(last));
}

export function fromXliff12Inline(xml: string): string {
  const withPh = xml.replace(/<(ph|bpt|ept|it)\b[^>]*>([\s\S]*?)<\/\1>/g, (_m, _t: string, inner: string) =>
    `\u0000PH${Buffer.from(unescapeXml(inner), "utf8").toString("base64")}\u0000`
  );
  const stripped = withPh.replace(/<\/?(?:mrk|g|x|bx|ex)\b[^>]*>/g, "");
  return unescapeXml(stripped).replace(/\u0000PH([A-Za-z0-9+/=]*)\u0000/g, (_m, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

type ExportUnit = {
  key: string;
  source: string;
  target?: string;
  state: "initial" | "translated" | "reviewed";
  flagged?: boolean;
  maxChars?: number;
  meta: Record<string, string | number | undefined>;
  notes: Array<{ category: string; text: string }>;
};

const NOTE_LABEL: Record<string, string> = {
  context: "Meaning",
  location: "Where",
  limit: "Length",
  answer: "Clarified",
  qe: "Review",
  tm: "Translation memory",
  layout: "Layout",
  screenshot: "Screenshot",
};

/** XLIFF 1.2 with one <note> per fact (Crowdin shows notes as string context) and maxwidth in characters. */
export function buildXliff12(input: { srcLang: string; trgLang?: string; original: string; units: ExportUnit[] }): string {
  const L: string[] = [];
  L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  L.push(`<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">`);
  L.push(
    `  <file original="${escapeXml(input.original)}" source-language="${escapeXml(input.srcLang)}"${input.trgLang ? ` target-language="${escapeXml(input.trgLang)}"` : ""} datatype="plaintext">`
  );
  L.push(`    <body>`);
  for (const u of input.units) {
    const limit = u.maxChars ? ` maxwidth="${u.maxChars}" size-unit="char"` : "";
    L.push(`      <trans-unit id="${escapeXml(u.key)}" resname="${escapeXml(u.key)}"${limit}>`);
    L.push(`        <source xml:space="preserve">${toXliff12Inline(u.source)}</source>`);
    if (input.trgLang && u.target !== undefined) {
      const state = u.state === "reviewed" ? "final" : u.flagged ? "needs-review-translation" : "translated";
      L.push(`        <target xml:space="preserve" state="${state}">${toXliff12Inline(u.target)}</target>`);
    }
    for (const n of u.notes) L.push(`        <note>${escapeXml(`${NOTE_LABEL[n.category] ?? n.category}: ${n.text}`)}</note>`);
    L.push(`      </trans-unit>`);
  }
  L.push(`    </body>`);
  L.push(`  </file>`);
  L.push(`</xliff>`);
  return L.join("\n") + "\n";
}

export function parseXliff12(xml: string): { srcLang?: string; trgLang?: string; units: ParsedXliffUnit[] } {
  const file = /<file\b([^>]*)>/i.exec(xml);
  const attr = (name: string) => (file ? new RegExp(`\\b${name}="([^"]*)"`).exec(file[1])?.[1] : undefined);
  const units: ParsedXliffUnit[] = [];
  for (const m of xml.matchAll(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/g)) {
    const id = /\bresname="([^"]*)"/.exec(m[1])?.[1] ?? /\bid="([^"]*)"/.exec(m[1])?.[1];
    if (id === undefined) continue;
    const s = /<source\b[^>]*>([\s\S]*?)<\/source>/.exec(m[2]);
    const t = /<target\b([^>]*)>([\s\S]*?)<\/target>/.exec(m[2]);
    const approved = /\bapproved="yes"/.test(m[1]);
    const st = t ? /\bstate="([^"]*)"/.exec(t[1])?.[1] : undefined;
    units.push({
      key: unescapeXml(id),
      source: s ? fromXliff12Inline(s[1]) : "",
      target: t ? fromXliff12Inline(t[2]) : undefined,
      state: approved || st === "final" ? "reviewed" : st ?? (t ? "translated" : "initial"),
    });
  }
  return { srcLang: attr("source-language"), trgLang: attr("target-language"), units };
}

export function parseXliffAny(xml: string): { srcLang?: string; trgLang?: string; units: ParsedXliffUnit[] } {
  return /<trans-unit\b/.test(xml) ? parseXliff12(xml) : parseXliff2(xml);
}

/* ------------------------------- data collection --------------------------------------------- */

function collectItems(rootDir: string, locale: string): PreparedItem[] {
  const items: PreparedItem[] = [];
  let offset = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const res = prepareBatch({ rootDir, targetLocale: locale, includeTranslated: true, offset, limit: 100 });
    items.push(...res.items);
    if (!res.hasMore || res.items.length === 0) break;
    offset += res.items.length;
  }
  return items;
}

interface ScreenshotRef {
  key: string;
  locale: string;
  screenshot: string;
  type?: string;
}

function readVisualManifest(rootDir: string): ScreenshotRef[] {
  try {
    const p = resolveConfinedPath(rootDir, ".wraith/artifacts/visual-qa/manifest.json", { label: "visual-qa manifest" });
    if (!fs.existsSync(p)) return [];
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { defects?: Array<Record<string, unknown>> };
    return (parsed.defects ?? [])
      .filter((d) => typeof d.key === "string" && typeof d.locale === "string" && typeof d.screenshot === "string")
      .map((d) => ({ key: d.key as string, locale: d.locale as string, screenshot: d.screenshot as string, type: d.type as string | undefined }));
  } catch {
    return [];
  }
}

function xliffState(status: QeStatus, target: string | undefined): "initial" | "translated" | "reviewed" {
  if (status === "human-verified") return "reviewed";
  if (target) return "translated";
  return "initial";
}

/* ------------------------------- export ------------------------------------------------------ */

function declaredMaxChars(item: PreparedItem): number | undefined {
  return item.charLimit?.kind === "declared" ? item.charLimit.maxChars : undefined;
}

function bindingMaxChars(item: PreparedItem): number | undefined {
  return item.charLimit && isBindingCharLimit(item.charLimit) ? item.charLimit.maxChars : undefined;
}

function locationNote(item: PreparedItem): { category: string; text: string } | undefined {
  const site = item.usageSites[0];
  if (!site) return undefined;
  const where = [site.component, site.element ? `<${site.element}>` : undefined].filter(Boolean).join(" ");
  return { category: "location", text: `${site.file}:${site.line}${where ? ` (${where})` : ""}` };
}

/** A source.xlf unit: no target, and only context that holds for every target locale. */
function sourceUnitFor(item: PreparedItem, questions: Question[]): ExportUnit {
  const notes: Array<{ category: string; text: string }> = [];
  if (item.contextNote && item.contextNoteStatus === "current") notes.push({ category: "context", text: item.contextNote });
  const loc = locationNote(item);
  if (loc) notes.push(loc);
  const maxChars = declaredMaxChars(item);
  if (maxChars) notes.push({ category: "limit", text: `max ${maxChars} characters (required)` });
  for (const q of questions) {
    if (!q.locale && q.answer && q.keys.includes(item.key)) notes.push({ category: "answer", text: `${q.question} → ${q.answer}` });
  }
  return { key: item.key, source: item.source, state: "initial", maxChars, meta: {}, notes };
}

export function buildXliff2(input: {
  srcLang: string;
  trgLang: string;
  fileId: string;
  units: Array<{
    key: string;
    source: string;
    target?: string;
    state: "initial" | "translated" | "reviewed";
    meta: Record<string, string | number | undefined>;
    notes: Array<{ category: string; text: string }>;
  }>;
}): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" xmlns:mda="urn:oasis:names:tc:xliff:metadata:2.0" version="2.0" srcLang="${escapeXml(input.srcLang)}" trgLang="${escapeXml(input.trgLang)}">`
  );
  lines.push(`  <file id="${escapeXml(input.fileId)}">`);
  for (const u of input.units) {
    const idMap = new Map<string, string>();
    const src = toXliffInline(u.source, idMap);
    const tgt = u.target !== undefined ? toXliffInline(u.target, idMap) : undefined;
    lines.push(`    <unit id="${escapeXml(u.key)}">`);
    const metaEntries = Object.entries(u.meta).filter(([, v]) => v !== undefined && v !== "");
    if (metaEntries.length > 0) {
      lines.push(`      <mda:metadata>`);
      lines.push(`        <mda:metaGroup category="wraith">`);
      for (const [k, v] of metaEntries) {
        lines.push(`          <mda:meta type="${escapeXml(k)}">${escapeXml(String(v))}</mda:meta>`);
      }
      lines.push(`        </mda:metaGroup>`);
      lines.push(`      </mda:metadata>`);
    }
    if (u.notes.length > 0) {
      lines.push(`      <notes>`);
      for (const n of u.notes) {
        lines.push(`        <note category="${escapeXml(n.category)}">${escapeXml(n.text)}</note>`);
      }
      lines.push(`      </notes>`);
    }
    lines.push(`      <segment state="${u.state}">`);
    lines.push(`        <source xml:space="preserve">${src}</source>`);
    if (tgt !== undefined) lines.push(`        <target xml:space="preserve">${tgt}</target>`);
    lines.push(`      </segment>`);
    lines.push(`    </unit>`);
  }
  lines.push(`  </file>`);
  lines.push(`</xliff>`);
  return lines.join("\n") + "\n";
}

export function buildTmx14b(srcLang: string, entries: Array<Pick<TmEntry, "source" | "target" | "targetLocale" | "provenance" | "key" | "verifiedAt" | "updatedAt">>): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<!DOCTYPE tmx SYSTEM "tmx14.dtd">`);
  lines.push(`<tmx version="1.4">`);
  lines.push(
    `  <header creationtool="wraith" creationtoolversion="0.1.0" segtype="sentence" o-tmf="wraith-tm-json" adminlang="en" srclang="${escapeXml(srcLang)}" datatype="plaintext"/>`
  );
  lines.push(`  <body>`);
  entries.forEach((e, i) => {
    lines.push(`    <tu tuid="${i + 1}">`);
    lines.push(`      <prop type="x-provenance">${escapeXml(e.provenance)}</prop>`);
    if (e.key) lines.push(`      <prop type="x-key">${escapeXml(e.key)}</prop>`);
    if (e.verifiedAt) lines.push(`      <prop type="x-verifiedAt">${escapeXml(e.verifiedAt)}</prop>`);
    lines.push(`      <tuv xml:lang="${escapeXml(srcLang)}"><seg>${escapeXml(e.source)}</seg></tuv>`);
    lines.push(`      <tuv xml:lang="${escapeXml(e.targetLocale)}"><seg>${escapeXml(e.target)}</seg></tuv>`);
    lines.push(`    </tu>`);
  });
  lines.push(`  </body>`);
  lines.push(`</tmx>`);
  return lines.join("\n") + "\n";
}

export function buildTbxBasic(
  srcLang: string,
  entries: Array<{ term: string; translations: Record<string, string>; doNotTranslate: boolean; notes?: string; abbreviations?: Record<string, string> }>
): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<martif type="TBX-Basic" xml:lang="${escapeXml(srcLang)}">`);
  lines.push(`  <martifHeader>`);
  lines.push(`    <fileDesc><sourceDesc><p>Wraith glossary export</p></sourceDesc></fileDesc>`);
  lines.push(`    <encodingDesc><p type="XCSURI">TBXBasicXCSV02.xcs</p></encodingDesc>`);
  lines.push(`  </martifHeader>`);
  lines.push(`  <text>`);
  lines.push(`    <body>`);
  entries.forEach((e, i) => {
    lines.push(`      <termEntry id="t${i + 1}">`);
    const note = [e.notes, e.doNotTranslate ? "Do not translate" : undefined].filter(Boolean).join(" — ");
    if (note) lines.push(`        <descrip type="definition">${escapeXml(note)}</descrip>`);
    lines.push(`        <langSet xml:lang="${escapeXml(srcLang)}">`);
    lines.push(`          <tig><term>${escapeXml(e.term)}</term><termNote type="administrativeStatus">${e.doNotTranslate ? "admittedTerm-admn-sts" : "preferredTerm-admn-sts"}</termNote></tig>`);
    lines.push(`        </langSet>`);
    for (const [lang, tr] of Object.entries(e.translations)) {
      lines.push(`        <langSet xml:lang="${escapeXml(lang)}">`);
      lines.push(`          <tig><term>${escapeXml(tr)}</term><termNote type="administrativeStatus">preferredTerm-admn-sts</termNote></tig>`);
      const abbr = e.abbreviations?.[lang];
      if (abbr) {
        lines.push(`          <tig><term>${escapeXml(abbr)}</term><termNote type="termType">abbreviation</termNote></tig>`);
      }
      lines.push(`        </langSet>`);
    }
    lines.push(`      </termEntry>`);
  });
  lines.push(`    </body>`);
  lines.push(`  </text>`);
  lines.push(`</martif>`);
  return lines.join("\n") + "\n";
}

export function runTmsExport(options: TmsExportOptions): TmsExportResult {
  const store = new WraithStore(options.rootDir);
  const config = store.readConfig();
  const layout = store.readLayout();
  const verdicts = qeIndex(options.rootDir);
  const questions = listQuestions(options.rootDir);
  const outRel = options.outDir ?? ".wraith/exports/tms";
  const outAbs = resolveConfinedPath(store.rootDir, outRel, { label: "TMS export directory" });
  fs.mkdirSync(outAbs, { recursive: true });
  const locales = options.locales && options.locales.length > 0 ? options.locales : config.targetLocales;
  const shots = options.bundleScreenshots ? readVisualManifest(store.rootDir) : [];

  const files: string[] = [];
  const unitsByLocale: Record<string, number> = {};
  let skippedPluralObjectKeys = 0;
  const bundled: Array<{ key: string; locale: string; path: string; type?: string }> = [];
  const rel = (abs: string) => path.relative(store.rootDir, abs).replace(/\\/g, "/");
  const format = options.format ?? "xliff2";
  let sourceUnits: ExportUnit[] | undefined;

  for (const locale of locales) {
    const units: ExportUnit[] = [];
    // xliff12: source.xlf is what the TMS treats as the full source set (`crowdin upload sources` removes
    // strings missing from it), so it holds every key, ignores onlyFlagged and carries only facts that
    // don't depend on a target locale.
    const srcUnits: ExportUnit[] | undefined = format === "xliff12" && !sourceUnits ? [] : undefined;
    for (const item of collectItems(store.rootDir, locale)) {
      if (item.sourcePlurals) {
        skippedPluralObjectKeys++;
        continue;
      }
      if (srcUnits) srcUnits.push(sourceUnitFor(item, questions));
      const verdict = verdicts.get(`${locale}\0${item.key}`);
      const qeStatus = qeStatusOf(verdict, item.source, item.currentTarget, latestAnswerAt(questions, item.key, locale));
      if (options.onlyFlagged && qeStatus !== "flagged") continue;
      const site = item.usageSites[0];
      const budget = layout.budgets[item.key]?.[locale];
      const tm = findTmMatches(store.rootDir, item.source, locale, {
          minSimilarity: 0.7,
          limit: 1,
          excludeKey: item.key,
          excludeSelf: item.currentTarget ? { source: item.source, target: item.currentTarget } : undefined,
        })[0];
      const notes: Array<{ category: string; text: string }> = [];
      if (item.contextNote && item.contextNoteStatus === "current") notes.push({ category: "context", text: item.contextNote });
      const loc = locationNote(item);
      if (loc) notes.push(loc);
      if (item.charLimit) {
        notes.push({
          category: "limit",
          text: `max ${item.charLimit.maxChars} characters (${item.charLimit.kind === "declared" ? "required" : item.charLimit.basis === "rendered" ? "estimated from the rendered UI" : "estimated for this kind of element"})`,
        });
      }
      for (const q of item.questions ?? []) {
        if (q.answer) notes.push({ category: "answer", text: `${q.question} → ${q.answer}` });
      }
      if (qeStatus === "flagged" && verdict?.reason) {
        notes.push({ category: "qe", text: `Flagged in review: ${verdict.reason}${verdict.suggestedFix ? ` — suggested: ${verdict.suggestedFix}` : ""}` });
      }
      if (tm) notes.push({ category: "tm", text: `TM ${Math.round(tm.similarity * 100)}% (${tm.provenance}): ${tm.source} → ${tm.target}` });
      if (item.layout?.constraint) notes.push({ category: "layout", text: `Layout constraint: ${item.layout.constraint}` });
      for (const shot of shots.filter((s) => s.key === item.key && s.locale === locale)) {
        const srcAbs = resolveConfinedPath(store.rootDir, shot.screenshot, { label: "visual-qa screenshot" });
        if (!fs.existsSync(srcAbs)) continue;
        const destAbs = path.join(outAbs, "screenshots", locale, path.basename(srcAbs));
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.copyFileSync(srcAbs, destAbs);
        const destRel = path.relative(outAbs, destAbs).replace(/\\/g, "/");
        bundled.push({ key: item.key, locale, path: destRel, type: shot.type });
        notes.push({ category: "screenshot", text: destRel });
      }
      units.push({
        key: item.key,
        source: item.source,
        target: item.currentTarget,
        state: xliffState(qeStatus, item.currentTarget),
        flagged: qeStatus === "flagged",
        // A TMS enforces maxwidth as a hard limit: declared and measured-UI limits go there; heuristic estimates stay in the note
        maxChars: bindingMaxChars(item),
        meta: {
          file: site?.file,
          line: site?.line,
          component: site?.component,
          element: site?.element,
          qe_status: item.currentTarget ? qeStatus : undefined,
          max_chars: item.charLimit?.maxChars ?? budget?.budgetChars ?? item.layout?.budgetChars,
          max_width_px: budget?.maxWidthPx ?? item.layout?.maxWidthPx,
          tm_similarity: tm ? Number(tm.similarity.toFixed(3)) : undefined,
        },
        notes,
      });
    }
    if (format === "xliff12") {
      // One source file for the TMS plus one bilingual file per locale (existing translations to review)
      if (srcUnits) {
        sourceUnits = srcUnits;
        const srcAbs = path.join(outAbs, "source.xlf");
        atomicWriteFileSync(srcAbs, buildXliff12({ srcLang: config.sourceLocale, original: "source.xlf", units: srcUnits }));
        files.push(rel(srcAbs));
      }
      const fileAbs = path.join(outAbs, `${locale}.xlf`);
      atomicWriteFileSync(fileAbs, buildXliff12({ srcLang: config.sourceLocale, trgLang: locale, original: "source.xlf", units }));
      files.push(rel(fileAbs));
    } else {
      const xml = buildXliff2({ srcLang: config.sourceLocale, trgLang: locale, fileId: `wraith-${locale}`, units });
      const fileAbs = path.join(outAbs, `${locale}.xliff`);
      atomicWriteFileSync(fileAbs, xml);
      files.push(rel(fileAbs));
    }
    unitsByLocale[locale] = units.length;
  }

  const result: TmsExportResult = { format, outDir: rel(outAbs) || ".", files, unitsByLocale, skippedPluralObjectKeys };

  if (options.includeTm) {
    const localeBases = new Set(locales.map((l) => l.toLowerCase().split("-")[0]));
    const entries: TmEntry[] = [...readTm(store.rootDir).entries];
    for (const m of store.readMemory()) {
      entries.push({
        source: m.source,
        target: m.target,
        sourceLocale: m.sourceLocale,
        targetLocale: m.targetLocale,
        provenance: /^(human|manual|correction)$/i.test(m.origin) ? "human-reviewed" : /^(tmx:|import)/i.test(m.origin) ? "imported" : "llm-generated",
        updatedAt: m.updatedAt,
      });
    }
    const seen = new Set<string>();
    const filtered = entries.filter((e) => {
      if (!localeBases.has(e.targetLocale.toLowerCase().split("-")[0])) return false;
      const k = `${e.targetLocale}\0${e.source}\0${e.target}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const tmxAbs = path.join(outAbs, "tm.tmx");
    atomicWriteFileSync(tmxAbs, buildTmx14b(config.sourceLocale, filtered));
    files.push(rel(tmxAbs));
    result.tmEntries = filtered.length;
  }

  if (options.includeGlossary) {
    const glossary = store.readGlossary();
    const tbxAbs = path.join(outAbs, "glossary.tbx");
    atomicWriteFileSync(tbxAbs, buildTbxBasic(config.sourceLocale, glossary.entries));
    files.push(rel(tbxAbs));
    result.glossaryEntries = glossary.entries.length;
  }

  if (options.bundleScreenshots) {
    const manAbs = path.join(outAbs, "screenshots", "manifest.json");
    fs.mkdirSync(path.dirname(manAbs), { recursive: true });
    atomicWriteFileSync(manAbs, JSON.stringify({ generatedAt: new Date().toISOString(), screenshots: bundled }, null, 2) + "\n");
    files.push(rel(manAbs));
    result.screenshots = bundled.length;
  }

  return result;
}

/* ------------------------------- import ------------------------------------------------------ */

export interface ParsedXliffUnit {
  key: string;
  source: string;
  target?: string;
  state: string;
}

export function parseXliff2(xml: string): { srcLang?: string; trgLang?: string; units: ParsedXliffUnit[] } {
  const root = /<xliff\b([^>]*)>/i.exec(xml);
  const attr = (name: string) => (root ? new RegExp(`\\b${name}="([^"]*)"`).exec(root[1])?.[1] : undefined);
  const units: ParsedXliffUnit[] = [];
  for (const m of xml.matchAll(/<unit\b([^>]*)>([\s\S]*?)<\/unit>/g)) {
    const id = /\bid="([^"]*)"/.exec(m[1])?.[1];
    if (id === undefined) continue;
    const body = m[2];
    let source = "";
    let target: string | undefined;
    let state = "initial";
    for (const seg of body.matchAll(/<segment\b([^>]*)>([\s\S]*?)<\/segment>/g)) {
      const st = /\bstate="([^"]*)"/.exec(seg[1])?.[1];
      if (st) state = st;
      const s = /<source\b[^>]*>([\s\S]*?)<\/source>/.exec(seg[2]);
      if (s) source += fromXliffInline(s[1]);
      const t = /<target\b[^>]*>([\s\S]*?)<\/target>/.exec(seg[2]);
      if (t) target = (target ?? "") + fromXliffInline(t[1]);
    }
    units.push({ key: unescapeXml(id), source, target, state });
  }
  return { srcLang: attr("srcLang"), trgLang: attr("trgLang"), units };
}

/**
 * Map a TMS's language code onto a configured target locale: exact match, then the file name
 * (e.g. Crowdin writes target-language="de-DE" into de.xlf), then a unique base-language match.
 */
export function resolveImportLocale(trgLang: string | undefined, fileStem: string, targets: string[]): string | undefined {
  const norm = (l: string) => l.toLowerCase().replace(/_/g, "-");
  const exact = (l?: string) => (l ? targets.find((t) => norm(t) === norm(l)) : undefined);
  const hit = exact(trgLang) ?? exact(fileStem);
  if (hit) return hit;
  for (const cand of [trgLang, fileStem]) {
    if (!cand) continue;
    const base = norm(cand).split("-")[0];
    const matches = targets.filter((t) => norm(t).split("-")[0] === base);
    if (matches.length === 1) return matches[0];
  }
  return targets.length === 0 ? trgLang : undefined;
}

export function isXliffPath(p: string): boolean {
  return /\.(xliff|xlf)$/i.test(p);
}

/** Human sign-off states: XLIFF 2.0 `reviewed`/`final`; XLIFF 1.2 `approved="yes"`/`final` (parsed as `reviewed`). */
export function isReviewedState(state: string): boolean {
  return state === "reviewed" || state === "final";
}

function collectXliffFiles(rootDir: string, input: string): string[] {
  const abs = resolveConfinedPath(rootDir, input, { label: "XLIFF input" });
  if (!fs.existsSync(abs)) throw new Error(`XLIFF input not found: ${input}`);
  if (fs.statSync(abs).isDirectory()) {
    return fs
      .readdirSync(abs)
      .filter((f) => isXliffPath(f))
      .sort()
      .map((f) => path.join(abs, f));
  }
  return [abs];
}

export async function runTmsImport(options: TmsImportOptions): Promise<TmsImportResult> {
  const store = new WraithStore(options.rootDir);
  const config = store.readConfig();
  const files = collectXliffFiles(store.rootDir, options.input);
  const now = new Date().toISOString();
  const result: TmsImportResult = {
    ok: true,
    files: files.map((f) => path.relative(store.rootDir, f).replace(/\\/g, "/")),
    locales: [],
    unitsParsed: 0,
    applied: 0,
    unchanged: 0,
    notReviewed: 0,
    rejected: [],
    tmUpserted: 0,
    qeHumanVerified: 0,
    diff: [],
  };
  const verified: Array<{ key: string; locale: string; source: string; target: string }> = [];

  for (const file of files) {
    const parsed = parseXliffAny(fs.readFileSync(file, "utf8"));
    if (!parsed.units.some((u) => u.target !== undefined && u.target !== "")) continue; // source-only file (e.g. source.xlf)
    const locale = resolveImportLocale(parsed.trgLang, path.basename(file).replace(/\.(xliff|xlf)$/i, ""), config.targetLocales);
    if (!locale) {
      result.rejected.push({ key: "*", locale: "?", code: "unknown_target_locale", message: `${path.basename(file)}: target language "${parsed.trgLang ?? "(none)"}" matches no configured target locale` });
      continue;
    }
    if (!result.locales.includes(locale)) result.locales.push(locale);
    result.unitsParsed += parsed.units.length;
    const current = new Map<string, PreparedItem>();
    for (const item of collectItems(store.rootDir, locale)) current.set(item.key, item);

    const updates: Array<{ key: string; value: string; reviewed: boolean }> = [];
    for (const u of parsed.units) {
      if (u.target === undefined || u.target === "") continue;
      const cur = current.get(u.key);
      if (!cur) {
        result.rejected.push({ key: u.key, locale, code: "unknown_key", message: "Key not present in source catalog" });
        continue;
      }
      // Only a reviewed/approved unit is human sign-off. Anything else (including Wraith's own
      // export with state="translated") must not become human-verified or human-reviewed TM.
      const reviewed = isReviewedState(u.state);
      if (cur.currentTarget === u.target) {
        result.unchanged++;
        if (reviewed) verified.push({ key: u.key, locale, source: cur.source, target: u.target });
        else result.notReviewed++;
        continue;
      }
      updates.push({ key: u.key, value: u.target, reviewed });
      result.diff.push({ key: u.key, locale, before: cur.currentTarget ?? null, after: u.target, state: u.state });
    }

    if (updates.length > 0) {
      const applied = applyTranslations({
        rootDir: store.rootDir,
        targetLocale: locale,
        translations: updates.map((u) => ({ key: u.key, value: u.value, notes: u.reviewed ? "TMS import (human-reviewed)" : "TMS import (not yet reviewed)" })),
        origin: "human",
      });
      const rejectedKeys = new Set(applied.errors.map((e) => e.key));
      for (const e of applied.errors) result.rejected.push({ key: e.key, locale, code: e.code, message: e.message });
      for (const u of updates) {
        if (rejectedKeys.has(u.key) || rejectedKeys.has("*")) continue;
        result.applied++;
        if (u.reviewed) verified.push({ key: u.key, locale, source: current.get(u.key)!.source, target: u.value });
        else result.notReviewed++;
      }
      result.diff = result.diff.filter((d) => d.locale !== locale || !rejectedKeys.has(d.key));
    }
  }

  if (verified.length > 0) {
    const tmRes = upsertTmEntries(
      store.rootDir,
      verified.map((v) => ({
        source: v.source,
        target: v.target,
        sourceLocale: config.sourceLocale,
        targetLocale: v.locale,
        key: v.key,
        provenance: "human-reviewed" as const,
        verifiedAt: now,
        updatedAt: now,
      }))
    );
    result.tmUpserted = tmRes.added + tmRes.updated;
    store.appendMemory(
      verified.map((v) => ({
        sourceLocale: config.sourceLocale,
        targetLocale: v.locale,
        source: v.source,
        target: v.target,
        context: `tms-import:${v.key}`,
        origin: "human",
        updatedAt: now,
      }))
    );

    result.qeHumanVerified += markHumanVerified(
      store.rootDir,
      verified.map((v) => ({ locale: v.locale, key: v.key, source: v.source, target: v.target }))
    );
  }

  if (options.runVerification !== false) {
    const chk = runCheck({ rootDir: store.rootDir, skipScan: true, limit: 25 });
    result.check = { outcome: chk.outcome, errorCount: chk.errorCount, warningCount: chk.warningCount };
    if (config.layout?.baseUrl) {
      const vqa = await runVisualQa({ rootDir: store.rootDir, locales: result.locales });
      result.visualQa = { outcome: vqa.outcome, defectCount: vqa.defectCount, inconclusiveReason: vqa.inconclusiveReason };
    }
  }

  result.ok = result.rejected.length === 0;
  result.diff = result.diff.slice(0, 200);
  return result;
}
