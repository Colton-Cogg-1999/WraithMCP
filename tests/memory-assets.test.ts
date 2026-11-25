import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTranslations,
  ensureBootstrapped,
  findFuzzyMatches,
  importAsset,
  initProject,
  lexicalSimilarity,
  lookupMemory,
  WraithStore,
  prepareBatch,
  recordGlossaryTerm,
  runCheck,
  scanProject,
} from "../src/index.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-m3-"));
  tmpDirs.push(dir);
  fs.cpSync(path.resolve("fixtures/nextjs-app"), dir, { recursive: true });
  // Replace Dashboard with a clean i18n file so we isolate staleness & context-change tests
  fs.writeFileSync(
    path.join(dir, "src", "components", "Dashboard.tsx"),
    `import { useTranslations } from "next-intl";
export function FileMenu() {
  const feed = useTranslations("feed");
  return (
    <nav>
      <button>{feed("openMenu")}</button>
      <button>{feed("postHeading")}</button>
      <button>{feed("postAction")}</button>
    </nav>
  );
}
`,
    "utf8"
  );
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Milestone 3: Memory, Fuzzy Matching, Staleness, Context-Change & Importers", () => {
  it("computes accurate word-level (Western) and character-level (CJK) lexical fuzzy scores", () => {
    expect(lexicalSimilarity("Save changes", "Save changes")).toBe(100);
    expect(lexicalSimilarity("Save changes", "Save your changes")).toBeGreaterThanOrEqual(65);
    expect(lexicalSimilarity("Save changes", "Delete account permanently")).toBeLessThan(30);

    // CJK character-level matching via Intl.Segmenter
    expect(lexicalSimilarity("保存更改", "保存更改", "zh-Hans")).toBe(100);
    expect(lexicalSimilarity("保存更改", "保存所有更改", "zh-Hans")).toBeGreaterThanOrEqual(65);
    expect(lexicalSimilarity("保存更改", "删除账户", "zh-Hans")).toBeLessThan(30);

    const matches = findFuzzyMatches(
      "Save your changes",
      [
        {
          sourceLocale: "en",
          targetLocale: "es-MX",
          source: "Save changes",
          target: "Guardar cambios",
          origin: "apply",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          sourceLocale: "en",
          targetLocale: "es-MX",
          source: "Delete account",
          target: "Eliminar cuenta",
          origin: "apply",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { sourceLocale: "en", targetLocale: "es-MX" }
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].target).toBe("Guardar cambios");
    expect(matches[0].score).toBeGreaterThanOrEqual(65);
  });

  it("detects both stale_source AND context_changed when 'Open' moves from FileMenu to StoreHours", () => {
    const dir = makeTempProject();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });
    scanProject({ rootDir: dir });

    applyTranslations({
      rootDir: dir,
      targetLocale: "fr",
      translations: [
        { key: "home.title", value: "Bienvenue sur Acme Pulse" },
        { key: "home.subtitle", value: "Livrez plus vite avec votre équipe." },
        { key: "home.items", value: "{count, plural, one {# élément} many {# éléments} other {# éléments}}" },
        { key: "home.roleBadge", value: "{role, select, admin {Admin ({count, plural, one {# siège} many {# sièges} other {# sièges}})} other {Membre}}" },
        { key: "feed.postHeading", value: "Publication" },
        { key: "feed.postAction", value: "Publication" },
        { key: "feed.openMenu", value: "Ouvrir" },
        { key: "legacy.unusedBanner", value: "Offre terminée vendredi" },
      ],
    });

    // Baseline check has no stale_source or context_changed
    const baseCheck = runCheck({ rootDir: dir });
    expect(baseCheck.countsByCode["stale_source"]).toBeUndefined();
    expect(baseCheck.countsByCode["context_changed"]).toBeUndefined();

    // 1. Source text changes for home.subtitle -> triggers stale_source
    const enPath = path.join(dir, "messages", "en.json");
    const enJson = JSON.parse(fs.readFileSync(enPath, "utf8"));
    enJson.home.subtitle = "Ship twice as fast with your team.";
    fs.writeFileSync(enPath, JSON.stringify(enJson, null, 2) + "\n", "utf8");

    // 2. "Open" (feed.openMenu) keeps IDENTICAL source text, but moves from FileMenu button to StoreHours banner!
    fs.writeFileSync(
      path.join(dir, "src", "components", "Dashboard.tsx"),
      `import { useTranslations } from "next-intl";
export function StoreHoursBanner() {
  const feed = useTranslations("feed");
  return (
    <aside>
      <span>{feed("openMenu")}</span>
      <button>{feed("postHeading")}</button>
      <button>{feed("postAction")}</button>
    </aside>
  );
}
`,
      "utf8"
    );

    const afterCheck = runCheck({ rootDir: dir });
    expect(afterCheck.countsByCode["stale_source"]).toBe(1);
    expect(afterCheck.countsByCode["context_changed"]).toBeGreaterThanOrEqual(1);
    expect(
      afterCheck.issues.items.some(
        (i) => i.code === "context_changed" && i.key === "feed.openMenu" && i.locale === "fr"
      )
    ).toBe(true);

    // prepare() surfaces both stale_source and context_changed items
    const prep = prepareBatch({ rootDir: dir, targetLocale: "fr" });
    expect(prep.items.some((i) => i.key === "home.subtitle" && i.reason === "stale_source")).toBe(
      true
    );
    expect(prep.items.some((i) => i.key === "feed.openMenu" && i.reason === "context_changed")).toBe(
      true
    );
  });

  it("propagates glossary changes to every affected key and flags their records", () => {
    const dir = makeTempProject();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
    applyTranslations({
      rootDir: dir,
      targetLocale: "es-MX",
      translations: [
        { key: "feed.postHeading", value: "Entrada" },
        { key: "feed.postAction", value: "Entrada" },
      ],
    });

    const prop = recordGlossaryTerm(dir, {
      term: "Post",
      translations: { "es-MX": "Publicación" },
      notes: "Use Publicación consistently across feed UI",
      origin: "user",
    });

    expect(prop.changed).toBe(true);
    expect(prop.affectedKeys.map((a) => a.key)).toEqual(["feed.postAction", "feed.postHeading"]);
    expect(prop.flaggedRecords).toBe(2);

    // prepare() now surfaces those flagged keys with the updated glossary hit
    const prep = prepareBatch({ rootDir: dir, targetLocale: "es-MX" });
    const postItem = prep.items.find((i) => i.key === "feed.postHeading");
    expect(postItem?.reason).toBe("flagged");
    expect(postItem?.glossaryHits[0]?.preferredTranslation).toBe("Publicación");
  });

  it("imports CSV glossary, TBX glossary, TMX translation memory, and existing locale files", () => {
    const dir = makeTempProject();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX", "fr"], writeAgentRule: false });

    // CSV glossary
    const csvPath = path.join(dir, "glossary.csv");
    fs.writeFileSync(
      csvPath,
      `term,es-MX,fr,notes,doNotTranslate\n"Workspace","Espacio de trabajo","Espace de travail","Team area",false\n"Acme Pulse","","","Brand",true\n`,
      "utf8"
    );
    const csvRes = importAsset(dir, { file: csvPath });
    expect(csvRes.format).toBe("csv");
    expect(csvRes.glossaryImported).toBe(2);

    // TBX glossary
    const tbxPath = path.join(dir, "terms.tbx");
    fs.writeFileSync(
      tbxPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<martif type="TBX-Basic">
  <text><body>
    <termEntry id="t1">
      <note>Primary navigation bar</note>
      <langSet xml:lang="en"><tig><term>Dashboard</term></tig></langSet>
      <langSet xml:lang="es-MX"><tig><term>Panel</term></tig></langSet>
      <langSet xml:lang="fr"><tig><term>Tableau de bord</term></tig></langSet>
    </termEntry>
  </body></text>
</martif>`,
      "utf8"
    );
    const tbxRes = importAsset(dir, { file: tbxPath });
    expect(tbxRes.format).toBe("tbx");
    expect(tbxRes.glossaryImported).toBe(1);

    // TMX translation memory
    const tmxPath = path.join(dir, "legacy.tmx");
    fs.writeFileSync(
      tmxPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <header srclang="en"/>
  <body>
    <tu>
      <tuv xml:lang="en"><seg>Ship faster with your team.</seg></tuv>
      <tuv xml:lang="es-MX"><seg>Lanza más rápido con tu equipo.</seg></tuv>
      <tuv xml:lang="fr"><seg>Livrez plus vite avec votre équipe.</seg></tuv>
    </tu>
  </body>
</tmx>`,
      "utf8"
    );
    const tmxRes = importAsset(dir, { file: tmxPath });
    expect(tmxRes.format).toBe("tmx");
    expect(tmxRes.memoryImported).toBe(2);

    // Memory lookup finds both glossary & TMX fuzzy match
    const lookup = lookupMemory(dir, {
      query: "Ship faster with your team.",
      targetLocale: "es-MX",
    });
    expect(lookup.fuzzyMatches[0]?.score).toBe(100);
    expect(lookup.fuzzyMatches[0]?.target).toBe("Lanza más rápido con tu equipo.");

    const gLookup = lookupMemory(dir, { query: "Dashboard", targetLocale: "fr" });
    expect(gLookup.glossaryHits[0]?.preferredTranslation).toBe("Tableau de bord");

    // Existing locale files import
    fs.writeFileSync(
      path.join(dir, "messages", "es-MX.json"),
      JSON.stringify({ home: { title: "Bienvenido a Acme Pulse" } }, null, 2),
      "utf8"
    );
    const locRes = importAsset(dir, { format: "locales" });
    expect(locRes.recordsImported).toBe(1);
    const store = new WraithStore(dir);
    expect(store.readRecords().records["home.title"]["es-MX"].origin).toBe("imported");
  });
});
