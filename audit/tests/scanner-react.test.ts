import { describe, expect, it } from "vitest";
import { runCheck, scanProject } from "../../src/index.js";
import { init, nextIntlPkg, project, i18nextPkg } from "../helpers.js";

/**
 * An independently written, realistic Next.js (App Router + Tailwind + shadcn-style) app.
 * GROUND_TRUTH lists every user-visible English string a localization engineer would expect
 * to be flagged. TECHNICAL lists strings that must NOT be flagged.
 */
const APP: Record<string, string> = {
  "package.json": nextIntlPkg,
  "messages/en.json": JSON.stringify({ nav: { home: "Home", billing: "Billing" }, errors: { notFound: "Not found", forbidden: "Forbidden" } }, null, 2),
  "src/app/layout.tsx": `
import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Acme Dashboard",
  description: "Manage your team and billing in one place",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body className="min-h-screen">{children}</body></html>;
}
`,
  "src/components/Header.tsx": `
"use client";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
const NAV = [
  { href: "/", labelKey: "home" },
  { href: "/billing", labelKey: "billing" },
];
export function Header({ active }: { active: string }) {
  const t = useTranslations("nav");
  return (
    <nav className="flex gap-4">
      {NAV.map((item) => (
        <a key={item.href} href={item.href} className={cn("px-2 truncate w-24", active === item.href && "font-bold")}>
          {t(item.labelKey)}
        </a>
      ))}
      <button aria-label="Open menu" className="md:hidden">☰</button>
    </nav>
  );
}
`,
  "src/components/SaveButton.tsx": `
export function SaveButton({ saving, onClick }: { saving: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={saving} className={\`btn \${saving ? "opacity-50" : ""}\`}>
      {saving ? "Saving…" : "Save changes"}
    </button>
  );
}
`,
  "src/components/EmptyState.tsx": `
type Props = { heading?: string; description?: string };
export function EmptyState({ heading = "No projects yet", description = "Create your first project to get started." }: Props) {
  return (
    <div>
      <h2>{heading}</h2>
      <p>{description}</p>
      <Modal title="Delete project" confirmLabel="Delete" />
    </div>
  );
}
declare function Modal(p: any): any;
`,
  "src/components/Invite.tsx": `
import { toast } from "sonner";
import { z } from "zod";
const schema = z.object({ email: z.string().email("Please enter a valid email address") });
export function Invite({ count, name }: { count: number; name: string }) {
  async function send() {
    try {
      await fetch(\`/api/invite/\${name}\`, { headers: { Authorization: "Bearer " + name } });
      toast.success(\`Invitation sent to \${name}\`);
    } catch {
      window.alert("Something went wrong");
    }
  }
  return (
    <>
      <p>{count === 1 ? "1 member" : \`\${count} members\`}</p>
      <label htmlFor="email">Email address</label>
      <input id="email" placeholder="jane@example.com" data-testid="invite-email" />
      <button onClick={send}>{"Send invite"}</button>
    </>
  );
}
`,
  "src/lib/errors.ts": `
export const ERROR_MESSAGES: Record<string, string> = {
  network: "Check your internet connection and try again.",
  quota: "You have reached your plan limit.",
};
export function describe(code: string) { return ERROR_MESSAGES[code] ?? "Unknown error"; }
`,
  "src/lib/log.ts": `
import { logger } from "./logger";
export function audit(user: string) {
  logger.info(\`User \${user} signed in\`);
  const sql = \`SELECT * FROM users WHERE id = \${user}\`;
  return sql;
}
`,
  "src/components/Errors.tsx": `
import { useTranslations } from "next-intl";
export function ErrorText({ code }: { code: "notFound" | "forbidden" }) {
  const t = useTranslations("errors");
  return <p>{t(code)}</p>;
}
`,
};

const GROUND_TRUTH = [
  "Acme Dashboard",
  "Manage your team and billing in one place",
  "Open menu",
  "Saving…",
  "Save changes",
  "No projects yet",
  "Create your first project to get started.",
  "Delete project",
  "Delete",
  "Please enter a valid email address",
  "Invitation sent to", // template literal toast (concatenation finding acceptable)
  "Something went wrong",
  "1 member",
  "members",
  "Email address",
  "Send invite",
  "Check your internet connection and try again.",
  "You have reached your plan limit.",
  "Unknown error",
];

const MUST_NOT_FLAG = ["Bearer ", "SELECT * FROM users", "User ", "btn "];

describe("F. React/Next.js scanner against an independent realistic app", () => {
  it("F1 recall: finds the majority (>=80%) of user-visible strings", () => {
    const dir = project(APP);
    init(dir, ["fr"]);
    const res = scanProject({ rootDir: dir, limit: 100 });
    const found = [
      ...res.hardcodedStrings.items.map((h) => h.text),
      ...res.concatenations.items.map((c) => c.expression),
    ].join("\n");
    const hits = GROUND_TRUTH.filter((g) => found.includes(g));
    const misses = GROUND_TRUTH.filter((g) => !found.includes(g));
    // Print for the audit report
    console.log(`[F1] recall ${hits.length}/${GROUND_TRUTH.length}; missed: ${JSON.stringify(misses)}`);
    expect(hits.length / GROUND_TRUTH.length).toBeGreaterThanOrEqual(0.8);
  });

  it("F2 precision: technical strings are not reported as user-facing", () => {
    const dir = project(APP);
    init(dir, ["fr"]);
    const res = scanProject({ rootDir: dir, limit: 100 });
    const fps = res.concatenations.items
      .map((c) => c.expression)
      .concat(res.hardcodedStrings.items.map((h) => h.text))
      .filter((e) => MUST_NOT_FLAG.some((m) => e.includes(m)));
    console.log(`[F2] false positives: ${JSON.stringify(fps)}`);
    expect(fps).toEqual([]);
  });

  it("F3 dynamic keys t(item.labelKey) / t(code) must not produce orphaned_key noise", () => {
    const dir = project(APP);
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir, code: "orphaned_key", limit: 100 });
    console.log(`[F3] orphaned: ${JSON.stringify(res.issues.items.map((i) => i.key))}`);
    expect(res.issues.total).toBe(0);
  });

  it("F3b once ANY literal t('...') exists, dynamic keys must still not be reported as orphaned", () => {
    const dir = project({
      ...APP,
      "src/components/Footer.tsx": `import { useTranslations } from "next-intl";
export function Footer(){ const t = useTranslations("nav"); return <footer>{t("home")}</footer>; }`,
    });
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir, code: "orphaned_key", limit: 100 });
    console.log(`[F3b] orphaned: ${JSON.stringify(res.issues.items.map((i) => i.key))}`);
    expect(res.issues.total).toBe(0);
  });

  it("F4 layout risk is detected when classes are composed with cn()/clsx()", () => {
    const dir = project(APP);
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir, code: "layout_risk", limit: 100 });
    expect(res.issues.total).toBeGreaterThan(0);
  });

  it("F5 a file that fails to parse is reported rather than silently treated as clean", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": "{}",
      "src/Broken.tsx": `export function B() { return <div>Hello world</div>; } }}} @@@`,
    });
    init(dir, ["fr"]);
    const res = scanProject({ rootDir: dir });
    const visible = res.hardcodedStrings.total > 0 || res.notes.some((n) => /parse|syntax|Broken/i.test(n));
    expect(visible).toBe(true);
  });
});

describe("G. Project detection robustness", () => {
  it("G1 monorepo (apps/web) is detected instead of silently passing check", () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }),
      "apps/web/package.json": nextIntlPkg,
      "apps/web/messages/en.json": JSON.stringify({ a: "Hello" }),
      "apps/web/src/Page.tsx": `export default function P(){ return <h1>Welcome back</h1>; }`,
    });
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir });
    console.log(`[G1] framework=${res.framework} passed=${res.passed} errors=${res.errorCount}`);
    expect(res.passed).toBe(false);
  });

  it("G2 unknown/unsupported project must not report check passed", () => {
    const dir = project({ "index.html": "<h1>Hello world</h1>" });
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir });
    expect(res.passed).toBe(false);
  });

  it("G3 react-i18next namespace-prefixed keys t('common:save') are tracked", () => {
    const dir = project({
      "package.json": i18nextPkg,
      "public/locales/en/common.json": JSON.stringify({ save: "Save" }),
      "public/locales/en/auth.json": JSON.stringify({ login: "Log in" }),
      "src/A.tsx": `import { useTranslation } from "react-i18next";
export function A(){ const { t } = useTranslation(); return <><b>{t("common:save")}</b><i>{t("auth:login")}</i></>; }`,
    });
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir, code: "orphaned_key", limit: 100 });
    console.log(`[G3] orphaned: ${JSON.stringify(res.issues.items.map((i) => i.key))}`);
    expect(res.issues.total).toBe(0);
  });

  it("G4 project root path containing '.test.' still scans files", () => {
    const dir = project(
      { "package.json": nextIntlPkg, "messages/en.json": "{}", "src/P.tsx": `export const P = () => <h1>Welcome back</h1>;` },
      { prefix: "my.test.app-" }
    );
    init(dir, ["fr"]);
    const res = scanProject({ rootDir: dir });
    expect(res.filesScanned).toBeGreaterThan(0);
  });
});
