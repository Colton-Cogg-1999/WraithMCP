import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject, runCheck } from "../src/index.js";

const tmpDirs: string[] = [];

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-verdicts-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Verification false-pass closure across Vue and Rails (B3, B4, B5)", () => {
  it("Vue: detects missing source catalog key, ignores dynamic keys, and returns INCONCLUSIVE when 0 source files scanned", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ dependencies: { vue: "3.5.0", "vue-i18n": "10.0.0" } }),
      "locales/en.json": JSON.stringify({
        nav: { home: "Home" },
        status: { active: "Active", paused: "Paused" },
      }),
      "locales/es.json": JSON.stringify({
        nav: { home: "Inicio" },
        status: { active: "Activo", paused: "Pausado" },
      }),
      "src/Header.vue": `<template>
  <nav>
    <a>{{ $t('nav.home') }}</a>
    <span>{{ $t('status.' + state) }}</span>
    <button>{{ $t('nav.missingCta') }}</button>
  </nav>
</template>
<script setup lang="ts">
const state = "active";
</script>
`,
    });
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es"], writeAgentRule: false });

    const res = runCheck({ rootDir: dir, limit: 50 });
    expect(res.outcome).toBe("FAIL");
    expect(res.countsByCode["missing_source_key"]).toBe(1);
    const missing = res.issues.items.filter((i) => i.code === "missing_source_key");
    expect(missing.map((m) => m.key)).toEqual(["nav.missingCta"]);

    // Fix the missing key -> now PASS even with dynamic $t('status.' + state)
    fs.writeFileSync(
      path.join(dir, "locales/en.json"),
      JSON.stringify({ nav: { home: "Home", missingCta: "Upgrade" }, status: { active: "Active", paused: "Paused" } })
    );
    fs.writeFileSync(
      path.join(dir, "locales/es.json"),
      JSON.stringify({ nav: { home: "Inicio", missingCta: "Mejorar" }, status: { active: "Activo", paused: "Pausado" } })
    );
    expect(runCheck({ rootDir: dir }).outcome).toBe("PASS");

    // Point paths.source at a non-existent folder -> INCONCLUSIVE even though catalog keys exist
    const cfgPath = path.join(dir, ".polyglot/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.paths.source = ["client/nonexistent"];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const inc = runCheck({ rootDir: dir });
    expect(inc.outcome).toBe("INCONCLUSIVE");
    expect(inc.coverage.filesScanned).toBe(0);
  });

  it("Rails: detects missing source catalog key in ERB/Ruby, ignores dynamic interpolation, and returns INCONCLUSIVE when 0 source files scanned", () => {
    const dir = mkProject({
      Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
      "config/application.rb": "module App; end\n",
      "config/locales/en.yml": "en:\n  orders:\n    index:\n      heading: Orders\n    status:\n      paid: Paid\n",
      "config/locales/fr.yml": "fr:\n  orders:\n    index:\n      heading: Commandes\n    status:\n      paid: Payée\n",
      "app/views/orders/index.html.erb": `<h1><%= t('.heading') %></h1>
<p><%= t("orders.status.#{@order.state}") %></p>
<button><%= t('.cancel_missing') %></button>
`,
    });
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });

    const res = runCheck({ rootDir: dir, limit: 50 });
    expect(res.outcome).toBe("FAIL");
    expect(res.countsByCode["missing_source_key"]).toBe(1);
    const missing = res.issues.items.filter((i) => i.code === "missing_source_key");
    expect(missing.map((m) => m.key)).toEqual(["orders.index.cancel_missing"]);

    // Point paths.source at empty/missing folder -> INCONCLUSIVE even with valid YAML catalogs
    const cfgPath = path.join(dir, ".polyglot/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.paths.source = ["nonexistent_views"];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const inc = runCheck({ rootDir: dir });
    expect(inc.outcome).toBe("INCONCLUSIVE");
    expect(inc.coverage.filesScanned).toBe(0);
  });

  it("reports present-but-unscanned content/template file types in check coverage (N13)", () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4" } }),
      "messages/en.json": JSON.stringify({ title: "Docs" }),
      "messages/fr.json": JSON.stringify({ title: "Documentation" }),
      "src/app/layout.tsx": `import { useTranslations } from "next-intl"; export default function L(){ const t = useTranslations(); return <h1>{t("title")}</h1>; }`,
      "src/app/faq/page.mdx": "# FAQ\n\nFrequently asked questions.\n",
      "templates/email.hbs": "<h1>Welcome {{name}}</h1>\n",
    });
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });

    const res = runCheck({ rootDir: dir });
    expect(res.outcome).toBe("INCONCLUSIVE");
    expect(res.coverage.unscannedFileTypes[".mdx"]).toBe(1);
    expect(res.coverage.unscannedFileTypes[".hbs"]).toBe(1);
  });
});
