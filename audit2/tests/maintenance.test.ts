import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations, importAsset, lookupMemory, prepareBatch, runCheck } from "../../src/index.js";
import { init, nextIntlPkg, project } from "../../audit/helpers.js";

const write = (dir: string, rel: string, obj: unknown) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj, null, 2) + "\n");
const page = (keys: string[]) => `import { useTranslations } from "next-intl";
export default function Page(){ const t = useTranslations(); return <main>${keys.map((k) => `<p>{t("${k}")}</p>`).join("")}</main>; }`;
const app = (en: Record<string, string>, de?: Record<string, string>) => {
  const files: Record<string, string> = { "package.json": nextIntlPkg, "messages/en.json": JSON.stringify(en, null, 2) + "\n", "src/app/page.tsx": page(Object.keys(en)) };
  if (de) files["messages/de.json"] = JSON.stringify(de, null, 2) + "\n";
  return project(files);
};
const codes = (dir: string) => runCheck({ rootDir: dir, limit: 100 }).countsByCode;
const outcome = (dir: string) => runCheck({ rootDir: dir, limit: 100 }).outcome;

describe("MT. Maintenance when source code and translations are edited by hand", () => {
  it("MT1 translations added by hand AFTER init become stale when the English later changes", () => {
    const dir = app({ cta: "Buy now" });
    init(dir, ["de"]); // init before any German exists
    write(dir, "messages/de.json", { cta: "Jetzt kaufen" }); // translator adds German by hand
    expect(outcome(dir)).toBe("PASS");
    write(dir, "messages/en.json", { cta: "Buy now and save 20%" });
    const c = codes(dir);
    console.log(`[MT1] after English change: ${JSON.stringify(c)}`);
    expect(c["stale_source"] ?? 0).toBe(1);
  });

  it("MT2 developer updates English AND German together by hand: check accepts it (no permanent stale error)", () => {
    const dir = app({ cta: "Buy now" }, { cta: "Jetzt kaufen" });
    init(dir, ["de"]);
    write(dir, "messages/en.json", { cta: "Buy now and save 20%" });
    write(dir, "messages/de.json", { cta: "Jetzt kaufen und 20 % sparen" });
    const c = codes(dir);
    console.log(`[MT2] after updating both by hand: ${JSON.stringify(c)}`);
    expect(c["stale_source"] ?? 0).toBe(0);
  });

  it("MT3 ...or at least a documented, non-agent way to accept a manual update exists (import)", () => {
    const dir = app({ cta: "Buy now" }, { cta: "Jetzt kaufen" });
    init(dir, ["de"]);
    write(dir, "messages/en.json", { cta: "Buy now and save 20%" });
    write(dir, "messages/de.json", { cta: "Jetzt kaufen und 20 % sparen" });
    importAsset(dir, { format: "locales" });
    const c = codes(dir);
    console.log(`[MT3] after import: ${JSON.stringify(c)}`);
    expect(c["stale_source"] ?? 0).toBe(0);
  });

  it("MT4 English changed but German NOT touched stays stale even after import (staleness not laundered)", () => {
    const dir = app({ cta: "Buy now" }, { cta: "Jetzt kaufen" });
    init(dir, ["de"]);
    write(dir, "messages/en.json", { cta: "Buy now and save 20%" });
    importAsset(dir, { format: "locales" });
    expect(codes(dir)["stale_source"] ?? 0).toBe(1);
  });

  it("MT5 a hand-corrected translation replaces the old agent text as the memory suggestion", () => {
    const dir = app({ cta: "Buy now", cta2: "Buy now" });
    init(dir, ["de"]);
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "cta", value: "Kaufen jetzt" }] });
    write(dir, "messages/de.json", { cta: "Jetzt kaufen" }); // native speaker fixes word order by hand
    const mem = lookupMemory(dir, { query: "Buy now", targetLocale: "de" });
    const prep = prepareBatch({ rootDir: dir, targetLocale: "de", keys: ["cta2"] });
    const suggested = [...mem.fuzzyMatches.map((m) => m.target), ...(prep.items[0]?.fuzzyMatches ?? []).map((m) => m.target)];
    console.log(`[MT5] suggestions after manual fix: ${JSON.stringify(suggested)}`);
    expect(suggested).toContain("Jetzt kaufen");
    expect(suggested[0]).toBe("Jetzt kaufen");
  });

  it("MT6 renaming a key in code and en.json (cta -> buyCta) reports the German as missing/extra, not PASS", () => {
    const dir = app({ cta: "Buy now" }, { cta: "Jetzt kaufen" });
    init(dir, ["de"]);
    write(dir, "messages/en.json", { buyCta: "Buy now" });
    fs.writeFileSync(path.join(dir, "src/app/page.tsx"), page(["buyCta"]));
    const c = codes(dir);
    console.log(`[MT6] ${JSON.stringify(c)}`);
    expect(c["missing_key"] ?? 0).toBe(1);
  });

  it("MT7 deleting a component leaves its keys reported as orphaned (warning), verdict unaffected", () => {
    const dir = app({ a: "Hello", b: "Bye" }, { a: "Hallo", b: "Tschüss" });
    init(dir, ["de"]);
    fs.writeFileSync(path.join(dir, "src/app/page.tsx"), page(["a"]));
    const r = runCheck({ rootDir: dir, limit: 50 });
    console.log(`[MT7] ${r.outcome} ${JSON.stringify(r.countsByCode)}`);
    expect(r.countsByCode["orphaned_key"]).toBe(1);
  });

  it("MT8 moving a t() call to another component (meaning change) surfaces context_changed", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": JSON.stringify({ open: "Open" }),
      "src/FileMenu.tsx": `import { useTranslations } from "next-intl"; export function FileMenu(){ const t = useTranslations(); return <menu><button>{t("open")}</button></menu>; }`,
    });
    init(dir, ["de"]);
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "open", value: "Öffnen" }] });
    fs.rmSync(path.join(dir, "src/FileMenu.tsx"));
    fs.writeFileSync(path.join(dir, "src/StoreHours.tsx"), `import { useTranslations } from "next-intl"; export function StoreHours(){ const t = useTranslations(); return <div><span>{t("open")}</span></div>; }`);
    const c = codes(dir);
    console.log(`[MT8] ${JSON.stringify(c)}`);
    expect(c["context_changed"] ?? 0).toBe(1);
  });
});
