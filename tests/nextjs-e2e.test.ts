import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTranslations,
  ensureBootstrapped,
  generatePseudoLocale,
  generateReport,
  getProjectStatus,
  initProject,
  JsonFormatAdapter,
  PolyglotStore,
  prepareBatch,
  pseudoLocalizeString,
  runCheck,
  scanProject,
  validateTranslationString,
} from "../src/index.js";

ensureBootstrapped();

const FIXTURE_DIR = path.resolve("fixtures/nextjs-app");
const tmpDirs: string[] = [];

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-nextjs-"));
  tmpDirs.push(dir);
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Milestone 2: React / Next.js End-to-End Pipeline", () => {
  it("scans Next.js fixture and catches hardcoded JSX, attributes, toasts, concatenations, and usage sites", () => {
    const dir = copyFixture();
    initProject({
      rootDir: dir,
      sourceLocale: "en",
      targetLocales: ["es-MX", "fr", "zh-Hans"],
      writeAgentRule: false,
    });

    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("nextjs");
    expect(scan.i18nLibrary).toBe("next-intl");
    expect(scan.sourceKeys).toBe(8);

    // Hardcoded strings: JSX text, aria-label, placeholder, title, toast.success
    const texts = scan.hardcodedStrings.items.map((h) => h.text);
    expect(texts).toContain("Save settings");
    expect(texts).toContain("Close notification banner");
    expect(texts).toContain("Search your workspace");
    expect(texts).toContain("Workspace search box");
    expect(texts).toContain("Changes saved successfully");

    // Concatenations: '+' and template literal
    expect(scan.counts.concatenations).toBeGreaterThanOrEqual(2);

    // Tracked usage sites (namespaced via useTranslations)
    expect(scan.counts.trackedKeys).toBe(7);

    // Brand name inferred
    expect(scan.glossaryCandidates.some((c) => c.term === "Acme Pulse" && c.doNotTranslate)).toBe(
      true
    );
  });

  it("losslessly writes JSON locale files preserving key order, indentation, and trailing newline", () => {
    const dir = copyFixture();
    const adapter = new JsonFormatAdapter();
    const file = path.join(dir, "messages", "custom.json");
    const original = `{\n    "zKey": "First",\n    "aKey": "Second"\n}\n`;
    fs.writeFileSync(file, original, "utf8");

    const updated = adapter.applyUpdates(
      file,
      "es-MX",
      [{ key: "aKey", value: "Segundo" }],
      { write: true }
    );

    // Order zKey -> aKey preserved, 4-space indent preserved, trailing newline preserved
    expect(updated).toBe(`{\n    "zKey": "First",\n    "aKey": "Segundo"\n}\n`);
  });

  it("rejects broken ICU syntax, missing placeholders, missing CLDR plurals, and DNT violations in apply()", () => {
    const dir = copyFixture();
    initProject({
      rootDir: dir,
      sourceLocale: "en",
      targetLocales: ["es-MX", "ru"],
      writeAgentRule: false,
    });
    const store = new PolyglotStore(dir);
    store.upsertGlossaryEntry({
      term: "Acme Pulse",
      doNotTranslate: true,
      caseSensitive: true,
      translations: {},
      origin: "inferred",
    });

    // Broken ICU + DNT violation + Russian missing few/many plural categories
    const badRes = applyTranslations({
      rootDir: dir,
      targetLocale: "ru",
      translations: [
        { key: "home.title", value: "Добро пожаловать в Акме Пульс" }, // DNT violated
        { key: "home.items", value: "{count, plural, one {# элемент} other {# элементов}}" }, // missing few/many for Russian
        { key: "home.roleBadge", value: "{role, select, admin {Админ" }, // broken ICU syntax
      ],
    });

    expect(badRes.ok).toBe(false);
    expect(badRes.appliedCount).toBe(0);
    expect(badRes.rejectedCount).toBe(3);
    const codes = badRes.errors.map((e) => e.code);
    expect(codes).toContain("dnt_violation");
    expect(codes).toContain("missing_plural_category");
    expect(codes).toContain("icu_syntax_error");
  });

  it("validates placeholders across double-mustache and nested ICU", () => {
    const missing = validateTranslationString(
      "Hello {{name}}, you have {{count}} alerts",
      "Hola {{name}}",
      "es-MX",
      ["double-mustache"]
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].code).toBe("placeholder_mismatch");

    // Corrected per P0-3 / Audit C2: Spanish everyday cardinal plurals require ["one", "other"];
    // CLDR's 'many' (used only for exact millions 1_000_000+) is advisory, NOT mandatory.
    const nestedOk = validateTranslationString(
      "{role, select, admin {Admin ({count, plural, one {# seat} other {# seats}})} other {Member}}",
      "{role, select, admin {Administrador ({count, plural, one {# asiento} other {# asientos}})} other {Miembro}}",
      "es-MX",
      ["icu"]
    );
    expect(nestedOk).toEqual([]);
  });

  it("generates pseudo-locale preserving ICU placeholders and expanding length ~30-40%", () => {
    const src = "{count, plural, one {# item for {name}} other {# items for {name}}}";
    const pseudo = pseudoLocalizeString(src, ["icu"]);
    expect(pseudo.startsWith("[")).toBe(true);
    expect(pseudo.endsWith("]")).toBe(true);
    expect(pseudo).toContain("{name}");
    expect(validateTranslationString(src, pseudo, "en-x-pseudo", ["icu"])).toEqual([]);

    const dir = copyFixture();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
    const res = generatePseudoLocale(dir);
    expect(res.keysGenerated).toBe(8);
    expect(fs.existsSync(path.join(dir, "messages", "en-x-pseudo.json"))).toBe(true);
  });

  it("runs the full first-run flow: scan -> prepare -> apply -> check (catches traps) -> fix -> clean report", () => {
    const dir = copyFixture();
    initProject({
      rootDir: dir,
      sourceLocale: "en",
      targetLocales: ["es-MX"],
      writeAgentRule: false,
    });
    const store = new PolyglotStore(dir);
    store.upsertGlossaryEntry({
      term: "Acme Pulse",
      doNotTranslate: true,
      caseSensitive: true,
      translations: {},
      origin: "inferred",
    });
    store.addAssumption({
      category: "brand",
      summary: 'Kept "Acme Pulse" untranslated across all locales.',
    });
    store.addAssumption({
      category: "tone",
      locale: "es-MX",
      summary: 'Used informal "tú" register for es-MX.',
    });

    // Step 1: Scan populates usage.json
    scanProject({ rootDir: dir });

    // Step 2: Prepare returns context, usage sites, glossary hits, conventions
    // Everyday cardinal plurals for es-MX are ["one", "other"] (CLDR 'many' is advisory)
    const prep = prepareBatch({ rootDir: dir, targetLocale: "es-MX" });
    expect(prep.totalPending).toBe(8);
    expect(prep.conventions.pluralCategories).toEqual(["one", "other"]);
    expect(prep.conventions.advisoryPluralCategories).toContain("many");
    const titleItem = prep.items.find((i) => i.key === "home.title");
    expect(titleItem?.glossaryHits.some((g) => g.term === "Acme Pulse")).toBe(true);
    expect(titleItem?.usageSites[0]?.component).toBe("Dashboard");

    // Step 3: Apply translations (deliberately translating "Post" inconsistently!)
    const applyRes = applyTranslations({
      rootDir: dir,
      targetLocale: "es-MX",
      translations: [
        { key: "home.title", value: "Bienvenido a Acme Pulse" },
        { key: "home.subtitle", value: "Envía más rápido con tu equipo." },
        {
          key: "home.items",
          value:
            "{count, plural, one {# elemento en tu bandeja} many {# elementos en tu bandeja} other {# elementos en tu bandeja}}",
        },
        {
          key: "home.roleBadge",
          value:
            "{role, select, admin {Administrador ({count, plural, one {# asiento} many {# asientos} other {# asientos}})} other {Miembro}}",
        },
        { key: "feed.postHeading", value: "Entrada" },
        { key: "feed.postAction", value: "Publicar" },
        { key: "feed.openMenu", value: "Abrir" },
        { key: "legacy.unusedBanner", value: "La oferta termina el viernes" },
      ],
    });
    expect(applyRes.ok).toBe(true);
    expect(applyRes.appliedCount).toBe(8);

    // Step 4: Check catches hardcoded strings, concatenations, orphaned key, AND inconsistent "Post"
    const check1 = runCheck({ rootDir: dir });
    expect(check1.passed).toBe(false);
    expect(check1.countsByCode["hardcoded_string"]).toBeGreaterThanOrEqual(5);
    expect(check1.countsByCode["string_concatenation"]).toBeGreaterThanOrEqual(2);
    expect(check1.countsByCode["orphaned_key"]).toBe(1);
    expect(check1.countsByCode["glossary_inconsistency"]).toBe(1);

    // Step 5: Simulate agent refactoring Dashboard.tsx cleanly (removing hardcoded strings/concats)
    fs.writeFileSync(
      path.join(dir, "src", "components", "Dashboard.tsx"),
      `import { useTranslations } from "next-intl";
export function Dashboard({ count, role }: { count: number; role: string }) {
  const t = useTranslations("home");
  const feed = useTranslations("feed");
  const legacy = useTranslations("legacy");
  return (
    <main>
      <h1>{t("title")}</h1>
      <p>{t("subtitle")}</p>
      <p>{t("items", { count })}</p>
      <span>{t("roleBadge", { role, count })}</span>
      <h2>{feed("postHeading")}</h2>
      <button>{feed("postAction")}</button>
      <button>{feed("openMenu")}</button>
      <p>{legacy("unusedBanner")}</p>
    </main>
  );
}
`,
      "utf8"
    );

    const check2 = runCheck({ rootDir: dir });
    expect(check2.passed).toBe(true);
    expect(check2.errorCount).toBe(0);

    // Status reflects clean check & 100% coverage
    const st = getProjectStatus(dir);
    expect(st.checkPassed).toBe(true);
    expect(st.locales[0].coveragePct).toBe(100);

    // Step 6: Report surfaces assumptions and strings worth a native speaker's look
    const rep = generateReport(dir);
    expect(rep.checkPassed).toBe(true);
    expect(rep.assumptions).toHaveLength(2);
    expect(rep.reviewList.length).toBeGreaterThanOrEqual(1);
    expect(rep.markdown).toContain("## Polyglot Localization Report");
    expect(rep.markdown).toContain("Assumptions Made");
  });
});
