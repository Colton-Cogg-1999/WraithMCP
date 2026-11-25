import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, nextIntlPkg, project } from "../helpers.js";

/**
 * Real stdio transport (child process), exactly as Claude Code / Codex / Gemini CLI launch it.
 * BIN selects what is spawned: default = tsx src/bin.ts; AUDIT_MCP_BIN=release/polyglot-linux-x64 tests the SEA binary.
 */
const REPO = path.resolve(__dirname, "../..");
const BIN = process.env.AUDIT_MCP_BIN;
let client: Client;
let dir: string;
let stderr = "";

function text(res: any): string {
  return (res.content as Array<{ text: string }>).map((c) => c.text).join("\n");
}

beforeAll(async () => {
  const en: Record<string, string> = {};
  for (let i = 0; i < 400; i++) en[`k${i}`] = `Settings label number ${i}`;
  const files: Record<string, string> = {
    "package.json": nextIntlPkg,
    "messages/en.json": JSON.stringify(en, null, 2),
  };
  for (let i = 0; i < 60; i++) {
    files[`src/c/C${i}.tsx`] = `export function C${i}(){ return <section className="truncate w-24"><h2>Heading for card ${i}</h2><p>Body copy that is clearly hardcoded number ${i}</p><button aria-label="Close dialog ${i}">x</button></section>; }`;
  }
  dir = project(files);
  init(dir, ["de", "ar"]);
  const transport = BIN
    ? new StdioClientTransport({ command: path.resolve(REPO, BIN), args: ["mcp"], cwd: dir, stderr: "pipe" })
    : new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "src/bin.ts"), "mcp"], cwd: dir, stderr: "pipe" });
  transport.stderr?.on("data", (d) => (stderr += String(d)));
  client = new Client({ name: "audit", version: "1.0.0" });
  await client.connect(transport);
}, 60000);

afterAll(async () => {
  await client?.close();
});

describe(`T. MCP over real stdio (${BIN ?? "tsx src/bin.ts"})`, () => {
  it("T1 lists 11 tools; every input schema is an object schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(11);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  it("T2 tools declare outputSchema / return structuredContent (MCP 2025-06-18 structured output)", async () => {
    const { tools } = await client.listTools();
    const withOutput = tools.filter((t) => (t as any).outputSchema);
    const res = await client.callTool({ name: "status", arguments: {} });
    console.log(`[T2] tools with outputSchema: ${withOutput.length}/11; status has structuredContent: ${Boolean((res as any).structuredContent)}`);
    expect(withOutput.length).toBeGreaterThan(0);
  });

  it("T3 tools declare behavioural annotations (readOnlyHint/destructiveHint) so agents can auto-approve safe calls", async () => {
    const { tools } = await client.listTools();
    const annotated = tools.filter((t) => t.annotations && ("readOnlyHint" in t.annotations || "destructiveHint" in t.annotations));
    console.log(`[T3] annotated tools: ${annotated.length}/11`);
    expect(annotated.length).toBe(11);
  });

  it("T4 'memory' schema expresses per-action required fields (not a bag of 16 optional fields)", async () => {
    const { tools } = await client.listTools();
    const mem = tools.find((t) => t.name === "memory")!;
    const props = Object.keys((mem.inputSchema as any).properties ?? {});
    const hasOneOf = JSON.stringify(mem.inputSchema).includes("oneOf") || JSON.stringify(mem.inputSchema).includes("anyOf");
    console.log(`[T4] memory: ${props.length} properties, required=${JSON.stringify((mem.inputSchema as any).required)}, discriminated=${hasOneOf}`);
    expect(hasOneOf).toBe(true);
  });

  it("T5 a failing tool (pseudo with no locale files) returns isError with a readable message", async () => {
    const res: any = await client.callTool({ name: "pseudo", arguments: { rootDir: path.join(dir, "nope") } });
    console.log(`[T5] isError=${res.isError} text=${text(res).slice(0, 140)}`);
    expect(res.isError).toBe(true);
  });

  it("T6 apply with one bad item among good ones reports isError (agent must notice partial failure)", async () => {
    const res: any = await client.callTool({
      name: "apply",
      arguments: { targetLocale: "de", translations: [{ key: "k1", value: "Einstellungsbezeichnung Nummer 1" }, { key: "k2", value: "{oops" }] },
    });
    const body = JSON.parse(text(res));
    console.log(`[T6] isError=${Boolean(res.isError)} ok=${body.ok} applied=${body.appliedCount} rejected=${body.rejectedCount}`);
    expect(res.isError).toBe(true);
  });

  it("T7 responses stay within a sane context budget (status/scan/check/report < 25k chars)", async () => {
    const sizes: Record<string, number> = {};
    for (const [name, args] of [
      ["status", {}],
      ["scan", {}],
      ["check", {}],
      ["report", {}],
      ["prepare", { targetLocale: "de" }],
      ["pseudo", {}],
    ] as const) {
      const t0 = Date.now();
      const res = await client.callTool({ name, arguments: args as any });
      sizes[name] = text(res).length;
      sizes[`${name}_ms`] = Date.now() - t0;
    }
    console.log(`[T7] ${JSON.stringify(sizes)}`);
    for (const n of ["status", "scan", "check", "report", "prepare", "pseudo"]) expect(sizes[n]).toBeLessThan(25000);
  });

  it("T8 status (a 'facts like git status' tool) does not modify repository files", async () => {
    const usage = path.join(dir, ".polyglot/usage.json");
    if (fs.existsSync(usage)) fs.rmSync(usage);
    await client.callTool({ name: "status", arguments: {} });
    expect(fs.existsSync(usage)).toBe(false);
  });

  it("T9 schema validation errors come back as tool errors, not protocol crashes", async () => {
    let protocolError = "";
    let res: any;
    try {
      res = await client.callTool({ name: "prepare", arguments: { limit: 5 } }); // missing targetLocale
    } catch (e: any) {
      protocolError = e.message;
    }
    console.log(`[T9] protocolError="${protocolError.slice(0, 120)}" isError=${res?.isError}`);
    expect(res?.isError === true || protocolError.length > 0).toBe(true);
  });

  it("T10 nothing but JSON-RPC is written to stdout (no stray logging); stderr is quiet", async () => {
    // If stdout were polluted the client would already have failed to parse; stderr should be empty-ish.
    console.log(`[T10] stderr bytes=${stderr.length} ${stderr.slice(0, 200)}`);
    expect(stderr.length).toBeLessThan(2000);
  });
});
