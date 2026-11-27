import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { initProject } from "../src/core/init.js";
import { CONTEXT_GUIDANCE, prepareBatch } from "../src/core/prepare.js";
import { prepareQeReview, QE_REVIEW_INSTRUCTIONS } from "../src/core/qe.js";
import { scanProject } from "../src/core/scan.js";
import { WraithStore } from "../src/core/store.js";
import { prepareDocument } from "../src/documents/registry.js";

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function scaffoldMinimalReactApp(dir: string) {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "style-test", dependencies: { react: "^19.0.0", i18next: "^23.0.0" } })
  );
  fs.writeFileSync(
    path.join(dir, "messages/en.json"),
    JSON.stringify({ hero: { cta: "Get started" } }, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(dir, "src/App.tsx"),
    `import { t } from "i18next";\nexport function App() { return <button>{t("hero.cta")}</button>; }\n`
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# Welcome\n\nPlease read our billing guide.\n");
}

describe("Style guide and additive translation/QE prompts", () => {
  it("omits styleGuide and leaves base guidance untouched when unconfigured", () => {
    const dir = mkTmp("wraith-style-none-");
    scaffoldMinimalReactApp(dir);
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    scanProject({ rootDir: dir });

    const prep = prepareBatch({ rootDir: dir, targetLocale: "de" });
    expect(prep.styleGuide).toBeUndefined();
    expect(prep.contextGuidance).toBe(CONTEXT_GUIDANCE);
  });

  it("auto-discovers .wraith/STYLE_GUIDE.md and builds upon system guidance across prepare, QE, and documents", () => {
    const dir = mkTmp("wraith-style-full-");
    scaffoldMinimalReactApp(dir);
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de", "es-MX"], writeAgentRule: false });

    // Drop .wraith/STYLE_GUIDE.md + add config.styleGuide prompts & locale overrides
    fs.writeFileSync(
      path.join(dir, ".wraith/STYLE_GUIDE.md"),
      "# Brand Voice\n- Friendly, concise, active voice.\n- Never use exclamation marks in buttons.\n"
    );
    const store = new WraithStore(dir);
    const cfg = store.readConfig();
    cfg.styleGuide = {
      instructions: "Prefer short verbs for CTAs.",
      translationPrompt: "Always check whether the CTA fits mobile widths.",
      qePrompt: "Flag any exclamation mark inside a button label.",
      byLocale: {
        de: "Use informal 'du' register.",
        es: "Avoid Peninsular slang.",
        "es-MX": "Use Mexican Spanish vocabulary (tableta, computadora).",
      },
    };
    store.writeConfig(cfg);
    scanProject({ rootDir: dir });

    // 1. prepareBatch preserves CONTEXT_GUIDANCE verbatim AND appends style guide + locale rule + translationPrompt
    const prepDe = prepareBatch({ rootDir: dir, targetLocale: "de" });
    expect(prepDe.styleGuide?.hasAny).toBe(true);
    expect(prepDe.styleGuide?.file).toBe(".wraith/STYLE_GUIDE.md");
    expect(prepDe.contextGuidance.startsWith(CONTEXT_GUIDANCE)).toBe(true);
    expect(prepDe.contextGuidance).toContain("Friendly, concise, active voice.");
    expect(prepDe.contextGuidance).toContain("Prefer short verbs for CTAs.");
    expect(prepDe.contextGuidance).toContain("Use informal 'du' register.");
    expect(prepDe.contextGuidance).toContain("Always check whether the CTA fits mobile widths.");
    expect(prepDe.contextGuidance).not.toContain("Mexican Spanish");

    // Base language + regional subtag both merge for es-MX
    const prepEsMx = prepareBatch({ rootDir: dir, targetLocale: "es-MX" });
    expect(prepEsMx.contextGuidance).toContain("Avoid Peninsular slang.");
    expect(prepEsMx.contextGuidance).toContain("Use Mexican Spanish vocabulary");

    // 2. prepareQe preserves QE_REVIEW_INSTRUCTIONS verbatim AND appends style guide + locale rule + qePrompt
    applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [{ key: "hero.cta", value: "Loslegen" }],
    });
    const qe = prepareQeReview({ rootDir: dir, locales: ["de"], write: false });
    expect(qe.styleGuide?.hasAny).toBe(true);
    expect(qe.instructions.startsWith(QE_REVIEW_INSTRUCTIONS)).toBe(true);
    expect(qe.instructions).toContain("Never use exclamation marks in buttons.");
    expect(qe.instructions).toContain("Use informal 'du' register.");
    expect(qe.instructions).toContain("Flag any exclamation mark inside a button label.");

    // 3. prepareDocument also builds upon base document guidance
    const docPrep = prepareDocument(dir, { documentPath: "README.md", targetLocale: "de" });
    expect(docPrep.documentGuidance).toContain("Translate with full document-level coherence");
    expect(docPrep.documentGuidance).toContain("Friendly, concise, active voice.");
    expect(docPrep.documentGuidance).toContain("Use informal 'du' register.");
    expect(docPrep.documentGuidance).toContain("Always check whether the CTA fits mobile widths.");
  });

  it("rejects styleGuide.file paths escaping the workspace boundary", () => {
    const dir = mkTmp("wraith-style-sec-");
    scaffoldMinimalReactApp(dir);
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const store = new WraithStore(dir);
    const cfg = store.readConfig();
    cfg.styleGuide = { file: "../../etc/passwd" };
    store.writeConfig(cfg);

    expect(() => prepareBatch({ rootDir: dir, targetLocale: "de" })).toThrow();
  });
});
