import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { initProject } from "../src/core/init.js";
import { encodeZeroWidthKeyId } from "../src/core/pseudo.js";
import {
  ElementGeometrySnapshot,
  VisualDefectType,
  contrastRatio,
  diffGeometry,
  runVisualQa,
} from "../src/core/visual-qa.js";

ensureBootstrapped();

function makeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-visual-qa-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function snap(over: Partial<ElementGeometrySnapshot> = {}): ElementGeometrySnapshot {
  return {
    key: "card.title",
    tag: "p",
    width: 200,
    height: 20,
    lineCount: 1,
    scrollWidth: 200,
    clientWidth: 200,
    overflowX: 0,
    clipped: false,
    occluded: false,
    fontLoaded: true,
    contrastRatio: 21,
    ...over,
  };
}

const CTX = { route: "/", locale: "de", viewport: "375x812" };

describe("Visual QA — contrastRatio & diffGeometry (pure)", () => {
  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000", "#fff")).toBe(21);
    expect(contrastRatio("rgb(0, 0, 0)", "rgba(255, 255, 255, 1)")).toBe(21);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 1);
  });

  it("emits no defects for identical snapshots", () => {
    const base = [snap(), snap({ key: "btn.export", tag: "button" })];
    expect(diffGeometry(base, base.map((s) => ({ ...s })), CTX)).toEqual([]);
  });

  const cases: Array<[VisualDefectType, Partial<ElementGeometrySnapshot>]> = [
    ["line_wrap_regression", { lineCount: 2 }],
    ["container_blowout", { height: 30 }],
    ["text_truncation", { clipped: true }],
    ["element_occlusion", { occluded: true }],
    ["missing_glyph_tofu", { fontLoaded: false }],
    ["contrast_regression", { contrastRatio: 2.5 }],
  ];
  for (const [type, over] of cases) {
    it(`fires ${type}`, () => {
      const defects = diffGeometry([snap()], [snap(over)], CTX);
      const hit = defects.find((d) => d.type === type);
      expect(hit).toBeDefined();
      expect(hit?.id).toBe(`${type}:de:375x812:/:card.title`);
      expect(hit?.key).toBe("card.title");
      expect(hit?.message.length).toBeGreaterThan(0);
    });
  }

  it("fires blowout/truncation without a baseline but not baseline-relative rules", () => {
    const types = diffGeometry(undefined, [snap({ lineCount: 4, overflowX: 10, scrollWidth: 210, contrastRatio: 1.2 })], CTX).map(
      (d) => d.type
    );
    expect(types).toContain("container_blowout");
    expect(types).toContain("text_truncation");
    expect(types).not.toContain("line_wrap_regression");
    expect(types).not.toContain("contrast_regression");
  });

  it("matches duplicate keys by occurrence index", () => {
    const base = [snap({ key: "dup" }), snap({ key: "dup", lineCount: 3, height: 60 })];
    const curr = [snap({ key: "dup" }), snap({ key: "dup", lineCount: 3, height: 60 })];
    expect(diffGeometry(base, curr, CTX)).toEqual([]);
  });
});

describe("Visual QA — fail-closed INCONCLUSIVE", () => {
  it("is INCONCLUSIVE when baseUrl is missing", async () => {
    const dir = makeTempDir({});
    try {
      const res = await runVisualQa({ rootDir: dir, captureBaseline: true });
      expect(res.outcome).toBe("INCONCLUSIVE");
      expect(res.passed).toBe(false);
      expect(res.inconclusiveReason).toMatch(/baseUrl/);
      expect(res.tokensUsed).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is INCONCLUSIVE when Playwright cannot be loaded", async () => {
    const dir = makeTempDir({});
    try {
      const res = await runVisualQa({
        rootDir: dir,
        baseUrl: "http://127.0.0.1:9",
        captureBaseline: true,
        playwrightLoader: async () => {
          throw new Error("Cannot find module 'playwright'");
        },
      });
      expect(res.outcome).toBe("INCONCLUSIVE");
      expect(res.passed).toBe(false);
      expect(res.inconclusiveReason).toMatch(/Playwright/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is INCONCLUSIVE in diff mode when the baseline is missing", async () => {
    const dir = makeTempDir({});
    try {
      const res = await runVisualQa({
        rootDir: dir,
        baseUrl: "http://127.0.0.1:9",
        playwrightLoader: async () => ({ chromium: {} }),
      });
      expect(res.outcome).toBe("INCONCLUSIVE");
      expect(res.mode).toBe("diff");
      expect(res.inconclusiveReason).toMatch(/baseline/i);
      expect(res.nextSteps.join(" ")).toContain("wraith visual-qa --capture-baseline");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Visual QA — live Chromium end-to-end", () => {
  it("captures a baseline, detects wrap/truncation/occlusion with cropped screenshots, then PASSes when fixed", async () => {
    const dir = makeTempDir({
      "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
      "messages/en.json": JSON.stringify({ cardTitle: "Plan", btnExport: "Export", labelName: "Name" }),
      "messages/de.json": JSON.stringify({ cardTitle: "Tarif", btnExport: "Export", labelName: "Name" }),
      "src/Card.tsx": `import { useTranslations } from "next-intl";
export function Card() {
  const t = useTranslations();
  return (
    <div>
      <p>{t("cardTitle")}</p>
      <div>{t("btnExport")}</div>
      <span>{t("labelName")}</span>
    </div>
  );
}
`,
    });

    let regressed = false;
    const z = encodeZeroWidthKeyId;
    const server = http.createServer((_req, res) => {
      const title = regressed
        ? "Ihr monatlicher Abrechnungstarif mit allen Zusatzleistungen und Optionen"
        : "Tarif";
      const exportLabel = regressed ? "Alle Abrechnungsdaten als CSV exportieren" : "Export";
      const overlay = regressed
        ? `<div style="position:absolute;left:0;top:0;width:300px;height:40px;background:#fff"></div>`
        : "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"/></head>
<body style="margin:16px;background:#fff;color:#000;font-family:sans-serif">
  <p style="width:200px;margin:0 0 16px;font-size:16px;line-height:20px">${z("cardTitle")}${title}</p>
  <div style="width:120px;margin:0 0 16px;font-size:14px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${z("btnExport")}${exportLabel}</div>
  <div style="position:relative;height:40px">
    <span style="font-size:14px;line-height:18px">${z("labelName")}Name</span>
    ${overlay}
  </div>
</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });

      // Phase 1: capture baseline
      const cap = await runVisualQa({ rootDir: dir, baseUrl, routes: ["/"], captureBaseline: true });
      if (
        cap.outcome === "INCONCLUSIVE" &&
        /Playwright|Chromium/i.test(cap.inconclusiveReason ?? "") &&
        process.env.WRAITH_REQUIRE_PLAYWRIGHT !== "1"
      ) {
        expect(cap.passed).toBe(false);
        return;
      }
      expect(cap.inconclusiveReason).toBeUndefined();
      expect(cap.outcome).toBe("PASS");
      expect(cap.mode).toBe("capture");
      expect(cap.localesChecked).toEqual(["de"]);
      expect(cap.viewportsChecked).toEqual(["375x812", "1280x800"]);
      expect(cap.elementsMeasured).toBe(6);
      const baselineAbs = path.join(dir, ".wraith/visual-baseline.json");
      expect(fs.existsSync(baselineAbs)).toBe(true);
      const baseline = JSON.parse(fs.readFileSync(baselineAbs, "utf8"));
      expect(Object.keys(baseline.snapshots).sort()).toEqual(["/|1280x800|de", "/|375x812|de"]);
      expect(baseline.snapshots["/|375x812|de"].map((s: ElementGeometrySnapshot) => s.key)).toEqual([
        "btnExport",
        "cardTitle",
        "labelName",
      ]);

      // Phase 2: regressed render
      regressed = true;
      const bad = await runVisualQa({ rootDir: dir, baseUrl, routes: ["/"] });
      expect(bad.outcome).toBe("FAIL");
      expect(bad.passed).toBe(false);
      expect(bad.tokensUsed).toBe(0);
      expect(bad.countsByType["line_wrap_regression"]).toBeGreaterThan(0);
      expect(bad.countsByType["text_truncation"]).toBeGreaterThan(0);
      expect(bad.countsByType["element_occlusion"]).toBeGreaterThan(0);
      const wrap = bad.defects.find((d) => d.type === "line_wrap_regression");
      expect(wrap?.key).toBe("cardTitle");
      expect(wrap?.file).toBe("src/Card.tsx");
      expect(typeof wrap?.line).toBe("number");
      expect(bad.defects.find((d) => d.type === "text_truncation")?.key).toBe("btnExport");
      expect(bad.defects.find((d) => d.type === "element_occlusion")?.key).toBe("labelName");

      expect(bad.screenshots.length).toBeGreaterThan(0);
      for (const s of bad.screenshots) {
        const abs = path.join(dir, s);
        expect(fs.existsSync(abs)).toBe(true);
        expect(fs.readFileSync(abs).subarray(1, 4).toString()).toBe("PNG");
      }
      expect(fs.existsSync(path.join(dir, ".wraith/artifacts/visual-qa/de/cardTitle-375x812.png"))).toBe(true);
      expect(bad.manifestPath).toBe(".wraith/artifacts/visual-qa/manifest.json");
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, bad.manifestPath!), "utf8"));
      expect(manifest.defects.length).toBe(bad.defectCount);
      const byId = new Map<string, { screenshot?: string; key: string; file?: string }>(
        manifest.defects.map((d: { id: string; screenshot?: string; key: string; file?: string }) => [d.id, d])
      );
      for (const d of bad.defects) {
        const entry = byId.get(d.id);
        expect(entry).toBeDefined();
        expect(entry?.key).toBe(d.key);
        expect(entry?.screenshot).toBe(d.screenshot);
        expect(entry?.screenshot && fs.existsSync(path.join(dir, entry.screenshot))).toBe(true);
      }
      expect(byId.get("line_wrap_regression:de:375x812:/:cardTitle")?.file).toBe("src/Card.tsx");

      // Phase 3: fixed render (identical to baseline)
      regressed = false;
      const good = await runVisualQa({ rootDir: dir, baseUrl, routes: ["/"] });
      expect(good.outcome).toBe("PASS");
      expect(good.defectCount).toBe(0);
      expect(good.screenshots).toEqual([]);
      expect(fs.existsSync(path.join(dir, ".wraith/artifacts/visual-qa/manifest.json"))).toBe(false);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
