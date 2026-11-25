import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations, ensureBootstrapped, initProject, runCheck } from "../src/index.js";

ensureBootstrapped();

function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-blockers-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("Round 3 release blockers: MISS-1, MISS-2, MISS-3, STALE-1", () => {
  it("resolves react-i18next plural, ordinal, and context suffix keys without missing_source_key or orphaned_key", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({
        name: "billing-react",
        dependencies: { react: "19.0.0", "react-i18next": "15.0.0", i18next: "24.0.0" },
      }),
      "public/locales/en/billing.json": JSON.stringify({
        seats_one: "{{count}} seat",
        seats_other: "{{count}} seats",
        rank_ordinal_one: "{{count}}st tier",
        rank_ordinal_other: "{{count}}th tier",
        role_admin: "Workspace administrator",
        role_member: "Workspace member",
      }),
      "public/locales/de/billing.json": JSON.stringify({
        seats_one: "{{count}} Platz",
        seats_other: "{{count}} Plätze",
        rank_ordinal_one: "{{count}}. Stufe",
        rank_ordinal_other: "{{count}}. Stufe",
        role_admin: "Arbeitsbereichs-Admin",
        role_member: "Arbeitsbereichs-Mitglied",
      }),
      "src/Summary.tsx": `import { useTranslation } from "react-i18next";
export function Summary({ seats, tier, role }: { seats: number; tier: number; role: string }) {
  const { t } = useTranslation("billing");
  return (
    <section>
      <p>{t("seats", { count: seats })}</p>
      <p>{t("rank", { count: tier, ordinal: true })}</p>
      <p>{t("role", { context: role })}</p>
    </section>
  );
}`,
    });

    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
      const res = runCheck({ rootDir: dir, limit: 100 });
      expect(res.countsByCode["missing_source_key"] ?? 0).toBe(0);
      expect(res.countsByCode["orphaned_key"] ?? 0).toBe(0);
      expect(res.outcome).toBe("PASS");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves react-i18next useTranslation keyPrefix option (including nested prefixes)", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({
        name: "settings-react",
        dependencies: { react: "19.0.0", "react-i18next": "15.0.0" },
      }),
      "public/locales/en/settings.json": JSON.stringify({
        security: { mfa: { enable: "Enable MFA", backupCodes: "Backup codes" } },
      }),
      "public/locales/de/settings.json": JSON.stringify({
        security: { mfa: { enable: "MFA aktivieren", backupCodes: "Backup-Codes" } },
      }),
      "src/MfaPanel.tsx": `import { useTranslation } from "react-i18next";
export function MfaPanel() {
  const { t } = useTranslation("settings", { keyPrefix: "security.mfa" });
  return <div><button>{t("enable")}</button><a>{t("backupCodes")}</a></div>;
}`,
    });

    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
      const res = runCheck({ rootDir: dir, limit: 100 });
      expect(res.countsByCode["missing_source_key"] ?? 0).toBe(0);
      expect(res.countsByCode["orphaned_key"] ?? 0).toBe(0);
      expect(res.outcome).toBe("PASS");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not report next-intl t.has() guarded optional lookups as blocking missing_source_key", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({
        name: "docs-next",
        dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" },
      }),
      "messages/en.json": JSON.stringify({ heading: "Overview" }),
      "messages/de.json": JSON.stringify({ heading: "Übersicht" }),
      "src/Banner.tsx": `import { useTranslations } from "next-intl";
export function Banner() {
  const t = useTranslations();
  return <header><h1>{t("heading")}</h1>{t.has("footnote") && <p>{t("footnote")}</p>}</header>;
}`,
    });

    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
      const res = runCheck({ rootDir: dir, limit: 100 });
      expect(res.countsByCode["missing_source_key"] ?? 0).toBe(0);
      expect(res.outcome).toBe("PASS");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("STALE-1: earlier manual target edit does NOT suppress stale_source when source changes later", () => {
    const dir = makeTempProject({
      "package.json": JSON.stringify({
        name: "stale-test",
        dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" },
      }),
      "messages/en.json": JSON.stringify({ action: "Start trial" }),
      "src/Action.tsx": `import { useTranslations } from "next-intl";
export function Action() { const t = useTranslations(); return <button>{t("action")}</button>; }`,
    });

    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
      applyTranslations({
        rootDir: dir,
        targetLocale: "de",
        translations: [{ key: "action", value: "Test starten" }],
      });
      // Day 1: translator polishes punctuation by hand
      fs.writeFileSync(path.join(dir, "messages/de.json"), JSON.stringify({ action: "Test jetzt starten" }) + "\n");
      expect(runCheck({ rootDir: dir, limit: 100 }).outcome).toBe("PASS");

      // Day 30: English meaning changes completely AFTER the German edit
      fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify({ action: "Delete account permanently" }) + "\n");
      const res = runCheck({ rootDir: dir, limit: 100 });
      expect(res.countsByCode["stale_source"] ?? 0).toBe(1);
      expect(res.outcome).toBe("FAIL");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
