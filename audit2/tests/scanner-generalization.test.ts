import { describe, expect, it } from "vitest";
import { scanProject } from "../../src/index.js";
import { init, nextIntlPkg, project } from "../../audit/helpers.js";

/** A third, previously unseen app (neither the first audit's nor the remediation's held-out app). */
const APP = {
  "package.json": nextIntlPkg,
  "messages/en.json": "{}",
  "src/components/Checkout.tsx": `
import { useState } from "react";
const STEPS = ["Shipping", "Payment", "Review"] as const;
const LABELS = { shipping: "Shipping address", billing: "Billing address" };
export function Checkout({ total }: { total: number }) {
  const [err, setErr] = useState<string | null>(null);
  const title = total > 100 ? "Free shipping unlocked" : "Add more for free shipping";
  return (
    <form onSubmit={() => setErr("Card was declined")}>
      <ol>{STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
      <h2>{title}</h2>
      <fieldset><legend>{LABELS.shipping}</legend></fieldset>
      <Input label="Postal code" hint="5 digits" />
      {err && <Alert variant="destructive">{err}</Alert>}
      <Button type="submit">{\`Pay \${total} now\`}</Button>
      <img src="/logo.svg" alt="Company logo" />
      <time dateTime="2026-01-01">January 1</time>
    </form>
  );
}
declare const Input: any, Alert: any, Button: any;
`,
  "src/lib/api.ts": `
export async function load(id: string) {
  const res = await fetch("/api/orders/" + id, { headers: { "Content-Type": "application/json", "X-Request-Id": id } });
  if (!res.ok) throw new Error("Request failed with status " + res.status);
  return res.json();
}
export const QUERY = "orders?" + new URLSearchParams({ sort: "desc" });
`,
};

const EXPECT = ["Shipping", "Payment", "Review", "Shipping address", "Billing address", "Free shipping unlocked", "Add more for free shipping", "Card was declined", "Postal code", "5 digits", "Pay", "Company logo", "January 1"];
const MUST_NOT = ["application/json", "X-Request-Id", "orders?", "/api/orders/", "Request failed"];

describe("GEN. Scanner generalisation on a third unseen app", () => {
  it("GEN-1 recall >= 70% and no technical false positives", () => {
    const dir = project(APP);
    init(dir, ["de"]);
    const r = scanProject({ rootDir: dir, limit: 100 });
    const found = [...r.hardcodedStrings.items.map((h) => h.text), ...r.concatenations.items.map((c) => c.expression)].join("\n");
    const hits = EXPECT.filter((e) => found.includes(e));
    const fps = [...r.hardcodedStrings.items.map((h) => h.text), ...r.concatenations.items.map((c) => c.expression)].filter((t) => MUST_NOT.some((m) => t.includes(m)));
    console.log(`[GEN-1] recall ${hits.length}/${EXPECT.length}; missed=${JSON.stringify(EXPECT.filter((e) => !found.includes(e)))}; FPs=${JSON.stringify(fps)}`);
    expect(hits.length / EXPECT.length).toBeGreaterThanOrEqual(0.7);
    expect(fps).toEqual([]);
  });
});
