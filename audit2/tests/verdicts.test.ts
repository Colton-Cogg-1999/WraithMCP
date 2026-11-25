import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../src/index.js";
import { init, nextIntlPkg, project } from "../../audit/helpers.js";

const REPO = path.resolve(__dirname, "../..");
const verdict = (dir: string) => {
  const r = runCheck({ rootDir: dir, limit: 50 });
  return { outcome: r.outcome, errors: r.errorCount, codes: r.countsByCode, reasons: r.inconclusiveReasons, files: (r as any).coverage?.filesScanned };
};
const cliExit = (dir: string) =>
  spawnSync(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "src/bin.ts"), "check"], { cwd: dir, encoding: "utf8" }).status;

const cleanNext = {
  "package.json": nextIntlPkg,
  "messages/en.json": JSON.stringify({ home: { title: "Welcome", cta: "Get started" } }, null, 2) + "\n",
  "messages/de.json": JSON.stringify({ home: { title: "Willkommen", cta: "Los geht's" } }, null, 2) + "\n",
  "src/app/page.tsx": `import { useTranslations } from "next-intl";
export default function Page() { const t = useTranslations("home"); return <main><h1>{t("title")}</h1><a href="/start">{t("cta")}</a></main>; }`,
};

describe("V. PASS / FAIL / INCONCLUSIVE on previously unseen repositories", () => {
  it("V1 a genuinely clean, fully translated Next.js app is PASS (exit 0)", () => {
    const dir = project(cleanNext);
    init(dir, ["de"]);
    const v = verdict(dir);
    console.log(`[V1] ${JSON.stringify(v)}`);
    expect(v.outcome).toBe("PASS");
    expect(cliExit(dir)).toBe(0);
  });

  it("V2 the same app with one hardcoded string is FAIL (exit 1)", () => {
    const dir = project({ ...cleanNext, "src/app/about/page.tsx": `export default function About(){ return <p>We are a small team in Lisbon.</p>; }` });
    init(dir, ["de"]);
    expect(verdict(dir).outcome).toBe("FAIL");
    expect(cliExit(dir)).toBe(1);
  });

  it("V3 paths.source pointing at a directory that does not exist is INCONCLUSIVE, not PASS", () => {
    const dir = project(cleanNext);
    init(dir, ["de"]);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".polyglot/config.json"), "utf8"));
    cfg.paths.source = ["frontend/src"];
    fs.writeFileSync(path.join(dir, ".polyglot/config.json"), JSON.stringify(cfg));
    const v = verdict(dir);
    console.log(`[V3] ${JSON.stringify(v)}`);
    expect(v.outcome).toBe("INCONCLUSIVE");
  });

  it("V4 pnpm monorepo with TWO apps: an untranslated second app makes the verdict FAIL", () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "mono", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/web/package.json": nextIntlPkg,
      "apps/web/messages/en.json": JSON.stringify({ a: "Hello" }),
      "apps/web/messages/de.json": JSON.stringify({ a: "Hallo" }),
      "apps/web/src/P.tsx": `import { useTranslations } from "next-intl"; export const P = () => { const t = useTranslations(); return <h1>{t("a")}</h1>; };`,
      "apps/admin/package.json": nextIntlPkg,
      "apps/admin/messages/en.json": JSON.stringify({ users: "Users", delete: "Delete user" }),
      "apps/admin/src/A.tsx": `export const A = () => <h1>Admin console</h1>;`,
    });
    init(dir, ["de"]);
    const v = verdict(dir);
    console.log(`[V4] ${JSON.stringify(v)}`);
    expect(v.outcome).toBe("FAIL");
  });

  it("V5 Flask/Jinja app (unsupported stack) is INCONCLUSIVE with exit 2", () => {
    const dir = project({ "app.py": "from flask import Flask\napp = Flask(__name__)\n", "requirements.txt": "flask==3.0\nFlask-Babel==4.0\n", "templates/index.html": "<h1>{{ _('Welcome') }}</h1><p>Hardcoded text</p>" });
    init(dir, ["de"]);
    expect(verdict(dir).outcome).toBe("INCONCLUSIVE");
    expect(cliExit(dir)).toBe(2);
  });

  it("V6 a Next.js app whose only UI copy lives in .mdx pages is not reported PASS", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4", "@next/mdx": "15" } }),
      "messages/en.json": JSON.stringify({ a: "Hi" }),
      "messages/de.json": JSON.stringify({ a: "Hallo" }),
      "src/app/page.mdx": "# Pricing\n\nOur plans start at 9 dollars per month.\n",
      "src/app/layout.tsx": `import { useTranslations } from "next-intl"; export default function L({children}:{children:any}){ const t = useTranslations(); return <body><nav>{t("a")}</nav>{children}</body>; }`,
    });
    init(dir, ["de"]);
    const v = verdict(dir);
    console.log(`[V6] ${JSON.stringify(v)}`);
    expect(v.outcome).not.toBe("PASS");
  });

  it("V7 a target locale configured but with no file at all is FAIL (all keys missing)", () => {
    const dir = project(cleanNext);
    init(dir, ["de", "ja"]);
    const v = verdict(dir);
    console.log(`[V7] ${JSON.stringify({ outcome: v.outcome, codes: v.codes })}`);
    expect(v.outcome).toBe("FAIL");
  });

  it("V8 a Django project before makemessages (no locale dir) is not PASS", () => {
    const dir = project({ "manage.py": "", "requirements.txt": "Django==5.1\n", "shop/views.py": `from django.utils.translation import gettext as _\ndef v(r):\n    return _("Your cart is empty")\n`, "templates/x.html": "{% load i18n %}<h1>{% translate \"Checkout\" %}</h1>" });
    init(dir, ["fr"]);
    const v = verdict(dir);
    console.log(`[V8] ${JSON.stringify(v)}`);
    expect(v.outcome).not.toBe("PASS");
  });
});

describe("V9. Keys used in code but absent from the source catalog", () => {
  it("V9 t('home.subtitle') with no entry in en.json (renders the raw key at runtime) is not PASS", () => {
    const dir = project({
      ...cleanNext,
      "src/app/page.tsx": `import { useTranslations } from "next-intl";
export default function Page() { const t = useTranslations("home"); return <main><h1>{t("title")}</h1><p>{t("subtitle")}</p><a href="/s">{t("cta")}</a></main>; }`,
    });
    init(dir, ["de"]);
    const v = verdict(dir);
    console.log(`[V9] ${JSON.stringify(v)}`);
    expect(v.outcome).not.toBe("PASS");
  });
});
