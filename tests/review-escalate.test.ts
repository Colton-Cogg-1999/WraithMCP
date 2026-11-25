import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTranslations,
  buildXlsxBuffer,
  createWraithMcpServer,
  ensureBootstrapped,
  exportEscalation,
  generatePseudoLocale,
  importEscalationCorrections,
  ingestReviewResults,
  initProject,
  packageReviewJob,
  parseXlsxBuffer,
  WraithStore,
  prepareBatch,
  runCheck,
  scanProject,
} from "../src/index.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeCleanProject(extraComponent?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-m4-"));
  tmpDirs.push(dir);
  fs.cpSync(path.resolve("fixtures/nextjs-app"), dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "components", "Dashboard.tsx"),
    extraComponent ??
      `import { useTranslations } from "next-intl";
export function Dashboard() {
  const t = useTranslations("home");
  const feed = useTranslations("feed");
  return (
    <main className="ml-4 text-left">
      <button className="w-20 truncate whitespace-nowrap overflow-hidden">{feed("openMenu")}</button>
      <h1>{t("title")}</h1>
      <p>{feed("postHeading")}</p>
    </main>
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

describe("Milestone 4: Cross-Model Review, Human Escalation, Advisory Memory, Layout QA & MCP Compactness", () => {
  it("packages MQM review job, filters false positives on ingest, exports CSV/XLSX/HTML, and imports corrections back", () => {
    const dir = makeCleanProject();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
    scanProject({ rootDir: dir });

    applyTranslations({
      rootDir: dir,
      targetLocale: "es-MX",
      translations: [
        { key: "home.title", value: "Bienvenido a Acme Pulse" },
        { key: "feed.postHeading", value: "Entrada" },
        { key: "feed.openMenu", value: "Abrir" },
      ],
    });

    // 1. Package MQM review job for another agent (e.g. Gemini CLI / Codex)
    const jobPath = ".wraith/review-job-es-MX.json";
    const pkg = packageReviewJob(dir, { targetLocale: "es-MX", outputPath: jobPath });
    expect(pkg.items.length).toBe(3);
    expect(pkg.instructions).toContain("Pass 2 (Verification Filter)");
    expect(pkg.taxonomy.categories.terminology).toBeTruthy();
    expect(fs.existsSync(path.join(dir, jobPath))).toBe(true);

    // 2. Ingest findings: one verified major issue + one unverified false positive
    const ingest = ingestReviewResults(dir, {
      reviewer: "gemini-cli",
      targetLocale: "es-MX",
      findings: [
        {
          key: "feed.postHeading",
          category: "terminology",
          severity: "major",
          span: "Entrada",
          explanation: "Use 'Publicación' for feed post headings in es-MX.",
          suggestion: "Publicación",
          verified: true,
        },
        {
          key: "home.title",
          category: "style",
          severity: "minor",
          explanation: "Stylistic preference nitpick.",
          verified: false,
        },
      ],
    });
    expect(ingest.verifiedOpen).toBe(1);
    expect(ingest.filteredFalsePositives).toBe(1);
    expect(ingest.recordsFlagged).toBe(1);

    // Check flags the verified major finding, ignores the filtered false positive
    const chk = runCheck({ rootDir: dir });
    expect(chk.countsByCode["open_review_finding"]).toBe(1);

    // 3. Export escalation files (CSV, XLSX, self-contained HTML)
    const esc = exportEscalation(dir);
    expect(esc.flaggedCount).toBeGreaterThanOrEqual(1);
    expect(esc.filesWritten).toHaveLength(3);
    for (const f of esc.filesWritten) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
    const html = fs.readFileSync(path.join(dir, ".wraith/escalations/wraith-review.html"), "utf8");
    expect(html).toContain("Wraith Native-Speaker Review");
    expect(html).toContain("feed.postHeading");

    // 4. Simulate human editing XLSX and importing corrections back
    const editedRows = esc.rows.map((r) =>
      r.key === "feed.postHeading"
        ? { ...r, corrected_translation: "Publicación", reviewer_notes: "Confirmed with Mexican native speaker" }
        : r
    );
    const editedXlsxPath = path.join(dir, "edited-review.xlsx");
    fs.writeFileSync(editedXlsxPath, buildXlsxBuffer(editedRows));
    // Verify XLSX parser round-trips cleanly
    const parsedTable = parseXlsxBuffer(fs.readFileSync(editedXlsxPath));
    expect(parsedTable[0][0]).toBe("locale");

    const imp = importEscalationCorrections(dir, editedXlsxPath);
    expect(imp.appliedCount).toBe(1);
    expect(imp.resolvedReviews).toBe(1);

    const store = new WraithStore(dir);
    expect(store.readRecords().records["feed.postHeading"]["es-MX"].reviewStatus).toBe("approved");
    expect(store.readRecords().records["feed.postHeading"]["es-MX"].origin).toBe("human");
    const esJson = JSON.parse(fs.readFileSync(path.join(dir, "messages/es-MX.json"), "utf8"));
    expect(esJson.feed.postHeading).toBe("Publicación");
  });

  it("treats even 100% memory matches as strong contextual suggestions, never blind auto-fills", () => {
    const dir = makeCleanProject();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });
    scanProject({ rootDir: dir });

    const store = new WraithStore(dir);
    store.appendMemory([
      {
        sourceLocale: "en",
        targetLocale: "fr",
        source: "Open",
        target: "Ouvrir",
        context: "FileMenu <button>",
        origin: "apply",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const prep = prepareBatch({ rootDir: dir, targetLocale: "fr", keys: ["feed.openMenu"] });
    expect(prep.memoryGuidance).toContain("strong contextual suggestions");
    const item = prep.items[0];
    expect(item.fuzzyMatches).toHaveLength(1);
    expect(item.fuzzyMatches[0].score).toBe(100);
    expect(item.fuzzyMatches[0].advisory).toBe("strong_suggestion_verify_context");
    expect(item.fuzzyMatches[0].contextAlignment).toBe("different_context");
    expect(item.fuzzyMatches[0].note).toContain("verify meaning still fits");
  });

  it("detects layout/truncation and RTL visual continuity hazards in check() and pseudo()", () => {
    const dir = makeCleanProject();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["ar"], writeAgentRule: false });

    const chk = runCheck({ rootDir: dir });
    expect(chk.countsByCode["layout_risk"]).toBeGreaterThanOrEqual(1);
    expect(chk.countsByCode["rtl_layout_risk"]).toBeGreaterThanOrEqual(1);

    const pseudo = generatePseudoLocale(dir);
    expect(pseudo.layoutHotspots.total).toBeGreaterThanOrEqual(2);
    expect(pseudo.qaChecklist.some((step) => step.includes('dir="rtl"'))).toBe(true);
  });

  it("exposes all 17 MCP tools, /localize prompt, and keeps tool responses compact on large catalogs", async () => {
    const dir = makeCleanProject();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });

    // Seed 150 source keys to verify MCP output stays compact and paginated
    const bigEn: Record<string, string> = {};
    for (let i = 0; i < 150; i++) {
      bigEn[`item_${String(i).padStart(3, "0")}`] = `Label number ${i}`;
    }
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify(bigEn, null, 2), "utf8");

    const server = createWraithMcpServer({ rootDir: dir });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "apply",
      "check",
      "escalate",
      "import",
      "layout",
      "layout_fix",
      "memory",
      "prepare",
      "pseudo",
      "qe_audit",
      "report",
      "review",
      "scan",
      "status",
      "tms_export",
      "tms_import",
      "visual_qa",
    ]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.some((p) => p.name === "localize")).toBe(true);

    // Call check (skipScan=true to isolate catalog pagination) on 150 missing keys -> default pagination caps returned issues at 25!
    const checkRes = await client.callTool({ name: "check", arguments: { rootDir: dir, skipScan: true } });
    const text = (checkRes.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.errorCount).toBe(150);
    expect(parsed.issues.items).toHaveLength(25);
    expect(parsed.issues.hasMore).toBe(true);
    expect(text.length).toBeLessThan(12_000);

    // Call prepare -> default pagination caps returned items at 20!
    const prepRes = await client.callTool({
      name: "prepare",
      arguments: { rootDir: dir, targetLocale: "es-MX" },
    });
    const prepText = (prepRes.content as Array<{ type: string; text: string }>)[0].text;
    const prepParsed = JSON.parse(prepText);
    expect(prepParsed.totalPending).toBe(150);
    expect(prepParsed.items).toHaveLength(20);
    expect(prepParsed.hasMore).toBe(true);

    await client.close();
    await server.close();
  });
});
