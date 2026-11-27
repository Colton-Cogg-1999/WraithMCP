import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { exportEscalation } from "../src/core/escalate.js";
import { initProject } from "../src/core/init.js";
import { compactPrepareResult, prepareBatch } from "../src/core/prepare.js";
import { prepareQeReview, QE_REVIEW_INSTRUCTIONS, submitQeVerdicts, summarizeQe } from "../src/core/qe.js";
import { generateReport } from "../src/core/report.js";
import { WraithStore } from "../src/core/store.js";
import { runTmsExport } from "../src/core/tms.js";
import { createWraithMcpServer, MCP_SERVER_INSTRUCTIONS } from "../src/mcp/server.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-diag-qe-"));
  tmpDirs.push(dir);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
    "messages/en.json": JSON.stringify(
      {
        btnSave: "Save",
        welcomeLong: "Thank you for subscribing to our weekly engineering newsletter.",
        itemsCount: "{count, plural, one {# item} other {# items}}",
        navBoost: "Boost post",
      },
      null,
      2
    ),
    "messages/es-MX.json": "{}",
    "src/App.tsx": `import { useTranslations } from "next-intl";
export function App() {
  const t = useTranslations();
  return (
    <div>
      <button>{t("btnSave")}</button>
      <p>{t("welcomeLong")}</p>
      <span>{t("itemsCount", { count: 2 })}</span>
      <button>{t("navBoost")}</button>
    </div>
  );
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, "utf8");
  }
  initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
  const store = new WraithStore(dir);
  const cfg = store.readConfig();
  cfg.styleGuide = {
    instructions: "Use friendly, concise Mexican Spanish.",
    translationPrompt: "Avoid Spain-only idioms.",
    qePrompt: "Flag wrong word senses and visual clipping.",
    byLocale: { "es-MX": "Use informal tú register." },
  };
  store.writeConfig(cfg);
  store.upsertGlossaryEntry({
    term: "Boost",
    translations: { "es-MX": "Impulsar" },
    origin: "user",
  });
  applyTranslations({
    rootDir: dir,
    targetLocale: "es-MX",
    translations: [
      { key: "btnSave", value: "Ahorrar" }, // wrong sense (save money vs save doc)
      { key: "welcomeLong", value: "Gracias por suscribirte a nuestro boletín semanal de ingeniería." },
      { key: "itemsCount", value: "{count, plural, one {# elemento} other {# elementos}}" },
      { key: "navBoost", value: "Impulsar publicación" },
    ],
  });
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Diagnostic-only QE and MCP simplification", () => {
  it("enforces diagnostic-only QE with severity, category, evidence, visual defects, and full downstream TMS/escalation/report propagation", () => {
    const dir = makeFixture();
    // Write a visual-qa defect manifest for btnSave so QE receives visual evidence
    const manifestPath = path.join(dir, ".wraith/artifacts/visual-qa/manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        defects: [
          {
            locale: "es-MX",
            key: "btnSave",
            type: "text_truncation",
            viewport: "375x812",
            message: "Button text clipped by 14px",
            screenshot: ".wraith/artifacts/visual-qa/es-MX-btnSave.png",
          },
        ],
      })
    );

    // 1. Risk-prioritized prepare skips ordinary plain sentence (welcomeLong) and includes risky keys + visualDefects
    const riskPrep = prepareQeReview({ rootDir: dir, locales: ["es-MX"], scope: "risk", write: false });
    expect(riskPrep.diagnosticOnly).toBe(true);
    expect(riskPrep.scope).toBe("risk");
    expect(riskPrep.instructions).toContain("DIAGNOSTIC-ONLY");
    expect(riskPrep.instructions).toContain("NEVER automatically edit locale files or apply fixes without explicit authorization");
    expect(riskPrep.instructions).toContain("Use friendly, concise Mexican Spanish.");
    expect(riskPrep.instructions).toContain("Avoid Spain-only idioms.");
    expect(riskPrep.instructions).toContain("Flag wrong word senses and visual clipping.");
    expect(riskPrep.instructions).toContain("Use informal tú register.");
    expect(QE_REVIEW_INSTRUCTIONS).toContain("DIAGNOSTIC-ONLY");

    const riskKeys = riskPrep.tasks.flatMap((t) => t.strings.map((s) => s.key)).sort();
    expect(riskKeys).toEqual(["btnSave", "itemsCount", "navBoost"]);
    expect(riskPrep.skippedLowRisk).toBe(1);

    const btnTask = riskPrep.tasks.flatMap((t) => t.strings).find((s) => s.key === "btnSave")!;
    expect(btnTask.visualDefects).toHaveLength(1);
    expect(btnTask.visualDefects![0].type).toBe("text_truncation");
    expect(btnTask.riskSignals).toContain("visual_defect");
    expect(btnTask.riskSignals).toContain("ambiguous_term");

    // 2. Submit structured diagnostic finding; verify catalog on disk is NEVER modified by QE
    const catalogBefore = fs.readFileSync(path.join(dir, "messages/es-MX.json"), "utf8");
    const sub = submitQeVerdicts({
      rootDir: dir,
      verdicts: [
        {
          locale: "es-MX",
          key: "btnSave",
          fingerprint: btnTask.fingerprint,
          verdict: "flag",
          severity: "critical",
          category: "accuracy",
          reason: "'Ahorrar' means saving money, not saving a document",
          evidence: "src/App.tsx:6 <button>{t('btnSave')}</button> submits the form",
          visualEvidence: ".wraith/artifacts/visual-qa/es-MX-btnSave.png (clipped 14px @ 375px)",
          suggestedFix: "Guardar",
          reviewer: "fresh-subagent",
        },
      ],
    });
    expect(sub.accepted).toBe(1);
    expect(fs.readFileSync(path.join(dir, "messages/es-MX.json"), "utf8")).toBe(catalogBefore);

    // 3. Summarize QE surfaces severity breakdown, evidence, and diagnostic-only next steps
    const status = summarizeQe({ rootDir: dir, locales: ["es-MX"] });
    expect(status.diagnosticOnly).toBe(true);
    expect(status.bySeverity).toEqual({ critical: 1, major: 0, minor: 0, unspecified: 0 });
    expect(status.flagged[0]).toMatchObject({
      key: "btnSave",
      severity: "critical",
      category: "accuracy",
      evidence: expect.stringContaining("src/App.tsx:6"),
      visualEvidence: expect.stringContaining("clipped 14px"),
      suggestedFix: "Guardar",
    });
    expect(status.nextSteps.join(" ")).toContain("explicit authorization");

    // 4. Downstream TMS export, human escalation, and report all carry diagnostic metadata
    runTmsExport({ rootDir: dir, format: "xliff2", outDir: "out/tms", onlyFlagged: true });
    const xliff = fs.readFileSync(path.join(dir, "out/tms/es-MX.xliff"), "utf8");
    expect(xliff).toContain('<mda:meta type="qe_severity">critical</mda:meta>');
    expect(xliff).toContain('<mda:meta type="qe_category">accuracy</mda:meta>');
    expect(xliff).toContain("Evidence: src/App.tsx:6");
    expect(xliff).toContain("suggested: Guardar");

    const esc = exportEscalation(dir, { outputDir: "out/human", formats: ["csv"] });
    expect(esc.rows.some((r) => r.key === "btnSave" && r.reason.includes("[critical/accuracy]") && r.suggestion === "Guardar")).toBe(true);

    const rep = generateReport(dir);
    expect(rep.flagged[0]).toMatchObject({ key: "btnSave", severity: "critical", category: "accuracy" });
    expect(rep.markdown).toContain("[critical/accuracy]");
    expect(rep.markdown).toContain("Evidence: src/App.tsx:6");
  });

  it("compacts prepare payloads and keeps MCP server instructions & tool schemas lean without dropping safety checks", async () => {
    const dir = makeFixture();
    // Add 10 untranslated keys to test compact prepare payload + pagination
    const enPath = path.join(dir, "messages/en.json");
    const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
    for (let i = 0; i < 10; i++) {
      en[`long_sentence_${i}`] = `This is a straightforward self-explanatory sentence number ${i} for the settings page.`;
    }
    fs.writeFileSync(enPath, JSON.stringify(en, null, 2));

    const full = prepareBatch({ rootDir: dir, targetLocale: "es-MX", offset: 0, limit: 10 });
    const compact0 = compactPrepareResult(full);
    const full1 = prepareBatch({ rootDir: dir, targetLocale: "es-MX", offset: 5, limit: 5 });
    const compact1 = compactPrepareResult(full1);

    // Compact payload is substantially smaller and drops redundant empty arrays / contextNoteStatus:"missing"
    expect(JSON.stringify(compact0).length).toBeLessThan(JSON.stringify(full).length);
    const firstCompactItem = (compact0.items as Array<Record<string, unknown>>)[0];
    expect(firstCompactItem.placeholders).toBeUndefined();
    expect(firstCompactItem.hasPlurals).toBeUndefined();
    expect(firstCompactItem.contextNoteStatus).toBeUndefined();
    expect(firstCompactItem.glossaryHits).toBeUndefined();
    // Follow-up page omits repeated conventions / guidance / styleGuide
    expect(compact1.conventions).toBeUndefined();
    expect(compact1.contextGuidance).toBeUndefined();
    expect(compact1.styleGuide).toBeUndefined();

    // Concise non-micromanaging MCP instructions and lean tool schemas
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeLessThan(1500);
    expect(MCP_SERVER_INSTRUCTIONS).not.toContain("Definition of done:\n1.");

    const server = createWraithMcpServer({ rootDir: dir });
    const client = new Client({ name: "lean-check", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(12);
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(18_500);

    // Deterministic safety gate on apply still blocks broken placeholders via simplified MCP
    const badApply: any = await client.callTool({
      name: "apply",
      arguments: {
        targetLocale: "es-MX",
        translations: [{ key: "itemsCount", value: "sin plurales" }],
      },
    });
    expect(badApply.isError).toBe(true);
    const badBody = JSON.parse((badApply.content as Array<{ text: string }>)[0].text);
    expect(badBody.ok).toBe(false);
    expect(badBody.errors.length).toBeGreaterThan(0);

    await client.close();
    await server.close();
  });
});
