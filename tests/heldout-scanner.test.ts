import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBootstrapped, initProject, runCheck, scanProject } from "../src/index.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeHeldOutApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-heldout-"));
  tmpDirs.push(dir);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "invoice-studio",
      dependencies: { next: "15.1.0", react: "19.0.0", "next-intl": "4.0.0" },
    }),
    "messages/en.json": JSON.stringify(
      {
        status: { paid: "Paid", overdue: "Overdue", draft: "Draft" },
        nav: { invoices: "Invoices" },
      },
      null,
      2
    ),
    "src/app/invoices/page.tsx": `
import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { clsx } from "clsx";

export const metadata: Metadata = {
  title: "Invoice Studio",
  description: "Track client invoices and automatic reminders",
};

export function InvoicesPage({ loading, statusCode }: { loading: boolean; statusCode: "paid" | "overdue" | "draft" }) {
  const t = useTranslations("status");
  const nav = useTranslations("nav");
  return (
    <section>
      <header className={clsx("flex items-center w-24 truncate")}>
        <h1>{nav("invoices")}</h1>
        <button aria-label="Download PDF receipt">{loading ? "Generating PDF…" : "Download PDF"}</button>
      </header>
      <span>{t(statusCode)}</span>
      <input placeholder="Filter by client name" />
    </section>
  );
}
`,
    "src/components/ConfirmDialog.tsx": `
export function ConfirmDialog({
  title = "Cancel subscription",
  description = "Your workspace data will remain readable for 30 days.",
}: { title?: string; description?: string }) {
  return (
    <div role="dialog">
      <h2>{title}</h2>
      <p>{description}</p>
      <button>{"Keep subscription"}</button>
    </div>
  );
}
`,
    "src/lib/billingApi.ts": `
import { logger } from "./logger";
export const BILLING_ERRORS: Record<string, string> = {
  cardDeclined: "Your card was declined by your bank.",
  expired: "Your payment method has expired.",
};

export async function chargeInvoice(token: string, invoiceId: string) {
  logger.info(\`Charging invoice \${invoiceId}\`);
  const query = \`UPDATE invoices SET status = 'paid' WHERE id = \${invoiceId}\`;
  await fetch(\`/api/invoices/\${invoiceId}\`, {
    headers: { Authorization: "Bearer " + token },
    body: query,
  });
}

export function formatBillingError(code: string) {
  return BILLING_ERRORS[code] ?? "Payment failed unexpectedly";
}
`,
  };

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Held-Out Realistic App Scanner Evaluation (Recall, Precision, Dynamic Keys, Layout)", () => {
  it("achieves high recall (>=85%) and zero technical false positives on held-out SaaS app", () => {
    const dir = makeHeldOutApp();
    const scan = scanProject({ rootDir: dir, limit: 100 });
    const found = [
      ...scan.hardcodedStrings.items.map((h) => h.text),
      ...scan.concatenations.items.map((c) => c.expression),
    ].join("\n");

    const expectedUi = [
      "Invoice Studio",
      "Track client invoices and automatic reminders",
      "Download PDF receipt",
      "Generating PDF…",
      "Download PDF",
      "Filter by client name",
      "Cancel subscription",
      "Your workspace data will remain readable for 30 days.",
      "Keep subscription",
      "Your card was declined by your bank.",
      "Your payment method has expired.",
      "Payment failed unexpectedly",
    ];

    const hits = expectedUi.filter((s) => found.includes(s));
    expect(hits.length / expectedUi.length).toBeGreaterThanOrEqual(0.85);

    // Zero false positives on Bearer auth header, SQL UPDATE, and logger.info
    const forbidden = ["Bearer ", "UPDATE invoices", "Charging invoice"];
    for (const f of forbidden) {
      expect(found).not.toContain(f);
    }

    // Dynamic key t(statusCode) must NOT produce false orphan warnings for status.*
    const orphans = runCheck({ rootDir: dir, code: "orphaned_key" });
    expect(orphans.issues.total).toBe(0);

    // clsx("flex items-center w-24 truncate") layout risk is detected
    const layout = runCheck({ rootDir: dir, code: "layout_risk" });
    expect(layout.issues.total).toBeGreaterThan(0);
  });
});
