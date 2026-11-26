import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  applyDocumentTranslations,
  applyTranslations,
  importAsset,
  initProject,
  prepareDocument,
  runCheck,
  scanProject,
} from "../../src/index.js";
import { i18nextPkg, init, nextIntlPkg, project } from "../../audit/helpers.js";

const REPO = path.resolve(__dirname, "../..");
const write = (dir: string, rel: string, c: string | object) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof c === "string" ? c : JSON.stringify(c, null, 2) + "\n");
};
const chk = (dir: string, extra: object = {}) => runCheck({ rootDir: dir, limit: 100, ...extra });

/* ------------------------------------------------------------------ */
/* R3-STALE: staleness after manual edits                              */
/* ------------------------------------------------------------------ */
describe("R3-STALE. Staleness cannot be laundered by an unrelated manual edit", () => {
  const page = `import { useTranslations } from "next-intl"; export default function P(){ const t = useTranslations(); return <a>{t("cta")}</a>; }`;

  it("STALE-1 a translator typo-fix LONG BEFORE an English meaning change must not suppress stale_source forever", () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ cta: "Buy now" }), "src/P.tsx": page });
    init(dir, ["de"]);
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "cta", value: "Jetzt kaufen" }] });
    write(dir, "messages/de.json", { cta: "Jetzt kaufen!" }); // week 1: translator adds "!" by hand
    expect(chk(dir).outcome).toBe("PASS");
    write(dir, "messages/en.json", { cta: "Cancel subscription" }); // week 6: English meaning changes completely
    const r = chk(dir);
    console.log(`[STALE-1] outcome=${r.outcome} codes=${JSON.stringify(r.countsByCode)}  (German still says "Jetzt kaufen!")`);
    expect(r.countsByCode["stale_source"] ?? 0).toBe(1);
  });

  // KNOWN GAP (docs/KNOWN_GAPS.md #2): keys added by hand to both locales after init without import/apply have no source baseline
  it.fails("STALE-2 a key ADDED after init (English + German by hand, never applied/imported) goes stale when English changes", () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ cta: "Buy now" }), "messages/de.json": JSON.stringify({ cta: "Jetzt kaufen" }), "src/P.tsx": page });
    init(dir, ["de"]);
    write(dir, "messages/en.json", { cta: "Buy now", promo: "Free shipping over 50 €" });
    write(dir, "messages/de.json", { cta: "Jetzt kaufen", promo: "Kostenloser Versand ab 50 €" });
    write(dir, "src/P.tsx", page.replace('<a>{t("cta")}</a>', '<><a>{t("cta")}</a><p>{t("promo")}</p></>'));
    expect(chk(dir).outcome).toBe("PASS");
    write(dir, "messages/en.json", { cta: "Buy now", promo: "Free shipping on every order" });
    const r = chk(dir);
    console.log(`[STALE-2] outcome=${r.outcome} codes=${JSON.stringify(r.countsByCode)}`);
    expect(r.countsByCode["stale_source"] ?? 0).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* R3-MISSKEY: missing_source_key false positives on real idioms        */
/* ------------------------------------------------------------------ */
describe("R3-MISSKEY. missing_source_key must not fire on valid i18n idioms", () => {
  it("MISS-1 i18next plural keys (t('items', {count}) with items_one / items_other in the catalog)", () => {
    const dir = project({
      "package.json": i18nextPkg,
      "public/locales/en/common.json": JSON.stringify({ items_one: "{{count}} item", items_other: "{{count}} items", friend_male: "He is a friend", friend_female: "She is a friend" }),
      "public/locales/de/common.json": JSON.stringify({ items_one: "{{count}} Artikel", items_other: "{{count}} Artikel", friend_male: "Er ist ein Freund", friend_female: "Sie ist eine Freundin" }),
      "src/A.tsx": `import { useTranslation } from "react-i18next";
export function A({ n, g }: { n: number; g: "male" | "female" }) { const { t } = useTranslation("common"); return <p>{t("items", { count: n })} {t("friend", { context: g })}</p>; }`,
    });
    init(dir, ["de"]);
    const r = chk(dir);
    console.log(`[MISS-1] outcome=${r.outcome} codes=${JSON.stringify(r.countsByCode)} ${JSON.stringify(r.issues.items.filter((i) => i.code === "missing_source_key").map((i) => i.key))}`);
    expect(r.countsByCode["missing_source_key"] ?? 0).toBe(0);
  });

  it("MISS-2 react-i18next keyPrefix option (useTranslation('common', { keyPrefix: 'nav' }))", () => {
    const dir = project({
      "package.json": i18nextPkg,
      "public/locales/en/common.json": JSON.stringify({ nav: { home: "Home", about: "About" } }),
      "public/locales/de/common.json": JSON.stringify({ nav: { home: "Start", about: "Über uns" } }),
      "src/Nav.tsx": `import { useTranslation } from "react-i18next";
export function Nav() { const { t } = useTranslation("common", { keyPrefix: "nav" }); return <nav><a>{t("home")}</a><a>{t("about")}</a></nav>; }`,
    });
    init(dir, ["de"]);
    const r = chk(dir);
    console.log(`[MISS-2] outcome=${r.outcome} codes=${JSON.stringify(r.countsByCode)}`);
    expect(r.countsByCode["missing_source_key"] ?? 0).toBe(0);
  });

  it("MISS-3 next-intl t.has('optional') existence checks are not usages of a required key", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": JSON.stringify({ title: "Pricing" }),
      "messages/de.json": JSON.stringify({ title: "Preise" }),
      "src/P.tsx": `import { useTranslations } from "next-intl";
export function P() { const t = useTranslations(); return <h1>{t("title")}{t.has("subtitle") && <small>{t("subtitle")}</small>}</h1>; }`,
    });
    init(dir, ["de"]);
    const r = chk(dir);
    console.log(`[MISS-3] outcome=${r.outcome} codes=${JSON.stringify(r.countsByCode)}`);
    // Guarded optional key: should be at most a warning, never a blocking error.
    const blocking = r.issues.items.filter((i) => i.code === "missing_source_key" && i.severity === "error");
    expect(blocking.length).toBe(0);
  });

  it("MISS-4 Rails lazy lookup in a partial (_form.html.erb -> users.form.title) resolves", () => {
    const dir = project({
      Gemfile: `gem "rails"\n`,
      "config/locales/en.yml": `en:\n  users:\n    form:\n      title: "Edit user"\n`,
      "config/locales/de.yml": `de:\n  users:\n    form:\n      title: "Benutzer bearbeiten"\n`,
      "app/views/users/_form.html.erb": `<h2><%= t(".title") %></h2>\n`,
    });
    init(dir, ["de"]);
    const r = chk(dir);
    console.log(`[MISS-4] outcome=${r.outcome} codes=${JSON.stringify(r.countsByCode)}`);
    expect(r.countsByCode["missing_source_key"] ?? 0).toBe(0);
  });

  it("MISS-5 Django pgettext / ngettext usages resolve against msgctxt / msgid_plural entries", () => {
    const dir = project({
      "manage.py": "",
      "shop/views.py": `from django.utils.translation import pgettext, ngettext\ndef v(r, n):\n    a = pgettext("month name", "May")\n    b = ngettext("%(n)d item", "%(n)d items", n) % {"n": n}\n    return a, b\n`,
      "locale/de/LC_MESSAGES/django.po": `msgid ""\nmsgstr ""\n"Language: de\\n"\n"Plural-Forms: nplurals=2; plural=(n != 1);\\n"\n\nmsgctxt "month name"\nmsgid "May"\nmsgstr "Mai"\n\nmsgid "%(n)d item"\nmsgid_plural "%(n)d items"\nmsgstr[0] "%(n)d Artikel"\nmsgstr[1] "%(n)d Artikel"\n`,
    });
    init(dir, ["de"]);
    const r = chk(dir);
    console.log(`[MISS-5] outcome=${r.outcome} codes=${JSON.stringify(r.countsByCode)}`);
    expect(r.countsByCode["missing_source_key"] ?? 0).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* R3-UNSCANNED: INCONCLUSIVE from unscanned file types on ordinary repos */
/* ------------------------------------------------------------------ */
describe("R3-UNSCANNED. Ordinary repository files do not make every check INCONCLUSIVE", () => {
  const clean = {
    "package.json": nextIntlPkg,
    "messages/en.json": JSON.stringify({ a: "Hello" }),
    "messages/de.json": JSON.stringify({ a: "Hallo" }),
    "src/P.tsx": `import { useTranslations } from "next-intl"; export const P = () => { const t = useTranslations(); return <h1>{t("a")}</h1>; };`,
  };
  it("UNS-1 README.md / CHANGELOG.md / docs/*.md at the repo root do not block PASS", () => {
    const dir = project({ ...clean, "README.md": "# App\n\nRun npm dev.\n", "CHANGELOG.md": "## 1.0\n- init\n", "docs/setup.md": "# Setup\n" });
    init(dir, ["de"]);
    const r = chk(dir);
    console.log(`[UNS-1] outcome=${r.outcome} reasons=${JSON.stringify(r.inconclusiveReasons)}`);
    expect(r.outcome).toBe("PASS");
  });

  it("UNS-2 Storybook .mdx stories INCONCLUSIVE has an actionable fix, and paths.ignore clears it", () => {
    const dir = project({ ...clean, "src/stories/Button.mdx": "import { Meta } from '@storybook/blocks';\n<Meta title='Button' />\n# Button\n" });
    init(dir, ["de"]);
    const before = chk(dir);
    const cfgPath = path.join(dir, ".wraith/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.paths.ignore = [...cfg.paths.ignore, "src/stories"];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const after = chk(dir);
    console.log(`[UNS-2] before=${before.outcome} ${JSON.stringify(before.inconclusiveReasons)} after-ignore=${after.outcome}`);
    expect(after.outcome).toBe("PASS");
  });
});

/* ------------------------------------------------------------------ */
/* R3-DOC: content-derived segment identity                             */
/* ------------------------------------------------------------------ */
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (paras: string[]) =>
  zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`),
  });
const outTexts = (f: string) => [...strFromU8(unzipSync(fs.readFileSync(f))["word/document.xml"]).matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join(""));
const DE: Record<string, string> = { "Yes.": "Ja.", "No.": "Nein.", "Apples are red.": "Äpfel sind rot.", "Pears are green.": "Birnen sind grün.", "Step one.": "Schritt eins.", "Step two.": "Schritt zwei." };

describe("R3-DOC. Content-derived DOCX segment identity", () => {
  // KNOWN GAP (docs/KNOWN_GAPS.md #3): repeated identical paragraphs with distinct translations swap occurrence index when reordered
  it.fails("DOC-1 repeated identical paragraphs that the translator rendered differently keep their own translations after reordering", () => {
    const dir = project({ "d.docx": docx(["Question one?", "Yes.", "Question two?", "Yes."]) });
    init(dir, ["de"]);
    const segs = prepareDocument(dir, { documentPath: "d.docx", targetLocale: "de", limit: 50 }).segments as any[];
    const updates = segs.map((s, i) => ({ id: s.id, text: s.source === "Yes." ? (i === 1 ? "Ja, gern." : "Ja, genau.") : `DE ${s.source}` }));
    applyDocumentTranslations(dir, { sourceFile: "d.docx", targetFile: "d.de.docx", targetLocale: "de", updates });
    // Author swaps the two Q/A blocks
    fs.writeFileSync(path.join(dir, "d.docx"), docx(["Question two?", "Yes.", "Question one?", "Yes."]));
    const res = applyDocumentTranslations(dir, { sourceFile: "d.docx", targetFile: "d.de.docx", targetLocale: "de", updates: [] as any });
    const out = outTexts(path.join(dir, "d.de.docx"));
    console.log(`[DOC-1] ok=${res.ok} out=${JSON.stringify(out)}`);
    expect(out).toEqual(["DE Question two?", "Ja, genau.", "DE Question one?", "Ja, gern."]);
  });

  it("DOC-2 a reviewer's hand edit on a paragraph whose SOURCE later changes is reported stale, not silently kept with PASS", () => {
    const dir = project({ "d.docx": docx(["Apples are red.", "Pears are green."]) });
    init(dir, ["de"]);
    const cfgPath = path.join(dir, ".wraith/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.paths.documents = ["d.docx"];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const segs = prepareDocument(dir, { documentPath: "d.docx", targetLocale: "de", limit: 50 }).segments as any[];
    applyDocumentTranslations(dir, { sourceFile: "d.docx", targetFile: "d.de.docx", targetLocale: "de", updates: segs.map((s) => ({ id: s.id, text: DE[s.source] })) });
    const t = path.join(dir, "d.de.docx");
    const f = unzipSync(fs.readFileSync(t));
    f["word/document.xml"] = strToU8(strFromU8(f["word/document.xml"]).replace("Äpfel sind rot.", "Die Äpfel sind rot."));
    fs.writeFileSync(t, zipSync(f));
    fs.writeFileSync(path.join(dir, "d.docx"), docx(["Apples are blue.", "Pears are green."]));
    const r = chk(dir);
    console.log(`[DOC-2] outcome=${r.outcome} codes=${JSON.stringify(r.countsByCode)}`);
    expect(r.outcome).not.toBe("PASS");
  });
});

/* ------------------------------------------------------------------ */
/* R3-LOCK: lock coverage and failure paths                             */
/* ------------------------------------------------------------------ */
describe("R3-LOCK. Workspace lock", () => {
  const runScript = (dir: string, body: string) =>
    new Promise<number>((res) => {
      const f = path.join(dir, `w${Math.random().toString(36).slice(2)}.mts`);
      const indexImport = pathToFileURL(path.join(REPO, "src/index.ts")).href;
      fs.writeFileSync(f, `import * as P from ${JSON.stringify(indexImport)};\nP.ensureBootstrapped();\n${body}`);
      spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), f], { cwd: REPO, stdio: "inherit" }).on("exit", (c) => res(c ?? -1));
    });

  it("LOCK-1 concurrent glossary decisions from two processes are all kept", async () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ a: "x" }) });
    init(dir, ["de"]);
    const body = (p: string) => `for (let i = 0; i < 25; i++) P.recordGlossaryTerm(${JSON.stringify(dir)}, { term: "${p}" + i, translations: { de: "${p}DE" + i } });`;
    await Promise.all([runScript(dir, body("Alpha")), runScript(dir, body("Beta"))]);
    const n = JSON.parse(fs.readFileSync(path.join(dir, ".wraith/glossary.json"), "utf8")).entries.length;
    console.log(`[LOCK-1] glossary entries kept: ${n}/50`);
    expect(n).toBe(50);
  });

  it("LOCK-2 a failing apply releases the lock (next apply is not blocked)", () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ a: "Hello", b: "Bye" }), "messages/de.json": "{ broken json" });
    init(dir, ["de"]);
    try {
      applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "a", value: "Hallo" }] });
    } catch {}
    const lockLeft = fs.existsSync(path.join(dir, ".wraith/.lock"));
    fs.writeFileSync(path.join(dir, "messages/de.json"), "{}\n");
    const t0 = Date.now();
    const r = applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "b", value: "Tschüss" }] });
    console.log(`[LOCK-2] lock left after failure=${lockLeft}; next apply ok=${r.ok} in ${Date.now() - t0} ms`);
    expect(lockLeft).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("LOCK-3 a lock left by a SIGKILLed process is recovered", async () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ a: "Hello" }) });
    init(dir, ["de"]);
    fs.writeFileSync(path.join(dir, ".wraith/.lock"), JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }));
    const t0 = Date.now();
    let ok = false;
    try {
      ok = applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "a", value: "Hallo" }] }).ok;
    } catch (e: any) {
      console.log(`[LOCK-3] error: ${String(e.message).slice(0, 120)}`);
    }
    console.log(`[LOCK-3] recovered=${ok} after ${Date.now() - t0} ms`);
    expect(ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* R3-SEC: write confinement in git worktrees                           */
/* ------------------------------------------------------------------ */
describe("R3-SEC. Hook install in a git worktree (.git is a file)", () => {
  it("SEC3-1 `init --hook` in a worktree fails cleanly or installs into the worktree's hooks, never crashes", () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": "{}" });
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /nonexistent/main/.git/worktrees/feature\n");
    let err = "";
    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], installHook: true, writeAgentRule: false });
    } catch (e: any) {
      err = String(e.message);
    }
    console.log(`[SEC3-1] ${err ? "error: " + err.slice(0, 160) : "no error"}`);
    expect(err === "" || /worktree|hook|\.git/i.test(err)).toBe(true);
    expect(err).not.toMatch(/ENOTDIR|EEXIST/);
  });
});

/* ------------------------------------------------------------------ */
/* R3-SCAN: a fourth app no one has seen                                */
/* ------------------------------------------------------------------ */
describe("R3-SCAN. Scanner on a fourth unseen app (different idioms)", () => {
  // KNOWN GAP (docs/KNOWN_GAPS.md #4): heuristic AST scanner achieves ~44% recall (0% FPs) on indirect switch/object-prop copy
  it.fails("SCAN-1 recall and precision", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": "{}",
      "src/Dashboard.tsx": `
import { useMemo } from "react";
type Status = "active" | "paused";
const STATUS_LABEL: Record<Status, string> = { active: "Running", paused: "Paused by owner" };
function emptyMessage(kind: string) {
  switch (kind) { case "projects": return "You have no projects yet"; default: return "Nothing to show"; }
}
export function Dashboard({ status, kind, items }: { status: Status; kind: string; items: string[] }) {
  const subtitle = useMemo(() => (items.length ? \`\${items.length} projects\` : emptyMessage(kind)), [items, kind]);
  return (
    <section data-testid="dashboard" className="grid gap-4">
      <Tabs items={[{ id: "all", label: "All projects" }, { id: "mine", label: "Created by me" }]} />
      <Badge tone="warning">{STATUS_LABEL[status]}</Badge>
      <p>{subtitle}</p>
      <input type="search" autoComplete="off" name="q" placeholder="Search projects…" />
      <Tooltip content="Archived projects are hidden" />
    </section>
  );
}
declare const Tabs: any, Badge: any, Tooltip: any;
`,
      "src/lib/client.ts": `
const API_BASE = "https://api.example.com/v2";
export function track(event: "keydown" | "click") {
  localStorage.setItem("theme", "dark");
  console.error("Failed to fetch dashboard data");
  if (!API_BASE) throw new Error("Invariant failed: API_BASE missing");
  return new Date().toLocaleDateString("en-US", { month: "long" });
}
`,
    });
    init(dir, ["de"]);
    const r = scanProject({ rootDir: dir, limit: 100 });
    const items = [...r.hardcodedStrings.items.map((h) => h.text), ...r.concatenations.items.map((c) => c.expression)];
    const found = items.join("\n");
    const EXPECT = ["Running", "Paused by owner", "You have no projects yet", "Nothing to show", "projects", "All projects", "Created by me", "Search projects…", "Archived projects are hidden"];
    const MUST_NOT = ["api.example.com", "theme", "dark", "Failed to fetch", "Invariant failed", "en-US", "keydown", "dashboard", "grid gap-4", "search", "off"];
    const hits = EXPECT.filter((e) => found.includes(e));
    const fps = items.filter((t) => MUST_NOT.some((m) => t === m || t.includes(m)) && !EXPECT.some((e) => t.includes(e)));
    console.log(`[SCAN-1] recall ${hits.length}/${EXPECT.length} missed=${JSON.stringify(EXPECT.filter((e) => !found.includes(e)))} FPs=${JSON.stringify(fps)}`);
    expect(hits.length / EXPECT.length).toBeGreaterThanOrEqual(0.7);
    expect(fps).toEqual([]);
  });
});
