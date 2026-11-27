import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { runCheck } from "../src/core/check.js";
import { answerQuestion, applyAssumptionOverride, askQuestion, listAssumptions, overrideAssumption, resolveQuestion } from "../src/core/context.js";
import { initProject } from "../src/core/init.js";
import { recordAssumption } from "../src/core/memory-ops.js";
import { prepareBatch } from "../src/core/prepare.js";
import { submitQeVerdicts, summarizeQe } from "../src/core/qe.js";
import { generateReport } from "../src/core/report.js";
import { appendRunEvents, currentRunStart, mitigationsSince, readRunLog, RUN_GAP_MS } from "../src/core/run-log.js";

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
        { locale: "de", key: "hoursOpen", target: "Geöffnet", verdict: "ok" },
        { locale: "de", key: "invoiceOpen", target: "Öffnen", verdict: "ok" },
        { locale: "de", key: "greeting", target: "Hallo {name}", verdict: "ok" },
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
    submitQeVerdicts({ rootDir: dir, verdicts: [{ locale: "de", key: "hoursOpen", target: "Öffnen", verdict: "flag", reason: "Verb on a status badge; the store is open", suggestedFix: "Geöffnet" }] });
    let rep = generateReport(dir);
    expect(rep.flagged).toEqual([expect.objectContaining({ key: "hoursOpen", by: "qe", suggestedFix: "Geöffnet" })]);
    expect(rep.markdown).toContain("### Needs attention (1)");

    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "hoursOpen", value: "Geöffnet" }] });
    rep = generateReport(dir);
    expect(rep.flagged).toHaveLength(0);
    expect(rep.mitigations).toEqual([expect.objectContaining({ key: "hoursOpen", by: "qe" })]);
    expect(rep.markdown).toContain("flagged in review (Verb on a status badge; the store is open), then fixed.");
  });

  it("agrees with summarizeQe when a question is answered and resolved without re-review", async () => {
    const dir = project();
    applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "greeting", value: "Hallo {name}" },
        { key: "hoursOpen", value: "Geöffnet" },
        { key: "invoiceOpen", value: "Öffnen" },
      ],
    });
    submitQeVerdicts({
      rootDir: dir,
      verdicts: [
        { locale: "de", key: "hoursOpen", target: "Geöffnet", verdict: "ok" },
        { locale: "de", key: "invoiceOpen", target: "Öffnen", verdict: "ok" },
        { locale: "de", key: "greeting", target: "Hallo {name}", verdict: "ok" },
      ],
    });

    askQuestion(dir, { keys: ["hoursOpen"], question: "Store status or action?" });
    await new Promise((r) => setTimeout(r, 5));
    answerQuestion(dir, { id: "Q1", answer: "Store status badge." });
    resolveQuestion(dir, "Q1");

    // Because hoursOpen has not been re-reviewed after Q1's answer, both summarizeQe and generateReport must say unreviewed!
    const qe = summarizeQe({ rootDir: dir, locales: ["de"] });
    const rep = generateReport(dir);
    expect(qe.summary).toMatchObject({ ok: 2, unreviewed: 1 });
    expect(rep.translated[0].qe).toMatchObject({ ok: 2, unreviewed: 1 });
    expect(rep.intentionalVariants).toHaveLength(0); // not promoted when hoursOpen is unreviewed
  });

  it("normalizes --since with timezone offsets, rejects invalid --since, and appends run-log.jsonl to pre-existing .gitignore", () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, ".wraith/.gitignore"), "custom-cache/\n");
    appendRunEvents(dir, [
      { type: "caught", by: "apply", locale: "de", key: "greeting", code: "placeholder_mismatch", message: "missing {name}", at: "2026-11-26T14:50:00.000Z" },
      { type: "applied", locale: "de", key: "greeting", at: "2026-11-26T15:05:00.000Z" },
      { type: "caught", by: "qe", locale: "de", key: "hoursOpen", code: "qe_flag", message: "wrong sense", at: "2026-11-26T15:10:00.000Z" },
      { type: "applied", locale: "de", key: "hoursOpen", at: "2026-11-26T15:15:00.000Z" },
    ]);

    const gitignore = fs.readFileSync(path.join(dir, ".wraith/.gitignore"), "utf8");
    expect(gitignore).toContain("custom-cache/");
    expect(gitignore).toContain("run-log.jsonl");
    expect(gitignore).toContain("qe-tasks.json");

    // 10:08:00-05:00 == 15:08:00.000Z -> excludes the 14:50 catch and 15:05 apply, keeps 15:10->15:15!
    const rep = generateReport(dir, { since: "2026-11-26T10:08:00-05:00" });
    expect(rep.runStartedAt).toBe("2026-11-26T15:08:00.000Z");
    expect(rep.mitigations.map((m) => m.key)).toEqual(["hoursOpen"]);
    expect(rep.translated[0].changedThisRun).toBe(1);

    expect(() => generateReport(dir, { since: "not-a-timestamp" })).toThrow(/Invalid --since/);
  });

  it("handles the 1-hour run-gap boundary, 14-day pruning, @mention neutralization, CLI A1 route, and MCP override_assumption", async () => {
    const dir = project();
    const t0 = Date.parse("2026-11-26T12:00:00.000Z");
    // Exactly 1 hour gap does NOT start a new run (> RUN_GAP_MS required); 1h + 1ms DOES start a new run
    const evExact = [
      { type: "applied" as const, locale: "de", key: "a", at: new Date(t0).toISOString() },
      { type: "applied" as const, locale: "de", key: "b", at: new Date(t0 + RUN_GAP_MS).toISOString() },
    ];
    expect(currentRunStart(evExact)).toBe(evExact[0].at);
    const evOver = [
      ...evExact,
      { type: "applied" as const, locale: "de", key: "c", at: new Date(t0 + 2 * RUN_GAP_MS + 1).toISOString() },
    ];
    expect(currentRunStart(evOver)).toBe(evOver[2].at);

    // 14-day pruning removes events older than 14 days when new events arrive
    const oldAt = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();
    const recentAt = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(
      path.join(dir, ".wraith/run-log.jsonl"),
      [
        JSON.stringify({ type: "applied", locale: "de", key: "staleOld", at: oldAt }),
        JSON.stringify({ type: "applied", locale: "de", key: "keptRecent", at: recentAt }),
      ].join("\n") + "\n"
    );
    applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [{ key: "hoursOpen", value: "Ping @alice | multi\nline" }],
    });
    const keysInLog = readRunLog(dir).map((e) => e.key);
    expect(keysInLog).not.toContain("staleOld");
    expect(keysInLog).toContain("keptRecent");
    expect(keysInLog).toContain("hoursOpen");

    // @mention neutralization & newline/pipe escaping in Current guess and question text
    askQuestion(dir, { keys: ["hoursOpen"], question: "Ask @bob about badge | button?" });
    const md = generateReport(dir).markdown;
    expect(md).not.toMatch(/@bob\b/);
    expect(md).not.toMatch(/@alice\b/);
    expect(md).toContain("@\u200Bbob");
    expect(md).toContain("@\u200Balice");

    // CLI `wraith answer A1 ...` and MCP `override_assumption` / `apply_override`
    recordAssumption(dir, { category: "tone", locale: "de", summary: "Formal Sie" });
    const repoRoot = path.resolve(__dirname, "..");
    execFileSync(
      process.execPath,
      [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "src/bin.ts"), "answer", "A1", "Use", "du"],
      { cwd: dir, stdio: "pipe" }
    );
    expect(listAssumptions(dir)[0]).toMatchObject({ label: "A1", status: "overridden", override: "Use du" });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "src/bin.ts"), "mcp"],
      cwd: dir,
      stderr: "pipe",
    });
    const client = new Client({ name: "report-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      await client.callTool({
        name: "memory",
        arguments: { action: "override_assumption", id: "A1", decision: "Use informal ihr" },
      });
      expect(listAssumptions(dir)[0]).toMatchObject({ status: "overridden", override: "Use informal ihr" });
      await client.callTool({
        name: "memory",
        arguments: { action: "apply_override", id: "A1" },
      });
      expect(listAssumptions(dir)[0]).toMatchObject({ status: "applied", override: "Use informal ihr" });
    } finally {
      await client.close();
    }
  });
});
