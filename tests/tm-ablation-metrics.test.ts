import { describe, expect, it } from "vitest";
// @ts-ignore — plain .mjs eval helper (no type declarations)
import { aggregateTCR, chrF, computeTCR, extractStructure, fuzzyTmLookup, lexicalSimilarity, structuralParity, ter } from "../eval/lib/tm-metrics.mjs";

describe("TCR", () => {
  it("N=1 is 1.0 and identical variants are 1.0", () => {
    expect(computeTCR(["Speichern"])).toBe(1);
    expect(computeTCR(["Speichern", "Speichern", " Speichern "])).toBe(1);
  });
  it("4 items with 2 variants -> 1 - 1/3", () => {
    expect(computeTCR(["Speichern", "Speichern", "Sichern", "Speichern"])).toBeCloseTo(1 - 1 / 3, 10);
  });
  it("all distinct -> 0", () => {
    expect(computeTCR(["a", "b", "c"])).toBe(0);
  });
  it("aggregate is the unweighted mean over groups", () => {
    const agg = aggregateTCR({ g1: ["x", "x"], g2: ["x", "y"], g3: ["z"] });
    expect(agg.mean).toBeCloseTo((1 + 0 + 1) / 3, 10);
    expect(agg.groups).toBe(3);
    expect(agg.recurringGroups).toBe(2);
  });
});

describe("ICU & tag parity", () => {
  it("passes identical structure", () => {
    expect(structuralParity("<b>{name}</b> was deleted.", "<b>{name}</b> wurde gelöscht.", { targetLocale: "de" }).ok).toBe(true);
  });
  it("detects a dropped {count}", () => {
    const r = structuralParity("{count} files", "Dateien", { targetLocale: "de" });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/missing_vars:count/);
  });
  it("detects a missing plural branch (de drops `one`)", () => {
    const r = structuralParity(
      "{count, plural, one {# item} other {# items}}",
      "{count, plural, other {# Elemente}}",
      { targetLocale: "de" }
    );
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/missing_branch:count:one/);
  });
  it("allows ja to collapse to `other` and ar to add CLDR categories", () => {
    const src = "{count, plural, one {# item} other {# items}}";
    expect(structuralParity(src, "{count, plural, other {# 件}}", { targetLocale: "ja" }).ok).toBe(true);
    expect(
      structuralParity(src, "{count, plural, zero {لا} one {واحد} two {اثنان} few {# قليل} many {# كثير} other {# عنصر}}", { targetLocale: "ar" }).ok
    ).toBe(true);
  });
  it("detects a missing select branch", () => {
    const r = structuralParity("{g, select, male {He} female {She} other {They}}", "{g, select, male {Er} other {Sie}}", { targetLocale: "de" });
    expect(r.ok).toBe(false);
  });
  it("detects a missing tag", () => {
    const r = structuralParity("<b>{name}</b> was deleted.", "{name} wurde gelöscht.", { targetLocale: "de" });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/tag_mismatch/);
    expect(structuralParity("Click <0>here</0>", "Klicken Sie <0>hier", {}).ok).toBe(false);
  });
  it("extracts nested ICU vars", () => {
    const s = extractStructure("{count, plural, one {# file by {user}} other {# files by {user}}}");
    expect(s.vars).toEqual(["count", "user"]);
    expect(s.icu[0].branches).toEqual(["one", "other"]);
  });
});

describe("chrF2", () => {
  it("identical = 100", () => {
    expect(chrF("Dieses Feld ist erforderlich.", "Dieses Feld ist erforderlich.")).toBe(100);
    expect(chrF("この項目は必須です。", "この項目は必須です。")).toBe(100);
  });
  it("degrades monotonically with damage", () => {
    const ref = "Dieses Feld ist erforderlich.";
    const near = chrF("Dieses Feld ist notwendig.", ref);
    const far = chrF("Speichern", ref);
    expect(near).toBeLessThan(100);
    expect(far).toBeLessThan(near);
    expect(chrF("", ref)).toBe(0);
  });
});

describe("TER (plain edit distance, no shifts)", () => {
  it("identical = 0", () => {
    expect(ter("Dieses Feld ist erforderlich.", "Dieses Feld ist erforderlich.")).toBe(0);
    expect(ter("この項目は必須です。", "この項目は必須です。", { locale: "ja" })).toBe(0);
  });
  it("one substitution in four words = 25", () => {
    expect(ter("Dieses Feld ist notwendig.", "Dieses Feld ist erforderlich.")).toBe(25);
  });
});

describe("fuzzy TM", () => {
  it("lexicalSimilarity mirrors src/core/fuzzy.ts scale", () => {
    expect(lexicalSimilarity("Save", "Save")).toBe(100);
    expect(lexicalSimilarity("Save", "save")).toBe(98);
    expect(lexicalSimilarity("Delete {name}", "Delete {item}")).toBe(92);
  });
  it("top-k lookup respects minSimilarity 0.70 and locale", () => {
    const tm = [
      { source: "Delete file", target: "Datei löschen", targetLocale: "de" },
      { source: "Delete file", target: "ファイルを削除", targetLocale: "ja" },
      { source: "Totally unrelated words here", target: "x", targetLocale: "de" },
    ];
    const hits = fuzzyTmLookup(tm, "Delete files", "de", { k: 3, minSimilarity: 0.5 });
    expect(hits.map((h: any) => h.target)).toEqual(["Datei löschen"]);
    expect(fuzzyTmLookup(tm, "Delete files", "de", { k: 3, minSimilarity: 0.7 })).toEqual([]);
  });
});
