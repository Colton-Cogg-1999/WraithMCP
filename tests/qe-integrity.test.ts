import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { initProject } from "../src/core/init.js";
import {
  markHumanVerified,
  prepareQeReview,
  qeIndex,
  readQeVerdicts,
  submitQeVerdicts,
  summarizeQe,
} from "../src/core/qe.js";
import { runTmsExport, runTmsImport } from "../src/core/tms.js";

ensureBootstrapped();

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-qe-int-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
    "messages/en.json": JSON.stringify({ save: "Save", cancel: "Cancel" }, null, 2),
    "messages/de.json": "{}",
    "src/Form.tsx": `import { useTranslations } from "next-intl";
export function Form() {
  const t = useTranslations();
  return <div><button>{t("save")}</button><button>{t("cancel")}</button></div>;
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
  applyTranslations({
    rootDir: dir,
    targetLocale: "de",
    translations: [
      { key: "save", value: "Speichern" },
      { key: "cancel", value: "Abbrechen" },
    ],
  });
  return dir;
}

describe("QE verdict store integrity", () => {
  it("refuses to read or overwrite a corrupt or schema-invalid qe-verdicts.json", async () => {
    const dir = makeProject();
    markHumanVerified(dir, [{ locale: "de", key: "save", source: "Save", target: "Speichern" }]);
    runTmsExport({ rootDir: dir, format: "xliff12", outDir: "xlf" });
    const approvedXlf = fs
      .readFileSync(path.join(dir, "xlf/de.xlf"), "utf8")
      .replace(/state="translated"/g, 'state="final"');
    fs.mkdirSync(path.join(dir, "in"), { recursive: true });
    fs.writeFileSync(path.join(dir, "in/de.xlf"), approvedXlf);

    const verdictsPath = path.join(dir, ".wraith/qe-verdicts.json");

    // 1. Corrupt JSON syntax
    fs.writeFileSync(verdictsPath, "{ broken json");
    expect(() => readQeVerdicts(dir)).toThrow(/Corrupt QE verdicts file/);
    expect(() => summarizeQe({ rootDir: dir })).toThrow(/Corrupt QE verdicts file/);
    expect(() =>
      submitQeVerdicts({ rootDir: dir, verdicts: [{ locale: "de", key: "cancel", target: "Abbrechen", verdict: "ok" }] })
    ).toThrow(/Corrupt QE verdicts file/);
    expect(fs.readFileSync(verdictsPath, "utf8")).toBe("{ broken json"); // untouched!

    // 2. Schema-invalid JSON (e.g. wrong version or bad verdict enum)
    const invalidContent = JSON.stringify({ version: 1, records: [{ bad: true }] });
    fs.writeFileSync(verdictsPath, invalidContent);
    expect(() => readQeVerdicts(dir)).toThrow(/Invalid QE verdicts file/);
    expect(() => runTmsExport({ rootDir: dir, format: "xliff12", outDir: "xlf2" })).toThrow(/Invalid QE verdicts file/);
    await expect(runTmsImport({ rootDir: dir, input: "in", runVerification: false })).rejects.toThrow(/Invalid QE verdicts file/);
    expect(fs.readFileSync(verdictsPath, "utf8")).toBe(invalidContent);
  });

  it("protects human-verified records from agent overwrite and excludes them from prepare --all", () => {
    const dir = makeProject();
    markHumanVerified(dir, [{ locale: "de", key: "save", source: "Save", target: "Speichern" }]);

    // Even includeReviewed: true does not resurface human-verified strings
    const prepAll = prepareQeReview({ rootDir: dir, locales: ["de"], includeReviewed: true, write: false });
    const keysInTasks = prepAll.tasks.flatMap((t) => t.strings.map((s) => s.key));
    expect(keysInTasks).toEqual(["cancel"]);
    expect(prepAll.alreadyReviewed).toBe(1);

    // Direct submit attempt on human-verified string is rejected with code human_verified
    const res = submitQeVerdicts({
      rootDir: dir,
      verdicts: [
        { locale: "de", key: "save", target: "Speichern", verdict: "flag", reason: "Agent tries to override human" },
        { locale: "de", key: "cancel", target: "Abbrechen", verdict: "ok" },
      ],
    });
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual([
      expect.objectContaining({ locale: "de", key: "save", code: "human_verified" }),
    ]);
    expect(qeIndex(dir).get("de\0save")?.verdict).toBe("human-verified");
    expect(summarizeQe({ rootDir: dir }).outcome).toBe("PASS");
  });

  it("pins verdicts to the reviewed text via fingerprint/target and rejects edits made between prepare and submit", () => {
    const dir = makeProject();
    const prep = prepareQeReview({ rootDir: dir, locales: ["de"], write: false });
    const saveTask = prep.tasks[0].strings.find((s) => s.key === "save")!;
    expect(saveTask.fingerprint).toBeTruthy();

    // Missing both fingerprint and target -> schema rejection
    const missingPin = submitQeVerdicts({
      rootDir: dir,
      verdicts: [{ locale: "de", key: "save", verdict: "ok" }],
    });
    expect(missingPin.accepted).toBe(0);
    expect(missingPin.rejected[0]).toMatchObject({ key: "save", code: "invalid_verdict" });

    // Catalog changes after prepare before submit -> rejected with text_changed
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "save", value: "Sichern" }] });
    const staleSubmit = submitQeVerdicts({
      rootDir: dir,
      verdicts: [{ locale: "de", key: "save", fingerprint: saveTask.fingerprint, verdict: "ok" }],
    });
    expect(staleSubmit.accepted).toBe(0);
    expect(staleSubmit.rejected).toEqual([
      expect.objectContaining({ locale: "de", key: "save", code: "text_changed" }),
    ]);
    expect(summarizeQe({ rootDir: dir }).summary.ok).toBe(0);

    // Matching current fingerprint succeeds
    const freshPrep = prepareQeReview({ rootDir: dir, locales: ["de"], keys: ["save"], write: false });
    const freshFp = freshPrep.tasks[0].strings[0].fingerprint;
    const okSubmit = submitQeVerdicts({
      rootDir: dir,
      verdicts: [{ locale: "de", key: "save", fingerprint: freshFp, verdict: "ok" }],
    });
    expect(okSubmit.accepted).toBe(1);
    expect(summarizeQe({ rootDir: dir, keys: ["save"] }).outcome).toBe("PASS");
  });

  it("resets verdict to unreviewed when source text changes and rejects invalid flags or unknown keys", () => {
    const dir = makeProject();
    const res = submitQeVerdicts({
      rootDir: dir,
      verdicts: [
        { locale: "de", key: "save", target: "Speichern", verdict: "ok" },
        { locale: "de", key: "cancel", target: "Abbrechen", verdict: "flag", reason: "   " }, // whitespace reason
        { locale: "de", key: "nonexistent", target: "Foo", verdict: "ok" },
      ],
    });
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual([
      expect.objectContaining({ key: "cancel", code: "invalid_verdict" }),
      expect.objectContaining({ key: "nonexistent", code: "unknown_key" }),
    ]);
    expect(summarizeQe({ rootDir: dir, keys: ["save"] }).summary.ok).toBe(1);

    // Edit English source text -> verdict no longer matches source -> resets to unreviewed
    const enPath = path.join(dir, "messages/en.json");
    const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
    en.save = "Save changes";
    fs.writeFileSync(enPath, JSON.stringify(en, null, 2));

    const afterSourceEdit = summarizeQe({ rootDir: dir, keys: ["save"] });
    expect(afterSourceEdit.outcome).toBe("INCONCLUSIVE");
    expect(afterSourceEdit.summary).toMatchObject({ ok: 0, unreviewed: 1 });
  });
});
