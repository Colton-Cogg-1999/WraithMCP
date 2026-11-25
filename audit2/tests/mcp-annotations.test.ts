import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, nextIntlPkg, project } from "../../audit/helpers.js";

/**
 * For each tool: snapshot every file in the repo, call the tool over real stdio, diff.
 * readOnlyHint:true must mean "no file changed". destructiveHint:false must mean
 * "never overwrites/removes existing user content" (MCP spec: additive updates only).
 */
const REPO = path.resolve(__dirname, "../..");
let client: Client;
let dir: string;

function snapshot(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else m.set(path.relative(root, p), crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(root);
  return m;
}
function diff(a: Map<string, string>, b: Map<string, string>) {
  const changed: string[] = [];
  const removedOrOverwritten: string[] = [];
  for (const [k, v] of b) if (a.get(k) !== v) changed.push(k);
  for (const [k, v] of a) if (b.get(k) !== v) removedOrOverwritten.push(k);
  return { changed: changed.sort(), overwritten: removedOrOverwritten.sort() };
}

beforeAll(async () => {
  dir = project({
    "package.json": nextIntlPkg,
    "messages/en.json": JSON.stringify({ a: "Hello", b: "Save changes" }, null, 2) + "\n",
    "messages/de.json": JSON.stringify({ a: "Hallo", b: "Änderungen speichern" }, null, 2) + "\n",
    "src/P.tsx": `import { useTranslations } from "next-intl"; export const P = () => { const t = useTranslations(); return <main><h1>{t("a")}</h1><button>{t("b")}</button><p>Static text here</p></main>; };`,
  });
  init(dir, ["de"]);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "src/bin.ts"), "mcp"], cwd: dir, stderr: "pipe" });
  client = new Client({ name: "audit2", version: "1" });
  await client.connect(transport);
}, 60000);
afterAll(async () => client?.close());

const calls: Array<[string, Record<string, unknown>]> = [
  ["status", {}],
  ["scan", {}],
  ["prepare", { targetLocale: "de", includeTranslated: true }],
  ["check", {}],
  ["report", {}],
  ["memory", { operation: { action: "lookup", query: "Hello", targetLocale: "de" } }],
  ["apply", { targetLocale: "de", translations: [{ key: "a", value: "Servus" }] }],
  ["pseudo", {}],
  ["review", { action: "package", targetLocale: "de" }],
  ["escalate", { action: "export" }],
];

describe("ANN. MCP annotations vs observed side effects", () => {
  it("ANN-1 every tool's readOnlyHint/destructiveHint matches what it actually did to the repository", async () => {
    const { tools } = await client.listTools();
    const ann = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    const memSchema = JSON.stringify(tools.find((t) => t.name === "memory")?.inputSchema ?? {});
    const rows: string[] = [];
    const violations: string[] = [];
    for (const [name, args] of calls) {
      let callArgs = args;
      if (name === "memory" && !memSchema.includes('"operation"')) callArgs = { action: "lookup", query: "Hello", targetLocale: "de" };
      const before = snapshot(dir);
      const res: any = await client.callTool({ name, arguments: callArgs });
      const d = diff(before, snapshot(dir));
      const a: any = ann[name];
      rows.push(`${name.padEnd(8)} readOnly=${a.readOnlyHint} destructive=${a.destructiveHint} isError=${Boolean(res.isError)} changed=${JSON.stringify(d.changed)}`);
      if (a.readOnlyHint && d.changed.length) violations.push(`${name}: readOnlyHint but changed ${d.changed}`);
      if (a.destructiveHint === false && d.overwritten.some((f) => !f.startsWith(".polyglot/"))) violations.push(`${name}: destructiveHint=false but overwrote user files ${d.overwritten.filter((f) => !f.startsWith(".polyglot/"))}`);
    }
    console.log(`[ANN-1]\n  ${rows.join("\n  ")}\n  violations: ${JSON.stringify(violations, null, 2)}`);
    expect(violations).toEqual([]);
  });
});
