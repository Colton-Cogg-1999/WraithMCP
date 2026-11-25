import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * MCP stdio schema coverage for every registered tool (v2: 17 tools incl. visual_qa, qe_audit,
 * tms_export, tms_import). Spawns the real server over stdio like Claude Code / Codex do.
 */
const REPO = path.resolve(__dirname, "..");
let client: Client;
let dir: string;
let stderr = "";

const EXPECTED: Record<string, { readOnlyHint: boolean; destructiveHint: boolean }> = {
  status: { readOnlyHint: true, destructiveHint: false },
  scan: { readOnlyHint: true, destructiveHint: false },
  prepare: { readOnlyHint: true, destructiveHint: false },
  apply: { readOnlyHint: false, destructiveHint: true },
  check: { readOnlyHint: true, destructiveHint: false },
  memory: { readOnlyHint: false, destructiveHint: false },
  import: { readOnlyHint: false, destructiveHint: true },
  pseudo: { readOnlyHint: false, destructiveHint: true },
  layout: { readOnlyHint: true, destructiveHint: false },
  layout_fix: { readOnlyHint: false, destructiveHint: true },
  visual_qa: { readOnlyHint: true, destructiveHint: false },
  qe_audit: { readOnlyHint: false, destructiveHint: true },
  tms_export: { readOnlyHint: true, destructiveHint: false },
  tms_import: { readOnlyHint: false, destructiveHint: true },
  review: { readOnlyHint: false, destructiveHint: false },
  escalate: { readOnlyHint: false, destructiveHint: true },
  report: { readOnlyHint: true, destructiveHint: false },
};

function text(res: any): string {
  return (res.content as Array<{ text: string }>).map((c) => c.text).join("\n");
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-mcp-v2-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
    "messages/en.json": JSON.stringify({ save: "Save", hello: "Hello {name}" }, null, 2),
    "messages/de.json": JSON.stringify({ save: "Speichern", hello: "Hallo {name}" }, null, 2),
    "src/A.tsx": `import { useTranslations } from "next-intl";\nexport function A(){ const t = useTranslations(); return <div><button>{t("save")}</button><p>{t("hello", { name: "x" })}</p></div>; }\n`,
    ".polyglot/config.json": JSON.stringify({ version: 1, sourceLocale: "en", targetLocales: ["de"] }, null, 2),
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|POLYGLOT_QE_MODEL)$/.test(k)) env[k] = v;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "src/bin.ts"), "mcp"],
    cwd: dir,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => (stderr += String(d)));
  client = new Client({ name: "v2-schema", version: "1.0.0" });
  await client.connect(transport);
}, 60000);

afterAll(async () => {
  await client?.close();
});

describe("MCP v2 stdio schema coverage", () => {
  it("lists all 17 tools with object input schemas, output schemas, and explicit read-only/destructive hints", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect((t as any).outputSchema?.type).toBe("object");
      expect(t.annotations?.readOnlyHint).toBe(EXPECTED[t.name].readOnlyHint);
      expect(t.annotations?.destructiveHint).toBe(EXPECTED[t.name].destructiveHint);
    }
  });

  it("visual_qa fails closed (INCONCLUSIVE) without baseUrl and returns compact structured JSON", async () => {
    const res: any = await client.callTool({ name: "visual_qa", arguments: {} });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(text(res));
    expect(body.outcome).toBe("INCONCLUSIVE");
    expect(body.tokensUsed).toBe(0);
    expect(res.structuredContent?.outcome).toBe("INCONCLUSIVE");
    expect(text(res).length).toBeLessThan(25000);
  });

  it("qe_audit without model keys skips Tier 2 and marks nothing verified", async () => {
    const res: any = await client.callTool({ name: "qe_audit", arguments: { locales: ["de"] } });
    const body = JSON.parse(text(res));
    expect(body.tier2).toBe("unavailable");
    expect(body.summary.verified).toBe(0);
    expect(body.summary.total).toBe(2);
    expect(fs.existsSync(path.join(dir, ".polyglot/qe-report.json"))).toBe(true);
    expect(text(res).length).toBeLessThan(25000);
  });

  it("tms_export writes XLIFF only inside the export dir and tms_import round-trips it", async () => {
    const exp: any = await client.callTool({ name: "tms_export", arguments: { outDir: "exports", includeTm: true, includeGlossary: true } });
    const body = JSON.parse(text(exp));
    expect(body.unitsByLocale.de).toBe(2);
    const xliffPath = path.join(dir, "exports/de.xliff");
    expect(fs.existsSync(xliffPath)).toBe(true);
    const edited = fs.readFileSync(xliffPath, "utf8").replace(">Speichern<", ">Sichern<");
    fs.writeFileSync(xliffPath, edited);
    const imp: any = await client.callTool({ name: "tms_import", arguments: { input: "exports/de.xliff" } });
    const ib = JSON.parse(text(imp));
    expect(imp.isError).toBeFalsy();
    expect(ib.applied).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "messages/de.json"), "utf8")).save).toBe("Sichern");
  });

  it("rejects export paths outside the workspace and invalid arguments as tool errors, not crashes", async () => {
    let protocolError = "";
    let res: any;
    try {
      res = await client.callTool({ name: "tms_export", arguments: { outDir: "../../escape" } });
    } catch (e: any) {
      protocolError = e.message;
    }
    expect(res?.isError === true || protocolError.length > 0).toBe(true);
    let res2: any;
    let err2 = "";
    try {
      res2 = await client.callTool({ name: "tms_import", arguments: {} });
    } catch (e: any) {
      err2 = e.message;
    }
    expect(res2?.isError === true || err2.length > 0).toBe(true);
    expect(stderr.length).toBeLessThan(2000);
  });
});
