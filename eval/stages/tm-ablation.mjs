#!/usr/bin/env node
/**
 * Stage 4: TM Context Ablation Benchmark (cross-file consistency).
 *
 *   node eval/run.mjs run --scopes tm-ablation --dry-run   # dataset + TM seeding + prompts + metric sanity, NO models
 *   node eval/run.mjs run --scopes tm-ablation             # full: 4 arms via Codex (no MCP), cached, metrics
 *   node eval/run.mjs judge-remaining --scopes tm-ablation # dual-judge MQM on full-mode outputs
 *
 * Arms (explicit prompt builders below):
 *   B          source + target locale
 *   Bgl        B + project glossary
 *   Anotm      B+glossary + AST/usage UI context (file, component, element type) + width budgets; tmEnabled:false
 *   Afull      Anotm + top-k (k=3) fuzzy TM matches from isolated .polyglot/tm.json (minSimilarity 0.70)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CORPORA_DIR, EVAL_ROOT, LOCALE_CONVENTIONS_TEXT, RESULTS_DIR } from "../config.mjs";
import { atomicWriteJson } from "../lib/cache.mjs";
import {
  chrF,
  computeTmMetrics,
  fuzzyTmLookup,
  structuralParity,
  ter,
} from "../lib/tm-metrics.mjs";

export const TM_ABLATION_WORK_DIR = path.join(EVAL_ROOT, "work", "tm-ablation");
export const TM_ABLATION_RESULTS_PATH = path.join(RESULTS_DIR, "tm-ablation.json");
const DATASET_PATH = path.join(TM_ABLATION_WORK_DIR, "dataset.json");
const OUTPUTS_DIR = path.join(TM_ABLATION_WORK_DIR, "outputs");

export const TM_LOCALES = ["de", "ja", "ar", "es"];
export const TM_SEED_FRACTION = 0.4;
export const TM_TOP_K = 3;
export const TM_MIN_SIMILARITY = 0.7;
const CHUNK_SIZE = 60;
const CODEX_CONCURRENCY = 4;
const OSS_GROUP_CAP = 40;

export const ARMS = [
  {
    id: "B",
    label: "B (source + locale)",
    context: ["source", "targetLocale"],
    tmEnabled: false,
  },
  {
    id: "Bgl",
    label: "B+glossary",
    context: ["source", "targetLocale", "glossary"],
    tmEnabled: false,
  },
  {
    id: "Anotm",
    label: "A-no-tm (AST UI context + width budgets + glossary; tmEnabled:false)",
    context: ["source", "targetLocale", "glossary", "file", "component", "elementType", "widthBudget", "localeConventions"],
    tmEnabled: false,
  },
  {
    id: "Afull",
    label: `A-full (A-no-tm + top-${TM_TOP_K} fuzzy TM, minSimilarity ${TM_MIN_SIMILARITY.toFixed(2)})`,
    context: ["source", "targetLocale", "glossary", "file", "component", "elementType", "widthBudget", "localeConventions", "tmMatches"],
    tmEnabled: true,
  },
];

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const kk = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, kk, out);
    else if (typeof v === "string") out[kk] = v;
  }
  return out;
}

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);

// ============================================================================
// (a) Synthetic multi-file app slice — gold is AUTHOR-PROVIDED (not human-reviewed by a translator)
// ============================================================================
const SYN_STRINGS = {
  save: { source: "Save", kind: "action", gold: { de: "Speichern", ja: "保存", ar: "حفظ", es: "Guardar" } },
  cancel: { source: "Cancel", kind: "action", gold: { de: "Abbrechen", ja: "キャンセル", ar: "إلغاء", es: "Cancelar" } },
  delete: { source: "Delete", kind: "action", gold: { de: "Löschen", ja: "削除", ar: "حذف", es: "Eliminar" } },
  edit: { source: "Edit", kind: "action", gold: { de: "Bearbeiten", ja: "編集", ar: "تعديل", es: "Editar" } },
  close: { source: "Close", kind: "action", gold: { de: "Schließen", ja: "閉じる", ar: "إغلاق", es: "Cerrar" } },
  submit: { source: "Submit", kind: "action", gold: { de: "Absenden", ja: "送信", ar: "إرسال", es: "Enviar" } },
  required: {
    source: "This field is required.",
    kind: "validation",
    gold: { de: "Dieses Feld ist erforderlich.", ja: "この項目は必須です。", ar: "هذا الحقل مطلوب.", es: "Este campo es obligatorio." },
  },
  minChars: {
    source: "Must be at least {min} characters.",
    kind: "validation",
    gold: {
      de: "Muss mindestens {min} Zeichen lang sein.",
      ja: "{min} 文字以上で入力してください。",
      ar: "يجب ألا يقل عن {min} أحرف.",
      es: "Debe tener al menos {min} caracteres.",
    },
  },
  email: {
    source: "Enter a valid email address.",
    kind: "validation",
    gold: {
      de: "Geben Sie eine gültige E-Mail-Adresse ein.",
      ja: "有効なメールアドレスを入力してください。",
      ar: "أدخل عنوان بريد إلكتروني صالحًا.",
      es: "Introduce una dirección de correo electrónico válida.",
    },
  },
  active: { source: "Active", kind: "status", gold: { de: "Aktiv", ja: "有効", ar: "نشط", es: "Activo" } },
  pending: { source: "Pending", kind: "status", gold: { de: "Ausstehend", ja: "保留中", ar: "قيد الانتظار", es: "Pendiente" } },
  archived: { source: "Archived", kind: "status", gold: { de: "Archiviert", ja: "アーカイブ済み", ar: "مؤرشف", es: "Archivado" } },
  failed: { source: "Failed", kind: "status", gold: { de: "Fehlgeschlagen", ja: "失敗", ar: "فشل", es: "Fallido" } },
  items: {
    source: "{count, plural, one {# item} other {# items}}",
    kind: "icu",
    gold: {
      de: "{count, plural, one {# Element} other {# Elemente}}",
      ja: "{count, plural, other {# 件}}",
      ar: "{count, plural, zero {لا توجد عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}",
      es: "{count, plural, one {# elemento} other {# elementos}}",
    },
  },
  filesSelected: {
    source: "{count, plural, one {# file selected} other {# files selected}}",
    kind: "icu",
    gold: {
      de: "{count, plural, one {# Datei ausgewählt} other {# Dateien ausgewählt}}",
      ja: "{count, plural, other {# 件のファイルを選択済み}}",
      ar: "{count, plural, zero {لم يتم تحديد أي ملف} one {تم تحديد ملف واحد} two {تم تحديد ملفين} few {تم تحديد # ملفات} many {تم تحديد # ملفًا} other {تم تحديد # ملف}}",
      es: "{count, plural, one {# archivo seleccionado} other {# archivos seleccionados}}",
    },
  },
  deletedToast: {
    source: "<b>{name}</b> was deleted.",
    kind: "rich-text",
    gold: { de: "<b>{name}</b> wurde gelöscht.", ja: "<b>{name}</b> を削除しました。", ar: "تم حذف <b>{name}</b>.", es: "Se eliminó <b>{name}</b>." },
  },
  confirmDelete: {
    source: "Are you sure you want to delete {name}?",
    kind: "confirm",
    gold: {
      de: "Möchten Sie {name} wirklich löschen?",
      ja: "{name} を削除してもよろしいですか？",
      ar: "هل تريد بالتأكيد حذف {name}؟",
      es: "¿Seguro que quieres eliminar {name}?",
    },
  },
  lastUpdated: {
    source: "Last updated {date}",
    kind: "meta",
    gold: { de: "Zuletzt aktualisiert {date}", ja: "最終更新 {date}", ar: "آخر تحديث {date}", es: "Última actualización {date}" },
  },
};

const SYN_COMPONENTS = {
  UserProfileForm: ["save", "cancel", "required", "minChars", "email", "lastUpdated"],
  ProjectSettings: ["save", "cancel", "delete", "confirmDelete", "archived", "active"],
  InvoiceTable: ["edit", "delete", "pending", "failed", "items", "lastUpdated"],
  FileUploader: ["cancel", "submit", "filesSelected", "failed", "deletedToast"],
  TeamMembersList: ["edit", "delete", "active", "pending", "confirmDelete", "items"],
  NotificationPanel: ["close", "deletedToast", "items", "archived"],
  BillingForm: ["save", "submit", "required", "email", "failed"],
  DocumentCard: ["edit", "delete", "archived", "lastUpdated", "deletedToast"],
  OrderHistory: ["pending", "active", "failed", "items", "close"],
  ApiKeysPanel: ["delete", "confirmDelete", "active", "close", "deletedToast"],
  SignupForm: ["submit", "required", "minChars", "email", "cancel"],
  TaskBoard: ["edit", "archived", "pending", "filesSelected", "close", "save"],
};

const SYN_GLOSSARY = [
  { term: "Delete", translations: { de: "Löschen", ja: "削除", ar: "حذف", es: "Eliminar" } },
  { term: "Archived", translations: { de: "Archiviert", ja: "アーカイブ済み", ar: "مؤرشف", es: "Archivado" } },
  { term: "Pending", translations: { de: "Ausstehend", ja: "保留中", ar: "قيد الانتظار", es: "Pendiente" } },
  {
    term: "email address",
    translations: { de: "E-Mail-Adresse", ja: "メールアドレス", ar: "عنوان البريد الإلكتروني", es: "dirección de correo electrónico" },
  },
];

const ELEMENT_BY_KIND = {
  action: { elementType: "button", budget: 14 },
  validation: { elementType: "p.field-error", budget: null },
  status: { elementType: "span.badge", budget: 12 },
  icu: { elementType: "span.counter", budget: null },
  "rich-text": { elementType: "div.toast", budget: null },
  confirm: { elementType: "dialog > p", budget: null },
  meta: { elementType: "small.meta", budget: 28 },
};

function synthComponentCode(name, ids) {
  const lines = ids.map((id) => {
    const { elementType } = ELEMENT_BY_KIND[SYN_STRINGS[id].kind];
    const tag = elementType.split(/[.\s>]/)[0] || "span";
    return `      <${tag}>{t("${id}")}</${tag}>`;
  });
  return `import { useTranslations } from "next-intl";\nexport function ${name}() {\n  const t = useTranslations("${name}");\n  return (\n    <section>\n${lines.join("\n")}\n    </section>\n  );\n}\n`;
}

function buildSyntheticSlice() {
  const items = [];
  const components = {};
  for (const [comp, ids] of Object.entries(SYN_COMPONENTS)) {
    const file = `src/components/${comp}.tsx`;
    components[file] = synthComponentCode(comp, ids);
    for (const id of ids) {
      const s = SYN_STRINGS[id];
      const el = ELEMENT_BY_KIND[s.kind];
      for (const locale of TM_LOCALES) {
        items.push({
          slice: "synthetic-app",
          locale,
          key: `${comp}.${id}`,
          file,
          component: comp,
          elementType: el.elementType,
          widthBudget: el.budget,
          contextSource: "synthetic-ast",
          source: s.source,
          gold: s.gold[locale],
          goldProvenance: "author-provided",
          category: s.kind,
        });
      }
    }
  }
  return { id: "synthetic-app", kind: "synthetic", items, components, glossary: SYN_GLOSSARY, tmProvenance: "human-reviewed" };
}

// ============================================================================
// (b) Real OSS slices — gold = human OSS translations
// ============================================================================
function walkFiles(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(abs);
  }
  return out;
}

function inferElementType(line) {
  if (/<(Hopp)?Button|<button|Button(Primary|Secondary)|<Hopp\w*Button/i.test(line)) return "button";
  if (/tippy|tooltip/i.test(line)) return "tooltip";
  if (/toast/i.test(line)) return "toast";
  if (/placeholder/i.test(line)) return "input[placeholder]";
  if (/label/i.test(line)) return "label";
  if (/title/i.test(line)) return "title";
  return "text";
}

function buildUsageIndex(srcDir, rootForRel) {
  const idx = {};
  const re = /\bt\(\s*["'`]([a-zA-Z0-9_.-]+)["'`]/g;
  for (const f of walkFiles(srcDir, [".vue", ".ts", ".tsx"])) {
    const txt = fs.readFileSync(f, "utf8");
    if (!txt.includes("t(")) continue;
    const lines = txt.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(lines[i]))) {
        if (idx[m[1]]) continue;
        const ctx = lines.slice(Math.max(0, i - 2), i + 1).join(" ");
        idx[m[1]] = { file: path.relative(rootForRel, f).replace(/\\/g, "/"), line: i + 1, elementType: inferElementType(ctx) };
      }
    }
  }
  return idx;
}

function budgetFor(elementType, source) {
  if (elementType === "button" || elementType === "label") return Math.max(12, Math.ceil(source.length * 1.6));
  return null;
}

function buildHoppscotchSlice() {
  const root = path.join(CORPORA_DIR, "hoppscotch");
  const locDir = path.join(root, "packages/hoppscotch-common/locales");
  const en = readJson(path.join(locDir, "en.json"));
  if (!en) return null;
  const flatEn = flatten(en);
  const golds = Object.fromEntries(TM_LOCALES.map((l) => [l, flatten(readJson(path.join(locDir, `${l}.json`)) ?? {})]));
  const usage = buildUsageIndex(path.join(root, "packages/hoppscotch-common/src"), root);

  const bySource = {};
  for (const [k, v] of Object.entries(flatEn)) if (v.trim()) (bySource[v] ??= []).push(k);
  const recurring = Object.entries(bySource)
    .filter(([, keys]) => new Set(keys.map((k) => k.split(".")[0])).size >= 2)
    .sort((a, b) => hash(`hop:${a[0]}`).localeCompare(hash(`hop:${b[0]}`)))
    .slice(0, OSS_GROUP_CAP);

  const items = [];
  for (const [source, keys] of recurring) {
    for (const locale of TM_LOCALES) {
      const occ = keys.filter((k) => {
        const g = golds[locale][k];
        if (typeof g !== "string" || !g.trim()) return false;
        // Skip untranslated English fallbacks copied into the locale file (multi-word identical to source).
        return !(g.trim() === source.trim() && /\s/.test(source.trim()));
      });
      if (new Set(occ.map((k) => k.split(".")[0])).size < 2) continue;
      for (const k of occ) {
        const ns = k.split(".")[0];
        const u = usage[k];
        const elementType = u?.elementType ?? "text";
        items.push({
          slice: "oss-hoppscotch",
          locale,
          key: k,
          file: u ? `${u.file}:${u.line}` : `packages/hoppscotch-common/locales/en.json#${ns}`,
          component: u ? path.basename(u.file).replace(/\.\w+$/, "") : ns,
          elementType,
          widthBudget: budgetFor(elementType, source),
          contextSource: u ? "grep-usage-site" : "catalog-namespace",
          source,
          gold: golds[locale][k],
          goldProvenance: "human-oss",
          category: "oss-recurring",
        });
      }
    }
  }
  return { id: "oss-hoppscotch", kind: "oss", items, components: {}, glossary: [], tmProvenance: "imported" };
}

function buildNextIntlSlice() {
  const base = path.join(CORPORA_DIR, "next-intl", "examples");
  if (!fs.existsSync(base)) return null;
  const occ = [];
  for (const ex of fs.readdirSync(base).sort()) {
    const en = readJson(path.join(base, ex, "messages/en.json"));
    if (!en) continue;
    const flatEn = flatten(en);
    const golds = Object.fromEntries(TM_LOCALES.map((l) => [l, flatten(readJson(path.join(base, ex, `messages/${l}.json`)) ?? {})]));
    const srcFiles = walkFiles(path.join(base, ex, "src"), [".tsx", ".ts"]);
    for (const [k, v] of Object.entries(flatEn)) occ.push({ ex, key: k, source: v, golds, srcFiles });
  }
  const bySource = {};
  for (const o of occ) (bySource[o.source] ??= []).push(o);
  const items = [];
  for (const [source, list] of Object.entries(bySource)) {
    if (new Set(list.map((o) => `${o.ex}:${o.key.split(".")[0]}`)).size < 2) continue;
    for (const locale of TM_LOCALES) {
      const withGold = list.filter((o) => typeof o.golds[locale][o.key] === "string");
      if (withGold.length < 2) continue;
      for (const o of withGold) {
        const ns = o.key.split(".")[0];
        const compFile = o.srcFiles.find((f) => fs.readFileSync(f, "utf8").includes(`"${ns}"`));
        const rel = compFile ? path.relative(path.join(CORPORA_DIR, "next-intl"), compFile).replace(/\\/g, "/") : `examples/${o.ex}/messages/en.json#${ns}`;
        items.push({
          slice: "oss-next-intl",
          locale,
          key: `${o.ex}:${o.key}`,
          file: rel,
          component: ns,
          elementType: /title/i.test(o.key) ? "title" : /home|navigation/i.test(o.key) ? "nav-link" : "text",
          widthBudget: /navigation/i.test(o.key) ? budgetFor("button", source) : null,
          contextSource: compFile ? "grep-usage-site" : "catalog-namespace",
          source,
          gold: o.golds[locale][o.key],
          goldProvenance: "human-oss",
          category: "oss-recurring",
        });
      }
    }
  }
  return { id: "oss-next-intl", kind: "oss", items, components: {}, glossary: [], tmProvenance: "imported" };
}

// ============================================================================
// TM seeding (isolated per slice)
// ============================================================================
function seedTm(slice) {
  const now = "2026-11-25T00:00:00.000Z";
  const entries = [];
  const seededGroups = new Set();
  for (const locale of TM_LOCALES) {
    const locItems = slice.items.filter((i) => i.locale === locale);
    const groups = [...new Set(locItems.map((i) => i.source))].sort((a, b) =>
      hash(`${slice.id}:${locale}:${a}`).localeCompare(hash(`${slice.id}:${locale}:${b}`))
    );
    const nSeed = Math.round(groups.length * TM_SEED_FRACTION);
    for (const src of groups.slice(0, nSeed)) {
      const first = locItems.filter((i) => i.source === src).sort((a, b) => a.key.localeCompare(b.key))[0];
      seededGroups.add(`${locale}\u0000${src}`);
      entries.push({
        source: src,
        target: first.gold,
        sourceLocale: "en",
        targetLocale: locale,
        key: first.key,
        provenance: slice.tmProvenance,
        ...(slice.tmProvenance === "human-reviewed" ? { verifiedAt: now, note: "author-provided synthetic gold" } : {}),
        updatedAt: now,
      });
    }
  }
  for (const it of slice.items) it.tmSeeded = seededGroups.has(`${it.locale}\u0000${it.source}`);
  const tm = { version: 1, entries };
  const tmPath = path.join(TM_ABLATION_WORK_DIR, slice.id, ".polyglot", "tm.json");
  fs.mkdirSync(path.dirname(tmPath), { recursive: true });
  fs.writeFileSync(tmPath, JSON.stringify(tm, null, 2) + "\n");
  return { tm, tmPath };
}

// ============================================================================
// Prompt builders (one per arm)
// ============================================================================
function glossaryFor(slice, locale, items) {
  return slice.glossary
    .filter((g) => g.translations[locale] && items.some((i) => i.source.toLowerCase().includes(g.term.toLowerCase())))
    .map((g) => ({ term: g.term, translation: g.translations[locale] }));
}

const OUTPUT_RULES = (locale) => `Rules:
- Preserve every placeholder ({name}, {count}, {{x}}), ICU plural/select structure (adapt plural categories to ${locale} CLDR rules but keep variable names and =N branches), and inline tags (<b>, <0>, <link>) exactly.
- Return ONLY a JSON object mapping each "id" to its translation. Write it to a file named out.json in the current directory (and nothing else).`;

function itemLine(it) {
  return `- id: ${JSON.stringify(it.id)}\n  source: ${JSON.stringify(it.source)}`;
}

export function buildPromptB({ locale, items }) {
  return `Translate the following English UI strings into "${locale}".
${OUTPUT_RULES(locale)}

Strings:
${items.map(itemLine).join("\n")}
`;
}

function glossaryBlock(gloss) {
  if (!gloss.length) return "Glossary: (none for this project)";
  return `Glossary (mandatory terminology):\n${gloss.map((g) => `- "${g.term}" -> "${g.translation}"`).join("\n")}`;
}

export function buildPromptBgl({ locale, items, glossary }) {
  return `Translate the following English UI strings into "${locale}".
${glossaryBlock(glossary)}
${OUTPUT_RULES(locale)}

Strings:
${items.map(itemLine).join("\n")}
`;
}

function conventionsFor(locale) {
  return LOCALE_CONVENTIONS_TEXT[locale] ?? (locale === "es" ? LOCALE_CONVENTIONS_TEXT["es-MX"]?.replace(/Mexican Spanish \(es-MX\)/, "Spanish (es)") : "") ?? "";
}

function contextLines(it) {
  const lines = [`  file: ${it.file}`, `  component: ${it.component}`, `  element: ${it.elementType}`];
  if (it.widthBudget) lines.push(`  widthBudget: <= ${it.widthBudget} characters`);
  return lines.join("\n");
}

export function buildPromptAnotm({ locale, items, glossary }) {
  return `You are localizing a multi-file app into "${locale}". Each string is annotated with its UI usage context (source file, component, element type) extracted from the code, and a width budget where the element is tight. tmEnabled: false (no translation memory is available).
Locale conventions: ${conventionsFor(locale)}
${glossaryBlock(glossary)}
${OUTPUT_RULES(locale)}

Strings:
${items.map((it) => `${itemLine(it)}\n${contextLines(it)}`).join("\n")}
`;
}

export function buildPromptAfull({ locale, items, glossary, tmMatchesById }) {
  return `You are localizing a multi-file app into "${locale}". Each string is annotated with its UI usage context (source file, component, element type) extracted from the code, a width budget where the element is tight, and the top-${TM_TOP_K} fuzzy translation-memory matches (similarity >= ${Math.round(TM_MIN_SIMILARITY * 100)}%). Reuse approved TM translations for identical/recurring strings so the same UI string is translated consistently across files, unless the UI context clearly requires a different sense.
Locale conventions: ${conventionsFor(locale)}
${glossaryBlock(glossary)}
${OUTPUT_RULES(locale)}

Strings:
${items
  .map((it) => {
    const tm = tmMatchesById[it.id] ?? [];
    const tmTxt = tm.length
      ? `\n  tm:\n${tm.map((m) => `    - (${m.score}%, ${m.provenance}) ${JSON.stringify(m.source)} -> ${JSON.stringify(m.target)}`).join("\n")}`
      : "\n  tm: (no match >= threshold)";
    return `${itemLine(it)}\n${contextLines(it)}${tmTxt}`;
  })
  .join("\n")}
`;
}

const PROMPT_BUILDERS = { B: buildPromptB, Bgl: buildPromptBgl, Anotm: buildPromptAnotm, Afull: buildPromptAfull };

// ============================================================================
// Dataset assembly
// ============================================================================
function buildDataset() {
  const slices = [buildSyntheticSlice(), buildNextIntlSlice(), buildHoppscotchSlice()].filter((s) => s && s.items.length > 0);
  for (const s of slices) {
    s.items.sort((a, b) => a.locale.localeCompare(b.locale) || a.file.localeCompare(b.file) || a.key.localeCompare(b.key));
    s.items.forEach((it, i) => {
      it.id = `${s.id}:${it.locale}:${it.key}`;
      it.groupId = `${s.id}|${it.locale}|${it.source}`;
      it.idx = i;
    });
    const { tm, tmPath } = seedTm(s);
    s.tm = tm;
    s.tmPath = tmPath;
    if (Object.keys(s.components).length) {
      for (const [rel, code] of Object.entries(s.components)) {
        const p = path.join(TM_ABLATION_WORK_DIR, s.id, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, code);
      }
    }
  }
  return slices;
}

function buildAllPrompts(slices) {
  const jobs = [];
  for (const s of slices) {
    for (const locale of TM_LOCALES) {
      const locItems = s.items.filter((i) => i.locale === locale);
      if (!locItems.length) continue;
      const tmMatchesById = {};
      for (const it of locItems) {
        tmMatchesById[it.id] = fuzzyTmLookup(s.tm.entries, it.source, locale, { k: TM_TOP_K, minSimilarity: TM_MIN_SIMILARITY }).map((m) => ({
          source: m.source,
          target: m.target,
          provenance: m.provenance,
          score: m.score,
        }));
      }
      for (let c = 0; c * CHUNK_SIZE < locItems.length; c++) {
        const chunk = locItems.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
        const glossary = glossaryFor(s, locale, chunk);
        for (const arm of ARMS) {
          const prompt = PROMPT_BUILDERS[arm.id]({ locale, items: chunk, glossary, tmMatchesById });
          const label = `${arm.id}-${locale}-c${c}`;
          const p = path.join(TM_ABLATION_WORK_DIR, s.id, "prompts", `${label}.txt`);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, prompt);
          jobs.push({
            slice: s.id,
            locale,
            arm: arm.id,
            chunk: c,
            label,
            promptPath: p,
            prompt,
            itemIds: chunk.map((i) => i.id),
            tmHits: arm.tmEnabled ? chunk.filter((i) => tmMatchesById[i.id].length > 0).length : 0,
          });
        }
      }
    }
  }
  return jobs;
}

function datasetCounts(slices, jobs) {
  const perSlice = {};
  for (const s of slices) {
    const byLocale = {};
    for (const l of TM_LOCALES) {
      const li = s.items.filter((i) => i.locale === l);
      if (!li.length) continue;
      byLocale[l] = {
        items: li.length,
        recurringGroups: new Set(li.map((i) => i.source)).size,
        tmSeededGroups: s.tm.entries.filter((e) => e.targetLocale === l).length,
        tmSeededItems: li.filter((i) => i.tmSeeded).length,
        distinctFiles: new Set(li.map((i) => i.file)).size,
      };
    }
    const afullJobs = jobs.filter((j) => j.slice === s.id && j.arm === "Afull");
    perSlice[s.id] = {
      kind: s.kind,
      goldProvenance: s.kind === "synthetic" ? "author-provided" : "human-oss",
      totalItems: s.items.length,
      uniqueSources: new Set(s.items.map((i) => i.source)).size,
      components: s.kind === "synthetic" ? Object.keys(s.components).length : new Set(s.items.map((i) => i.component)).size,
      glossaryTerms: s.glossary.length,
      tmEntries: s.tm.entries.length,
      tmPath: path.relative(EVAL_ROOT, s.tmPath),
      afullItemsWithTmHit: afullJobs.reduce((a, j) => a + j.tmHits, 0),
      contextSources: Object.fromEntries(
        [...new Set(s.items.map((i) => i.contextSource))].map((c) => [c, s.items.filter((i) => i.contextSource === c).length])
      ),
      byLocale,
    };
  }
  return {
    locales: TM_LOCALES,
    slices: perSlice,
    totalItems: slices.reduce((a, s) => a + s.items.length, 0),
    totalGroups: slices.reduce((a, s) => a + new Set(s.items.map((i) => i.groupId)).size, 0),
    tmSeedFraction: TM_SEED_FRACTION,
    prompts: {
      total: jobs.length,
      perArm: Object.fromEntries(ARMS.map((a) => [a.id, jobs.filter((j) => j.arm === a.id).length])),
      avgCharsPerArm: Object.fromEntries(
        ARMS.map((a) => {
          const js = jobs.filter((j) => j.arm === a.id);
          return [a.id, js.length ? Math.round(js.reduce((x, j) => x + j.prompt.length, 0) / js.length) : 0];
        })
      ),
      dir: path.relative(EVAL_ROOT, TM_ABLATION_WORK_DIR) + "/<slice>/prompts/",
    },
  };
}

function rowsFor(items, hypById) {
  return items.map((it) => ({ groupId: it.groupId, source: it.source, hyp: hypById(it), gold: it.gold, locale: it.locale }));
}

function goldSanity(slices) {
  const out = { label: "SANITY: gold-vs-gold (hypothesis = reference). Not a system result.", perSlice: {} };
  for (const s of slices) {
    const m = computeTmMetrics(rowsFor(s.items, (it) => it.gold));
    const parityFails = s.items
      .filter((it) => !structuralParity(it.source, it.gold, { targetLocale: it.locale }).ok)
      .slice(0, 5)
      .map((it) => ({ id: it.id, issues: structuralParity(it.source, it.gold, { targetLocale: it.locale }).issues }));
    out.perSlice[s.id] = {
      ...m,
      note:
        s.kind === "synthetic"
          ? "Author-provided gold is consistent by construction: expect TCR 1.0, parity 1.0, chrF2 100, TER 0."
          : "chrF2/TER are 100/0 by definition; TCR/parity < 1 measure inconsistency/structure drift INSIDE the human OSS gold itself (human baseline).",
      parityFailExamples: parityFails,
    };
  }
  // pure-function self-checks
  out.selfChecks = {
    chrF_identical: chrF("Speichern", "Speichern"),
    ter_identical: ter("Dieses Feld ist erforderlich.", "Dieses Feld ist erforderlich."),
    parity_dropped_var: structuralParity("Must be at least {min} characters.", "Muss mindestens Zeichen lang sein.", { targetLocale: "de" }).ok,
  };
  return out;
}

// ============================================================================
// Full mode: run Codex (no Polyglot MCP — prompt carries all context) per arm
// ============================================================================
async function runPool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    })
  );
  return results;
}

function parseCodexOutput(res) {
  const b64 = res.capturedFiles?.["out.json"];
  const tryParse = (txt) => {
    try {
      const m = /\{[\s\S]*\}/.exec(txt);
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  };
  if (b64) {
    const parsed = tryParse(Buffer.from(b64, "base64").toString("utf8"));
    if (parsed) return parsed;
  }
  return tryParse(res.telemetry?.lastMessage ?? "") ?? {};
}

async function runFull(slices, jobs, { ignoreSpendCap }) {
  const { runCodexNoPolyglot } = await import("../lib/codex.mjs");
  const srcDir = path.join(TM_ABLATION_WORK_DIR, "codex-src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "README.txt"), "Polyglot eval: TM context ablation scratch workspace.\n");
  const outputs = {}; // arm -> id -> text
  const runMeta = [];
  await runPool(
    jobs.map((job) => async () => {
      console.log(`[tm-ablation] ${job.slice} ${job.label} (${job.itemIds.length} strings)`);
      const res = await runCodexNoPolyglot({
        stageName: "tm-ablation",
        label: `tm-ablation-${job.slice}-${job.label}`,
        sourceDir: srcDir,
        prompt: job.prompt,
        captureRelPaths: ["out.json"],
        ignoreSpendCap,
      });
      const parsed = parseCodexOutput(res);
      outputs[job.arm] ??= {};
      let got = 0;
      for (const id of job.itemIds) {
        if (typeof parsed[id] === "string") {
          outputs[job.arm][id] = parsed[id];
          got++;
        }
      }
      runMeta.push({ ...job, prompt: undefined, exitCode: res.exitCode, cacheHit: res.cacheHit, wallMs: res.wallMs, returned: got });
    }),
    CODEX_CONCURRENCY
  );
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  for (const arm of ARMS) atomicWriteJson(path.join(OUTPUTS_DIR, `${arm.id}.json`), outputs[arm.id] ?? {});

  const allItems = slices.flatMap((s) => s.items);
  const metrics = { perArm: {}, perCell: {} };
  for (const arm of ARMS) {
    const hyp = (it) => outputs[arm.id]?.[it.id] ?? "";
    const overall = computeTmMetrics(rowsFor(allItems, hyp));
    const seeded = computeTmMetrics(rowsFor(allItems.filter((i) => i.tmSeeded), hyp));
    const unseeded = computeTmMetrics(rowsFor(allItems.filter((i) => !i.tmSeeded), hyp));
    metrics.perArm[arm.id] = {
      ...overall,
      missing: allItems.filter((i) => !outputs[arm.id]?.[i.id]).length,
      tmSeededSubset: { tcr: seeded.tcr, chrF2: seeded.chrF2, n: seeded.n },
      unseededSubset: { tcr: unseeded.tcr, chrF2: unseeded.chrF2, n: unseeded.n },
    };
    for (const s of slices) {
      for (const l of TM_LOCALES) {
        const its = s.items.filter((i) => i.locale === l);
        if (!its.length) continue;
        ((metrics.perCell[s.id] ??= {})[l] ??= {})[arm.id] = computeTmMetrics(rowsFor(its, hyp));
      }
    }
  }
  return { metrics, runMeta };
}

// ============================================================================
// Entry points
// ============================================================================
export async function runTmAblationStage({ dryRun = false, ignoreSpendCap = false } = {}) {
  console.log(`=== Stage 4: TM Context Ablation (${dryRun ? "DRY RUN — no models" : "FULL"}) ===`);
  fs.mkdirSync(TM_ABLATION_WORK_DIR, { recursive: true });
  const slices = buildDataset();
  const jobs = buildAllPrompts(slices);
  const dataset = datasetCounts(slices, jobs);
  atomicWriteJson(DATASET_PATH, {
    generatedAt: new Date().toISOString(),
    slices: slices.map((s) => ({ id: s.id, kind: s.kind, glossary: s.glossary, tmPath: path.relative(EVAL_ROOT, s.tmPath), items: s.items })),
  });

  const prev = readJson(TM_ABLATION_RESULTS_PATH);
  const base = {
    generatedAt: new Date().toISOString(),
    datasetPath: path.relative(EVAL_ROOT, DATASET_PATH),
    dataset,
    arms: ARMS.map((a) => ({ id: a.id, label: a.label, context: a.context, tmEnabled: a.tmEnabled })),
    tmRetrieval: { topK: TM_TOP_K, minSimilarity: TM_MIN_SIMILARITY, similarity: "lexicalSimilarity (local port of src/core/fuzzy.ts)" },
    metricDefinitions: {
      tcr: "1 - (uniqueVariants-1)/(N-1) per recurring (slice, locale, source) group; N=1 -> 1.0; unweighted mean over groups.",
      parity: "Share of items whose {var} set, inline tag multiset and ICU select keys match source exactly; plural keeps other + =N + source categories used by target CLDR.",
      chrF2: "Character n-gram F-beta, n=1..6 averaged, beta=2, whitespace stripped, 0..100, vs gold.",
      ter: "Plain word edit distance (no shifts) / reference length x100 (upper bound on true TER); graphemes for ja.",
      mqm: "Dual-judge (Claude + Gemini) MQM via eval/lib/judges.mjs runDualJudgeEvaluation; Terminology/Inconsistency + Accuracy categories.",
    },
  };

  if (dryRun) {
    const out = {
      ...base,
      mode: "dry-run",
      metrics: null,
      sanity: goldSanity(slices),
      judge: "pending",
    };
    atomicWriteJson(TM_ABLATION_RESULTS_PATH, out);
    console.log(JSON.stringify({ dataset: out.dataset, sanity: out.sanity }, null, 2));
    console.log(`Wrote ${TM_ABLATION_RESULTS_PATH}`);
    return out;
  }

  const { metrics, runMeta } = await runFull(slices, jobs, { ignoreSpendCap });
  const out = {
    ...base,
    mode: "full",
    metrics,
    runs: runMeta,
    outputsDir: path.relative(EVAL_ROOT, OUTPUTS_DIR),
    sanity: goldSanity(slices),
    judge: prev?.mode === "full" && prev?.judge && prev.judge !== "pending" ? prev.judge : "pending",
    judging: prev?.mode === "full" ? prev.judging : undefined,
  };
  atomicWriteJson(TM_ABLATION_RESULTS_PATH, out);
  console.log(JSON.stringify(metrics.perArm, null, 2));
  return out;
}

/**
 * Dual-judge MQM for tm-ablation (called from `judge-remaining --scopes tm-ablation`).
 * Never fabricates: if no full-mode outputs exist, leaves judge = "pending".
 */
export async function runTmAblationJudging({ ignoreSpendCap = false, judgeMode = "all" } = {}) {
  const data = readJson(TM_ABLATION_RESULTS_PATH);
  if (!data || data.mode !== "full") {
    console.log(`[tm-ablation] judge pending: no full-mode model outputs (mode=${data?.mode ?? "missing"}). Run \`node eval/run.mjs run --scopes tm-ablation\` first.`);
    return null;
  }
  const ds = readJson(DATASET_PATH);
  const outputs = Object.fromEntries(ARMS.map((a) => [a.id, readJson(path.join(OUTPUTS_DIR, `${a.id}.json`)) ?? {}]));
  const { runDualJudgeEvaluation } = await import("../lib/judges.mjs");
  data.judging ??= {};
  const tasks = [];
  let seed = 9100;
  for (const s of ds.slices) {
    for (const locale of TM_LOCALES) {
      const cellKey = `${s.id}:${locale}`;
      seed += 31;
      if (data.judging[cellKey] && !data.judging[cellKey].partialJudgeMode) continue;
      const its = s.items
        .filter((i) => i.locale === locale && ARMS.every((a) => outputs[a.id][i.id]))
        .sort((a, b) => hash(a.id).localeCompare(hash(b.id)))
        .slice(0, 40);
      if (!its.length) continue;
      const items = its.map((it) => ({
        key: it.id,
        source: it.source,
        category: "tm-consistency",
        isChallenge: false,
        context: `${it.file} / ${it.component} / ${it.elementType}. Recurring UI string (appears in multiple files); terminology must be consistent. Reference (${it.goldProvenance}): ${it.gold}`,
        intendedSense: null,
        glossaryHits: (s.glossary ?? [])
          .filter((g) => g.translations[locale] && it.source.toLowerCase().includes(g.term.toLowerCase()))
          .map((g) => ({ term: g.term, translation: g.translations[locale] })),
        candidates: Object.fromEntries(ARMS.map((a) => [a.id, outputs[a.id][it.id]])),
      }));
      const mySeed = seed;
      tasks.push(async () => {
        const res = await runDualJudgeEvaluation({
          stageName: `tm-ablation-${s.id}`,
          targetLocale: locale,
          items,
          concurrency: 16,
          seed: mySeed,
          ignoreSpendCap,
          includeSubtleControls: true,
          judgeMode,
        });
        if (res) data.judging[cellKey] = res;
      });
    }
  }
  await Promise.all(tasks.map((t) => t()));

  // Aggregate MQM per arm (item-weighted)
  const agg = Object.fromEntries(ARMS.map((a) => [a.id, { n: 0, total: 0, terminology: 0, accuracy: 0, wins: 0 }]));
  for (const res of Object.values(data.judging)) {
    const n = res.itemCount ?? 0;
    for (const a of ARMS) {
      const m = res.mqmPer100?.[a.id];
      if (!m) continue;
      agg[a.id].n += n;
      agg[a.id].total += (m.totalPer100 * n) / 100;
      for (const [cat, v] of Object.entries(m.byCategory ?? {})) {
        if (/termin|consist/i.test(cat)) agg[a.id].terminology += (v * n) / 100;
        if (/accura|mistransl|omission|addition/i.test(cat)) agg[a.id].accuracy += (v * n) / 100;
      }
      agg[a.id].wins += res.panel?.wins?.[a.id] ?? 0;
    }
  }
  const perArm = Object.fromEntries(
    Object.entries(agg).map(([k, v]) => [
      k,
      v.n
        ? {
            judgedItems: v.n,
            mqmTotalPer100: Number(((v.total / v.n) * 100).toFixed(2)),
            terminologyInconsistencyPer100: Number(((v.terminology / v.n) * 100).toFixed(2)),
            accuracyPer100: Number(((v.accuracy / v.n) * 100).toFixed(2)),
            panelWins: v.wins,
          }
        : null,
    ])
  );
  data.judge = Object.values(perArm).some(Boolean) ? { status: judgeMode === "all" ? "done" : `partial:${judgeMode}`, perArm } : "pending";
  atomicWriteJson(TM_ABLATION_RESULTS_PATH, data);
  console.log(`[tm-ablation] judge ${typeof data.judge === "string" ? data.judge : data.judge.status}`);
  return data.judge;
}
