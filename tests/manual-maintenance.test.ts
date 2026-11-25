import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTranslations,
  importAsset,
  initProject,
  lookupMemory,
  prepareBatch,
  runCheck,
} from "../src/index.js";

const tmpDirs: string[] = [];
function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-maint-"));
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

const pkg = JSON.stringify({ dependencies: { vue: "3.5", "vue-i18n": "10" } });

describe("Manual maintenance and human-override ranking (N2, N3, N4)", () => {
  it("re-baselines hand-updated source+target via import while refusing to launder untouched targets", () => {
    const dir = mkProject({
      "package.json": pkg,
      "locales/en.json": JSON.stringify({ save: "Save draft", delete: "Delete project" }),
      "locales/fr.json": JSON.stringify({ save: "Enregistrer le brouillon", delete: "Supprimer le projet" }),
      "src/Editor.vue": `<template><button>{{ $t('save') }}</button><button>{{ $t('delete') }}</button></template>`,
    });
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });
    expect(runCheck({ rootDir: dir }).outcome).toBe("PASS");

    // Developer edits BOTH English keys, but only updates 'save' in French (forgets 'delete')
    fs.writeFileSync(
      path.join(dir, "locales/en.json"),
      JSON.stringify({ save: "Save draft now", delete: "Delete entire workspace" })
    );
    fs.writeFileSync(
      path.join(dir, "locales/fr.json"),
      JSON.stringify({ save: "Enregistrer le brouillon maintenant", delete: "Supprimer le projet" })
    );

    // Import re-baselines 'save' (changed target) while keeping 'delete' stale (unchanged target)
    importAsset(dir, { format: "locales" });
    const chk = runCheck({ rootDir: dir, limit: 50 });
    expect(chk.outcome).toBe("FAIL");
    expect(chk.countsByCode["stale_source"]).toBe(1);
    const stale = chk.issues.items.filter((i) => i.code === "stale_source");
    expect(stale.map((s) => s.key)).toEqual(["delete"]);
  });

  it("tracks staleness for hand-added translations created after init and ranks human edits above agent text", () => {
    const dir = mkProject({
      "package.json": pkg,
      "locales/en.json": JSON.stringify({ confirm: "Confirm order", confirm2: "Confirm order" }),
      "src/Cart.vue": `<template><button>{{ $t('confirm') }}</button><button>{{ $t('confirm2') }}</button></template>`,
    });
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es"], writeAgentRule: false });

    // Translator adds locales/es.json by hand AFTER init
    fs.writeFileSync(
      path.join(dir, "locales/es.json"),
      JSON.stringify({ confirm: "Confirmar pedido", confirm2: "Confirmar pedido" })
    );
    expect(runCheck({ rootDir: dir }).outcome).toBe("PASS");

    // English changes later -> stale_source detected even though es.json was hand-added after init
    fs.writeFileSync(
      path.join(dir, "locales/en.json"),
      JSON.stringify({ confirm: "Confirm your order", confirm2: "Confirm order" })
    );
    const chk = runCheck({ rootDir: dir, limit: 50 });
    expect(chk.countsByCode["stale_source"]).toBe(1);

    // Agent applies a stiff translation to confirm2, then human edits it by hand
    applyTranslations({
      rootDir: dir,
      targetLocale: "es",
      translations: [{ key: "confirm2", value: "Pedido confirmar" }],
    });
    fs.writeFileSync(
      path.join(dir, "locales/es.json"),
      JSON.stringify({ confirm: "Confirmar pedido", confirm2: "Confirmar el pedido" })
    );

    const mem = lookupMemory(dir, { query: "Confirm order", targetLocale: "es" });
    expect(mem.fuzzyMatches[0]?.target).toBe("Confirmar el pedido");
    expect(mem.fuzzyMatches.some((m) => m.target === "Pedido confirmar")).toBe(false);

    const prep = prepareBatch({ rootDir: dir, targetLocale: "es", keys: ["confirm"] });
    expect(prep.items[0]?.fuzzyMatches[0]?.target).toBe("Confirmar el pedido");
  });
});
