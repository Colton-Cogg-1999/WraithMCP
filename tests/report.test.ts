import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { runCheck } from "../src/core/check.js";
import { applyAssumptionOverride, askQuestion, listAssumptions, overrideAssumption } from "../src/core/context.js";
import { initProject } from "../src/core/init.js";
import { recordAssumption } from "../src/core/memory-ops.js";
import { prepareBatch } from "../src/core/prepare.js";
import { submitQeVerdicts } from "../src/core/qe.js";
import { generateReport } from "../src/core/report.js";
import { mitigationsSince, readRunLog } from "../src/core/run-log.js";

ensureBootstrapped();

const PANEL = `import { useTranslations } from "next-intl";
export function Panel() {
  const t = useTranslations();
  return (
    <div>
      <span className="badge">{t("hoursOpen")}</span>
      <button>{t("invoiceOpen")}</button>
      <p>{t("greeting", { name: "x" })}</p>
    </div>
  );
}
`;

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-report-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
    "messages/en.json": JSON.stringify({ hoursOpen: "Open", invoiceOpen: "Open", greeting: "Hello {name}" }, null, 2),
    "messages/de.json": "{}",
    "src/Panel.tsx": PANEL,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
  return dir;
}

describe("report", () => {
  it("reports caught-and-fixed errors, IDs to reply to, overrides, and intentional variants with their Context Notes", () => {
    const dir = project();
    // A placeholder error blocked by apply, then fixed
    const bad = applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "greeting", value: "Hallo" }] });
    expect(bad.ok).toBe(false);
    const good = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "greeting", value: "Hallo {name}", contextNote: "Greeting at the top of the dashboard." },
        { key: "hoursOpen", value: "Geöffnet", contextNote: "Status badge saying the store is currently open." },
        { key: "invoiceOpen", value: "Öffnen", contextNote: "Button that opens the invoice PDF." },
      ],
    });
    expect(good.ok).toBe(true);
    expect(good.progress).toEqual({ locale: "de", translated: 3, total: 3 });
    expect(fs.readFileSync(path.join(dir, ".wraith/.gitignore"), "utf8")).toContain("run-log.jsonl");

    const m = mitigationsSince(readRunLog(dir));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ key: "greeting", by: "apply" });

    recordAssumption(dir, { category: "tone", locale: "de", summary: "Formal Sie throughout." });
    askQuestion(dir, { keys: ["greeting"], question: "Is the dashboard for staff or customers?" });

    // Before review the two "Open"s are worth a look; after an ok review they are an intentional variant
    let rep = generateReport(dir);
    expect(rep.intentionalVariants).toHaveLength(0);
    expect(rep.reviewList.map((r) => r.key).sort()).toEqual(["hoursOpen", "invoiceOpen"]);
    submitQeVerdicts({
      rootDir: dir,
      verdicts: [
        { locale: "de", key: "hoursOpen", verdict: "ok" },
        { locale: "de", key: "invoiceOpen", verdict: "ok" },
        { locale: "de", key: "greeting", verdict: "ok" },
      ],
    });
    rep = generateReport(dir);
    expect(rep.intentionalVariants[0].items.map((i) => i.contextNote)).toEqual([
      "Status badge saying the store is currently open.",
      "Button that opens the invoice PDF.",
    ]);
    expect(rep.reviewList).toHaveLength(0);
    expect(rep.summary).toMatchObject({ mitigated: 1, openQuestions: 1, flagged: 0 });
    expect(rep.translated[0]).toMatchObject({ locale: "de", translated: 3, changedThisRun: 3, qe: { ok: 3 } });
    expect(rep.markdown).toContain("### Caught and fixed (1)");
    expect(rep.markdown).toContain("**Q1**: Is the dashboard for staff or customers?");
    expect(rep.markdown).toContain('Current guess: `greeting` (de: "Hallo {name}")');
    expect(rep.markdown).toContain("**A1** tone (`de`): Formal Sie throughout.");
    expect(rep.markdown).toContain("Same English, different meaning");
    expect(rep.markdown).toContain("### Follow up");

    // A human overrides A1: binding in prepare, warned in check until applied
    overrideAssumption(dir, { label: "a1", decision: "Use informal du: this is a consumer app.", via: "cli" });
    expect(prepareBatch({ rootDir: dir, targetLocale: "de" }).projectDecisions[0]).toMatchObject({ label: "A1", source: "human", decision: expect.stringContaining("du") });
    expect(runCheck({ rootDir: dir, locale: "de" }).countsByCode.assumption_overridden).toBe(1);
    expect(generateReport(dir).markdown).toContain('**Overridden:** "Use informal du: this is a consumer app."');
    applyAssumptionOverride(dir, "A1");
    expect(listAssumptions(dir)[0].status).toBe("applied");
    expect(runCheck({ rootDir: dir, locale: "de" }).countsByCode.assumption_overridden ?? 0).toBe(0);
    expect(() => applyAssumptionOverride(dir, "A1")).toThrow(/no pending override/);
  });

  it("lists a review flag in 'needs attention' and counts it as mitigated once the string is fixed", () => {
    const dir = project();
    applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "greeting", value: "Hallo {name}" },
        { key: "hoursOpen", value: "Öffnen" },
        { key: "invoiceOpen", value: "Öffnen" },
      ],
    });
    submitQeVerdicts({ rootDir: dir, verdicts: [{ locale: "de", key: "hoursOpen", verdict: "flag", reason: "Verb on a status badge; the store is open", suggestedFix: "Geöffnet" }] });
    let rep = generateReport(dir);
    expect(rep.flagged).toEqual([expect.objectContaining({ key: "hoursOpen", by: "qe", suggestedFix: "Geöffnet" })]);
    expect(rep.markdown).toContain("### Needs attention (1)");

    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "hoursOpen", value: "Geöffnet" }] });
    rep = generateReport(dir);
    expect(rep.flagged).toHaveLength(0);
    expect(rep.mitigations).toEqual([expect.objectContaining({ key: "hoursOpen", by: "qe" })]);
    expect(rep.markdown).toContain("flagged in review (Verb on a status badge; the store is open), then fixed.");
  });
});
