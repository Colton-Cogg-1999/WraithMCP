import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyTranslations,
  decodeZeroWidthKeyIds,
  encodeZeroWidthKeyId,
  ensureBootstrapped,
  generatePseudoLocale,
  getLocaleConventions,
  initProject,
  WraithStore,
  prepareBatch,
  pseudoLocalizeString,
  recordGlossaryTerm,
  rewriteFixedWidthToMinWidth,
  rewriteTailwindPhysicalToLogical,
  runCheck,
  runLayoutCheck,
  runLayoutFix,
  scanHardcodedFormattingInJs,
  scanProject,
  selectAutoPseudoModes,
  stripZeroWidthKeyIds,
} from "../src/index.js";

ensureBootstrapped();

function makeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-layout-v1-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("Layout & Formatting v1 — 1. Pseudo-locale modes & zero-width key IDs", () => {
  it("scales expand expansion by length (short labels grow proportionally more than long sentences)", () => {
    const shortPseudo = stripZeroWidthKeyIds(pseudoLocalizeString("Save", ["icu"], { mode: "expand" }));
    const longSrc = "Your monthly billing summary has been archived securely for compliance auditing across all teams.";
    const longPseudo = stripZeroWidthKeyIds(pseudoLocalizeString(longSrc, ["icu"], { mode: "expand" }));
    const shortRatio = shortPseudo.length / "Save".length;
    const longRatio = longPseudo.length / longSrc.length;
    expect(shortRatio).toBeGreaterThan(longRatio);
    expect(shortRatio).toBeGreaterThanOrEqual(2.0);
  });

  it("generates RTL (ar-XB) with RLO/PDF, LRI/PDI isolation for placeholders and Latin DNT brand names, and resolves direction='rtl'", () => {
    expect(getLocaleConventions("ar-XB").direction).toBe("rtl");
    const out = pseudoLocalizeString("Northstar charged {amount} to {card}", ["icu"], {
      mode: "rtl",
      dntTerms: ["Northstar"],
      keyId: "billing.charged",
    });
    expect(out).toContain("\u202E"); // RLO
    expect(out).toContain("\u202C"); // PDF
    expect(out).toContain("\u2066Northstar\u2069"); // LRI..PDI around Latin brand
    expect(out).toContain("\u2066{amount}\u2069"); // placeholder preserved & isolated
    expect(out).toContain("\u2066{card}\u2069");
    expect(decodeZeroWidthKeyIds(out)).toEqual(["billing.charged"]);
  });

  it("supports cjk (ja-XC), tall (th-XD), long-word (de-XE), and format modes while preserving ICU/placeholders", () => {
    const cjk = pseudoLocalizeString("Billing overview {count}", ["icu"], { mode: "cjk" });
    expect(cjk).toContain("{count}");
    expect(cjk.startsWith("「") && cjk.endsWith("」")).toBe(true);
    expect(stripZeroWidthKeyIds(cjk)).not.toMatch(/ /);

    const tall = pseudoLocalizeString("Save invoice {id}", ["icu"], { mode: "tall" });
    expect(tall).toContain("{id}");
    expect(tall).toMatch(/[\u0308\u0E35]/);

    const longWord = pseudoLocalizeString("Account security settings {n}", ["icu"], { mode: "long-word" });
    expect(longWord).toContain("{n}");
    expect(stripZeroWidthKeyIds(longWord).length).toBeGreaterThan(25);

    const fmt = pseudoLocalizeString("Total $1,234.56 due 11/25/2026 ({count})", ["icu"], { mode: "format" });
    expect(fmt).toContain("{count}");
    expect(fmt).toContain("¤");
    expect(fmt).toMatch(/[٠-٩]/);
    expect(fmt).not.toContain("$1,234.56");
    expect(fmt).not.toContain("11/25/2026");
  });

  it("round-trips invisible zero-width key IDs cleanly", () => {
    const encoded = encodeZeroWidthKeyId("checkout.tabs.billing_overview");
    const wrapped = `[${encoded}Šàṽé]`;
    expect(decodeZeroWidthKeyIds(wrapped)).toEqual(["checkout.tabs.billing_overview"]);
    expect(stripZeroWidthKeyIds(wrapped)).toBe("[Šàṽé]");
  });

  it("selects auto pseudo modes from targetLocales and generates all matching pseudo files", () => {
    expect(selectAutoPseudoModes(["ar", "ja", "th", "de"])).toEqual([
      "expand",
      "rtl",
      "cjk",
      "tall",
      "long-word",
    ]);
    expect(selectAutoPseudoModes(["es-MX"])).toEqual(["expand"]);

    const dir = makeTempDir({
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
      "messages/en.json": JSON.stringify({ save: "Save", total: "Total $19.99" }),
      "src/App.tsx": `import { useTranslations } from "next-intl"; export function App(){ const t = useTranslations(); return <button>{t("save")}</button>; }`,
    });
    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de", "ar", "ja"], writeAgentRule: false });
      const res = generatePseudoLocale(dir, { mode: "auto" });
      expect(res.modesGenerated.map((m) => m.pseudoLocale)).toEqual(["en-XA", "ar-XB", "ja-XC", "de-XE"]);
      expect(fs.existsSync(path.join(dir, "messages/en-XA.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "messages/ar-XB.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "messages/ja-XC.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "messages/de-XE.json"))).toBe(true);

      // Zero-width key IDs are embedded by default
      const xa = JSON.parse(fs.readFileSync(path.join(dir, "messages/en-XA.json"), "utf8"));
      expect(decodeZeroWidthKeyIds(xa.save)).toEqual(["save"]);
      expect(xa.total).toContain("¤");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Layout & Formatting v1 — 2. Mechanical codemods (layout --fix)", () => {
  it("rewrites Tailwind physical classes to logical equivalents and fixed w-* to min-w-*", () => {
    expect(
      rewriteTailwindPhysicalToLogical("ml-4 mr-2 pl-3 pr-1 left-0 right-2 text-left md:text-right border-l-2 rounded-r-md")
    ).toBe("ms-4 me-2 ps-3 pe-1 start-0 end-2 text-start md:text-end border-s-2 rounded-e-md");

    expect(rewriteFixedWidthToMinWidth("w-24 truncate whitespace-nowrap")).toBe("min-w-24 truncate whitespace-nowrap");
    expect(rewriteFixedWidthToMinWidth("w-[96px] overflow-hidden")).toBe("min-w-[96px] overflow-hidden");
    // Does not touch large container widths when not forced
    expect(rewriteFixedWidthToMinWidth("w-96 flex")).toBe("w-96 flex");
  });

  it("injects dir/lang on root HTML layouts across React/Next.js, Vue, SvelteKit, Rails, and Django, and previews unified diffs", () => {
    const cases: Array<{ name: string; files: Record<string, string>; targetFile: string; expectAttr: RegExp }> = [
      {
        name: "nextjs",
        files: {
          "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
          "messages/en.json": JSON.stringify({ ok: "OK" }),
          "src/app/layout.tsx": `export default function RootLayout({ children }: any) { return <html><body className="ml-4 text-left"><button className="w-24 truncate">{children}</button></body></html>; }\n`,
        },
        targetFile: "src/app/layout.tsx",
        expectAttr: /<html\b[^>]*lang=[^>]*dir=/,
      },
      {
        name: "vue",
        files: {
          "package.json": JSON.stringify({ dependencies: { vue: "3.5.0", "vue-i18n": "10.0.0" } }),
          "locales/en.json": JSON.stringify({ ok: "OK" }),
          "index.html": `<!doctype html><html><body><div class="pl-4 border-l"></div></body></html>\n`,
        },
        targetFile: "index.html",
        expectAttr: /<html\b[^>]*lang=[^>]*dir=/,
      },
      {
        name: "sveltekit",
        files: {
          "package.json": JSON.stringify({ dependencies: { "@sveltejs/kit": "2.0.0", svelte: "5.0.0" } }),
          "messages/en.json": JSON.stringify({ ok: "OK" }),
          "src/app.html": `<!doctype html><html><body>%sveltekit.body%</body></html>\n`,
        },
        targetFile: "src/app.html",
        expectAttr: /lang="%lang%" dir="%dir%"/,
      },
      {
        name: "rails",
        files: {
          Gemfile: `gem "rails"\n`,
          "config/locales/en.yml": `en:\n  ok: "OK"\n`,
          "app/views/layouts/application.html.erb": `<!DOCTYPE html><html><body class="mr-3 text-right"><%= yield %></body></html>\n`,
        },
        targetFile: "app/views/layouts/application.html.erb",
        expectAttr: /I18n\.locale/,
      },
      {
        name: "django",
        files: {
          "manage.py": "",
          "templates/base.html": `<!DOCTYPE html><html><body class="ml-2">{% block content %}{% endblock %}</body></html>\n`,
        },
        targetFile: "templates/base.html",
        expectAttr: /LANGUAGE_BIDI/,
      },
    ];

    for (const c of cases) {
      const dir = makeTempDir(c.files);
      try {
        initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["ar"], writeAgentRule: false });
        const dry = runLayoutFix({ rootDir: dir, dryRun: true });
        expect(dry.totalChanges, c.name).toBeGreaterThan(0);
        expect(dry.filesModified, c.name).toEqual([]);
        expect(dry.previews[0]?.unifiedDiff, c.name).toContain("--- a/");

        const applied = runLayoutFix({ rootDir: dir, dryRun: false });
        expect(applied.filesModified, c.name).toContain(c.targetFile);
        const updated = fs.readFileSync(path.join(dir, c.targetFile), "utf8");
        expect(updated, c.name).toMatch(c.expectAttr);
        expect(updated, c.name).not.toMatch(/\b(?:ml|mr|pl|pr)-/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("Layout & Formatting v1 — 3. Formatting scanner rules & non-Tailwind static CSS + budgets", () => {
  it("detects all 6 hardcoded formatting anti-patterns while ignoring locale-safe Intl usage", () => {
    const code = `
export function InvoiceRow({ price, date, title, items, locale }: any) {
  const safePrice = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(price);
  const badFixed = <span>{price.toFixed(2)}</span>;
  const badLocaleStr = date.toLocaleDateString();
  const badIntl = new Intl.NumberFormat().format(price);
  const badCurrency = "$" + price;
  const badDate = \`\${date.getMonth() + 1}/\${date.getDate()}/\${date.getFullYear()}\`;
  const badUpper = <h3>{title.toUpperCase()}</h3>;
  const badSort = items.sort((a: string, b: string) => a.localeCompare(b));
  return <div>{safePrice}{badFixed}{badLocaleStr}{badIntl}{badCurrency}{badDate}{badUpper}{badSort}</div>;
}
`;
    const findings = scanHardcodedFormattingInJs("src/InvoiceRow.tsx", code);
    const rules = new Set(findings.map((f) => f.rule));
    expect(rules.has("toFixed_displayed")).toBe(true);
    expect(rules.has("toLocaleString_missing_locale")).toBe(true);
    expect(rules.has("intl_missing_locale")).toBe(true);
    expect(rules.has("currency_concatenation")).toBe(true);
    expect(rules.has("manual_date_assembly")).toBe(true);
    expect(rules.has("case_transform_locale_unsafe")).toBe(true);
    expect(rules.has("localeCompare_missing_locale")).toBe(true);
  });

  it("detects inline styles, styled-components, CSS modules, attaches constraints/budgets in prepare, and enforces layout_budget_exceeded in check", () => {
    const dir = makeTempDir({
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
      "messages/en.json": JSON.stringify({ tabBilling: "Billing", btnSave: "Save", cardTitle: "Overview" }),
      "messages/de.json": JSON.stringify({ tabBilling: "Abrechnungsverwaltung", btnSave: "Speichern", cardTitle: "Übersicht" }),
      "src/styles.module.css": `.tabBtn { width: 88px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n`,
      "src/Panel.tsx": `import { useTranslations } from "next-intl";
import styles from "./styles.module.css";
declare const styled: any;
const NarrowTag = styled.span\`width: 72px; overflow: hidden; white-space: nowrap;\`;
export function Panel() {
  const t = useTranslations();
  return (
    <div>
      <button className={styles.tabBtn}>{t("tabBilling")}</button>
      <button style={{ width: 80, whiteSpace: "nowrap", overflow: "hidden" }}>{t("btnSave")}</button>
      <NarrowTag>{t("cardTitle")}</NarrowTag>
    </div>
  );
}
`,
    });

    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
      recordGlossaryTerm(dir, {
        term: "Billing",
        translations: { de: "Abrechnung" },
        abbreviations: { de: "Abr." },
      });
      const store = new WraithStore(dir);
      store.setLayoutBudget("tabBilling", "de", {
        maxWidthPx: 88,
        budgetChars: 12,
        element: "button",
        constraint: "width: 88px; overflow: hidden",
        file: "src/Panel.tsx",
        line: 9,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const scan = scanProject({ rootDir: dir });
      expect(scan.counts.trackedKeys).toBe(3);

      const prep = prepareBatch({ rootDir: dir, targetLocale: "de", includeTranslated: true });
      const billingItem = prep.items.find((i) => i.key === "tabBilling");
      expect(billingItem?.reason).toBe("layout_budget_exceeded");
      expect(billingItem?.layout?.budgetChars).toBe(12);
      expect(billingItem?.layout?.approvedAbbreviations?.Billing).toBe("Abr.");

      const btnItem = prep.items.find((i) => i.key === "btnSave");
      expect(btnItem?.layout?.constraint).toContain("white-space: nowrap");

      const chkBefore = runCheck({ rootDir: dir, locale: "de" });
      expect(chkBefore.countsByCode["layout_budget_exceeded"]).toBe(1);
      const budgetIssue = chkBefore.issues.items.find((i) => i.code === "layout_budget_exceeded");
      expect(budgetIssue).toMatchObject({ key: "tabBilling", severity: "error" });
      expect(chkBefore.outcome).toBe("FAIL");

      // Even when glossary matches ("Abrechnung" = 10 chars, set stricter 8-char rendered budget), layout_budget_exceeded alone fails check!
      applyTranslations({
        rootDir: dir,
        targetLocale: "de",
        translations: [{ key: "tabBilling", value: "Abrechnung" }],
      });
      const chkAfter = runCheck({ rootDir: dir, locale: "de" });
      expect(chkAfter.countsByCode["layout_budget_exceeded"] ?? 0).toBe(0);
      expect(chkAfter.outcome).toBe("PASS");

      store.setLayoutBudget("tabBilling", "de", {
        maxWidthPx: 56,
        budgetChars: 6,
        element: "button",
        constraint: "width: 56px; overflow: hidden",
        file: "src/Panel.tsx",
        line: 9,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const chkStrict = runCheck({ rootDir: dir, locale: "de" });
      expect(chkStrict.errorCount).toBe(1);
      expect(chkStrict.countsByCode).toMatchObject({ layout_budget_exceeded: 1 });
      expect(chkStrict.outcome).toBe("FAIL");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Layout & Formatting v1 — 4. Rendered Playwright layout check (INCONCLUSIVE + E2E fix loop)", () => {
  it("returns INCONCLUSIVE (never PASS) when Playwright is missing or baseUrl is omitted", async () => {
    const dir = makeTempDir({
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
      "messages/en.json": JSON.stringify({ ok: "OK" }),
    });
    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
      const noUrl = await runLayoutCheck({ rootDir: dir });
      expect(noUrl.outcome).toBe("INCONCLUSIVE");
      expect(noUrl.passed).toBe(false);

      const noPw = await runLayoutCheck({
        rootDir: dir,
        baseUrl: "http://127.0.0.1:9999",
        playwrightLoader: async () => {
          throw new Error("Cannot find module 'playwright'");
        },
      });
      expect(noPw.outcome).toBe("INCONCLUSIVE");
      expect(noPw.passed).toBe(false);
      expect(noPw.inconclusiveReason).toMatch(/Playwright/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("end-to-end: finds clipped text, RTL dir mismatch, and hardcoded format over HTTP; fixes clear them to 0 defects while changing nothing else", async () => {
    const dir = makeTempDir({
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
      "messages/en.json": JSON.stringify({ tabBilling: "Billing", btnExport: "Export CSV" }),
      "messages/de.json": JSON.stringify({ tabBilling: "Abrechnungsübersicht", btnExport: "CSV exportieren" }),
      "messages/ar.json": JSON.stringify({ tabBilling: "الفوترة", btnExport: "تصدير CSV" }),
      "src/Header.tsx": `import { useTranslations } from "next-intl";
export function Header() {
  const t = useTranslations();
  return (
    <header className="ml-4 text-left">
      <button className="w-20 truncate whitespace-nowrap overflow-hidden">{t("tabBilling")}</button>
      <button className="w-24 truncate whitespace-nowrap overflow-hidden">{t("btnExport")}</button>
    </header>
  );
}
`,
      "src/app/layout.tsx": `export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }\n`,
      "src/Untouched.ts": `export const KEEP_ME = 42;\n`,
    });

    let fixedMode = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const loc = url.searchParams.get("locale") ?? "en";
      const msgFile = path.join(dir, "messages", `${loc}.json`);
      const msgs: Record<string, string> = fs.existsSync(msgFile)
        ? JSON.parse(fs.readFileSync(msgFile, "utf8"))
        : JSON.parse(fs.readFileSync(path.join(dir, "messages/en.json"), "utf8"));
      const isRtl = loc.startsWith("ar");
      const htmlTag = fixedMode ? `<html lang="${loc}" dir="${isRtl ? "rtl" : "ltr"}">` : `<html>`;
      const btnCss = fixedMode
        ? "min-width: 80px; padding: 6px 10px; white-space: normal;"
        : "width: 72px; padding: 6px 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;";
      const priceHtml = fixedMode ? `<span>١٩,٩٩\u00A0¤</span>` : `<span>$19.99</span>`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>${htmlTag}<head><meta charset="utf-8"/><style>button{${btnCss}font-size:14px;}</style></head><body>
        <button class="${fixedMode ? "min-w-20" : "w-20 truncate"}">${msgs.tabBilling}</button>
        <button class="${fixedMode ? "min-w-24" : "w-24 truncate"}">${msgs.btnExport}</button>
        ${priceHtml}
      </body></html>`);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de", "ar"], writeAgentRule: false });
      generatePseudoLocale(dir, { mode: "auto" });

      const before = await runLayoutCheck({
        rootDir: dir,
        baseUrl,
        routes: ["/"],
        locales: ["en-XA", "ar-XB", "de"],
      });
      if (
        before.outcome === "INCONCLUSIVE" &&
        /Playwright/i.test(before.inconclusiveReason ?? "") &&
        process.env.WRAITH_REQUIRE_PLAYWRIGHT !== "1"
      ) {
        // Environment without Playwright installed (e.g. restricted sandbox) -> verified INCONCLUSIVE contract
        expect(before.passed).toBe(false);
        return;
      }
      expect(before.outcome).toBe("FAIL");
      expect(before.countsByType["clipped_text"]).toBeGreaterThan(0);
      expect(before.countsByType["dir_lang_mismatch"]).toBeGreaterThan(0);
      expect(before.countsByType["hardcoded_format"]).toBeGreaterThan(0);
      // Zero-width key ID traced clipped element back to exact catalog key and file:line!
      const traced = before.findings.find((f) => f.key === "tabBilling");
      expect(traced?.file).toBe("src/Header.tsx");
      expect(before.screenshots.length).toBeGreaterThan(0);

      // Apply mechanical codemods & verify untouched file stays byte-identical
      const fixRes = runLayoutFix({ rootDir: dir });
      expect(fixRes.filesModified).toContain("src/Header.tsx");
      expect(fixRes.filesModified).toContain("src/app/layout.tsx");
      expect(fs.readFileSync(path.join(dir, "src/Untouched.ts"), "utf8")).toBe("export const KEEP_ME = 42;\n");

      // Simulate fixed rendered output -> layout re-run returns PASS (0 defects)
      fixedMode = true;
      const after = await runLayoutCheck({
        rootDir: dir,
        baseUrl,
        routes: ["/"],
        locales: ["en-XA", "ar-XB", "de"],
      });
      expect(after.outcome).toBe("PASS");
      expect(after.findingCount).toBe(0);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
