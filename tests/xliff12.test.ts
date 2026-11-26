import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { answerQuestion, askQuestion } from "../src/core/context.js";
import { initProject } from "../src/core/init.js";
import { qeIndex, submitQeVerdicts } from "../src/core/qe.js";
import { WraithStore } from "../src/core/store.js";
import { fromXliff12Inline, parseXliff12, resolveImportLocale, runTmsExport, runTmsImport, toXliff12Inline } from "../src/core/tms.js";

ensureBootstrapped();

const PANEL = `import { useTranslations } from "next-intl";
export function Panel() {
  const t = useTranslations();
  return (
    <div>
      <button>{t("save")}</button>
      <p>{t("greeting", { name: "x" })}</p>
      <p>{t("terms")}</p>
    </div>
  );
}
`;

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-x12-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
    "messages/en.json": JSON.stringify({ save: "Save", greeting: "Hello {name}", terms: "Read the <b>terms</b>" }, null, 2),
    "messages/de.json": "{}",
    "src/Panel.tsx": PANEL,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
  const store = new WraithStore(dir);
  store.writeConfig({ ...store.readConfig(), charLimits: { save: 10 } });
  return dir;
}

describe("XLIFF 1.2 (Crowdin dialect)", () => {
  it("encodes placeholders and tags as <ph> and decodes them losslessly", () => {
    const enc = toXliff12Inline("Hello {name}, read <b>terms</b> & more");
    expect(enc).toBe('Hello <ph id="1">{name}</ph>, read <ph id="2">&lt;b&gt;</ph>terms<ph id="3">&lt;/b&gt;</ph> &amp; more');
    expect(fromXliff12Inline(enc)).toBe("Hello {name}, read <b>terms</b> & more");
  });

  it("maps a TMS language code onto the configured locale", () => {
    expect(resolveImportLocale("de-DE", "de", ["de", "fr"])).toBe("de");
    expect(resolveImportLocale("zh-CN", "zh-Hans", ["zh-Hans"])).toBe("zh-Hans");
    expect(resolveImportLocale("pt-BR", "pt", ["pt-BR", "pt-PT"])).toBe("pt-BR");
    expect(resolveImportLocale("pt", "x", ["pt-BR", "pt-PT"])).toBeUndefined();
  });

  it("exports source.xlf + de.xlf with context notes and limits, and imports an approved Crowdin download", async () => {
    const dir = project();
    applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "save", value: "Speichern", contextNote: "Button that saves the profile form." },
        { key: "greeting", value: "Hallo {name}", contextNote: "Greeting at the top of the dashboard." },
        { key: "terms", value: "Lies die <b>Bedingungen</b>", contextNote: "Link text to the terms of service." },
      ],
    });
    askQuestion(dir, { keys: ["greeting"], question: "Formal or informal greeting?" });
    answerQuestion(dir, { id: "Q1", answer: "Informal: it's a consumer app." });

    const res = runTmsExport({ rootDir: dir, format: "xliff12", outDir: ".wraith/crowdin" });
    expect(res.files).toEqual([".wraith/crowdin/source.xlf", ".wraith/crowdin/de.xlf"]);
    const source = fs.readFileSync(path.join(dir, ".wraith/crowdin/source.xlf"), "utf8");
    expect(source).toContain('version="1.2"');
    expect(source).not.toContain("<target");
    expect(source).toContain('<trans-unit id="save" resname="save" maxwidth="10" size-unit="char">');
    expect(source).toContain("<note>Meaning: Button that saves the profile form.</note>");
    expect(source).toContain("<note>Where: src/Panel.tsx:");
    expect(source).toContain("<note>Length: max 10 characters (required)</note>");
    expect(source).toContain("<note>Clarified: Formal or informal greeting? → Informal: it&apos;s a consumer app.</note>");
    const de = fs.readFileSync(path.join(dir, ".wraith/crowdin/de.xlf"), "utf8");
    expect(de).toContain('target-language="de"');
    expect(de).toContain('<target xml:space="preserve" state="translated">Hallo <ph id="1">{name}</ph></target>');

    // What Crowdin hands back: its own language code, a linguist edit, approved strings only
    const download = de
      .replace('target-language="de"', 'target-language="de-DE"')
      .replace("Hallo <ph id=\"1\">{name}</ph>", "Hi <ph id=\"1\">{name}</ph>")
      .replace(/state="translated"/g, 'state="final"');
    fs.mkdirSync(path.join(dir, "crowdin-download"), { recursive: true });
    fs.writeFileSync(path.join(dir, "crowdin-download/de.xlf"), download);
    fs.copyFileSync(path.join(dir, ".wraith/crowdin/source.xlf"), path.join(dir, "crowdin-download/source.xlf"));
    expect(parseXliff12(download).units.find((u) => u.key === "greeting")).toMatchObject({ target: "Hi {name}", state: "reviewed" });

    const imp = await runTmsImport({ rootDir: dir, input: "crowdin-download", runVerification: false });
    expect(imp.rejected).toEqual([]);
    expect(imp.locales).toEqual(["de"]);
    expect(imp.applied).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "messages/de.json"), "utf8")).greeting).toBe("Hi {name}");
    expect(qeIndex(dir).get("de\0greeting")?.verdict).toBe("human-verified");
  });

  it("never verifies unapproved units: re-importing Wraith's own export or a non-final edit stays unreviewed", async () => {
    const dir = project();
    applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "save", value: "Speichern" },
        { key: "greeting", value: "Hallo {name}" },
        { key: "terms", value: "Lies die <b>Bedingungen</b>" },
      ],
    });
    runTmsExport({ rootDir: dir, format: "xliff12", outDir: ".wraith/crowdin" });

    // The export itself (state="translated") imported straight back
    const back = await runTmsImport({ rootDir: dir, input: ".wraith/crowdin", runVerification: false });
    expect(back.rejected).toEqual([]);
    expect(back.unchanged).toBe(3);
    expect(back.notReviewed).toBe(3);
    expect(back.qeHumanVerified).toBe(0);
    expect(back.tmUpserted).toBe(0);
    expect(qeIndex(dir).get("de\0save")).toBeUndefined();

    // A linguist edit that is translated but not approved is written, but not verified
    const de = fs.readFileSync(path.join(dir, ".wraith/crowdin/de.xlf"), "utf8").replace(">Speichern<", ">Sichern<");
    fs.mkdirSync(path.join(dir, "in"), { recursive: true });
    fs.writeFileSync(path.join(dir, "in/de.xlf"), de);
    const edit = await runTmsImport({ rootDir: dir, input: "in", runVerification: false });
    expect(edit.applied).toBe(1);
    expect(edit.qeHumanVerified).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "messages/de.json"), "utf8")).save).toBe("Sichern");
    expect(qeIndex(dir).get("de\0save")).toBeUndefined();
  });

  it("builds source.xlf from every source string, independent of locale and onlyFlagged", () => {
    const dir = project();
    const store = new WraithStore(dir);
    store.writeConfig({ ...store.readConfig(), targetLocales: ["de", "fr"] });
    fs.writeFileSync(path.join(dir, "messages/fr.json"), "{}");
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "save", value: "Speichern" }, { key: "greeting", value: "Hallo {name}" }] });
    applyTranslations({ rootDir: dir, targetLocale: "fr", translations: [{ key: "save", value: "Enregistrer" }, { key: "terms", value: "Lisez les <b>conditions</b>" }] });
    submitQeVerdicts({ rootDir: dir, verdicts: [{ locale: "fr", key: "terms", target: "Lisez les <b>conditions</b>", verdict: "flag", reason: "Wrong register", suggestedFix: "Lis les <b>conditions</b>" }] });
    askQuestion(dir, { keys: ["save"], question: "Which form?", locale: "fr" });
    answerQuestion(dir, { id: "Q1", answer: "Formal vous" });

    const res = runTmsExport({ rootDir: dir, format: "xliff12", outDir: "out", onlyFlagged: true });
    expect(res.unitsByLocale).toEqual({ de: 0, fr: 1 });
    const source = parseXliff12(fs.readFileSync(path.join(dir, "out/source.xlf"), "utf8"));
    expect(source.units.map((u) => u.key).sort()).toEqual(["greeting", "save", "terms"]);
    const srcXml = fs.readFileSync(path.join(dir, "out/source.xlf"), "utf8");
    expect(srcXml).not.toContain("Flagged in review");
    expect(srcXml).not.toContain("Formal vous"); // locale-specific answer stays out of the shared source file
    expect(srcXml).toContain('<trans-unit id="save" resname="save" maxwidth="10" size-unit="char">');
    expect(srcXml).not.toMatch(/<trans-unit id="(greeting|terms)"[^>]*maxwidth/); // estimated limits never become maxwidth
    const fr = fs.readFileSync(path.join(dir, "out/fr.xlf"), "utf8");
    expect(fr).toContain("Flagged in review: Wrong register");
  });
});
