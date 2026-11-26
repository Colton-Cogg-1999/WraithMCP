import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { runCheck } from "../src/core/check.js";
import {
  answerQuestion,
  askQuestion,
  declaredLimit,
  heuristicLimit,
  listQuestions,
  readContextNotes,
  resolveQuestion,
  setContextNoteForKey,
} from "../src/core/context.js";
import { initProject } from "../src/core/init.js";
import { prepareBatch } from "../src/core/prepare.js";
import { prepareQeReview, submitQeVerdicts, summarizeQe } from "../src/core/qe.js";
import { WraithStore } from "../src/core/store.js";

ensureBootstrapped();

const PANEL = `import { useTranslations } from "next-intl";
export function Panel() {
  const t = useTranslations();
  return (
    <div>
      <button>{t("btnSave")}</button>
      <p>{t("intro")}</p>
      <span>{t("checkout.total")}</span>
      <span>{t("checkout.couponHint")}</span>
    </div>
  );
}
`;

function project(de: Record<string, string>, charLimits?: Record<string, number>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-ctx-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
    "messages/en.json": JSON.stringify(
      { btnSave: "Save", intro: "Post your first update", checkout: { total: "Total", couponHint: "Have a coupon?" } },
      null,
      2
    ),
    "messages/de.json": JSON.stringify({}),
    "src/Panel.tsx": PANEL,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
  if (charLimits) {
    const store = new WraithStore(dir);
    store.writeConfig({ ...store.readConfig(), charLimits });
  }
  const nested: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(de)) {
    const [a, b] = k.split(".");
    if (b) ((nested[a] ??= {}) as Record<string, string>)[b] = v;
    else nested[a] = v;
  }
  fs.writeFileSync(path.join(dir, "messages/de.json"), JSON.stringify(nested, null, 2));
  return dir;
}

const codes = (dir: string, code: string) => runCheck({ rootDir: dir, locale: "de" }).issues.items.filter((i) => i.code === code);

describe("Character Limits", () => {
  it("resolves declared limits by exact key or most specific glob, and sizes heuristic budgets", () => {
    const config = { charLimits: { "checkout.*": 20, "checkout.total": 8, "*": 99 } } as never;
    expect(declaredLimit(config, "checkout.total")).toBe(8);
    expect(declaredLimit(config, "checkout.couponHint")).toBe(20);
    expect(declaredLimit(config, "btnSave")).toBe(99);
    expect(heuristicLimit("OK")).toBe(8);
    expect(heuristicLimit("Save")).toBe(12);
    expect(heuristicLimit("Place order")).toBe(22); // "Bestellung aufgeben" (19) fits
    expect(heuristicLimit("x".repeat(51))).toBeUndefined();
    expect(heuristicLimit("{count, plural, one {# item} other {# items}}")).toBeUndefined();
  });

  it("fails check on a declared limit but only warns on an inferred one", () => {
    const dir = project(
      { btnSave: "Speichern und schließen", intro: "Veröffentliche dein erstes Update", "checkout.total": "Gesamtbetrag", "checkout.couponHint": "Gutschein?" },
      { "checkout.*": 10 }
    );
    const declared = codes(dir, "char_limit_exceeded");
    expect(declared.map((i) => i.key)).toEqual(["checkout.total"]);
    expect(declared[0].severity).toBe("error");
    const inferred = codes(dir, "char_limit_inferred");
    expect(inferred.map((i) => i.key)).toEqual(["btnSave"]); // <button> "Save" → budget 12, got 23
    expect(inferred[0].severity).toBe("warning");
    expect(inferred[0].message).toContain("Open Question");

    const item = prepareBatch({ rootDir: dir, targetLocale: "de", includeTranslated: true }).items.find((i) => i.key === "btnSave")!;
    expect(item.reason).toBe("char_limit_exceeded");
    expect(item.charLimit).toEqual({ maxChars: 12, kind: "inferred", basis: "heuristic" });

    // A rendered measurement outranks the heuristic and is still advisory
    new WraithStore(dir).setLayoutBudget("btnSave", "de", { maxWidthPx: 200, budgetChars: 30, element: "button", updatedAt: "2026-01-01T00:00:00Z" });
    expect(codes(dir, "char_limit_inferred")).toHaveLength(0);
    expect(codes(dir, "layout_budget_exceeded")).toHaveLength(0);
  });
});

describe("Context Notes", () => {
  it("are written through apply, pinned to the source, and go stale when the source changes", () => {
    const dir = project({});
    const res = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [{ key: "btnSave", value: "Speichern", contextNote: "Button that saves the open document, not about saving money." }],
    });
    expect(res.ok).toBe(true);
    expect(readContextNotes(dir).notes.btnSave.note).toContain("saves the open document");

    const prep = () => prepareBatch({ rootDir: dir, targetLocale: "de", includeTranslated: true });
    expect(prep().contextGuidance).toContain("contextNote");
    expect(prep().items.find((i) => i.key === "btnSave")).toMatchObject({ contextNoteStatus: "current", contextNote: expect.stringContaining("saves") });
    expect(prep().items.find((i) => i.key === "intro")?.contextNoteStatus).toBe("missing");

    const en = JSON.parse(fs.readFileSync(path.join(dir, "messages/en.json"), "utf8"));
    en.btnSave = "Save draft";
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify(en, null, 2));
    expect(prep().items.find((i) => i.key === "btnSave")?.contextNoteStatus).toBe("stale");
    setContextNoteForKey(dir, "btnSave", "Button that saves the post as an unpublished draft.");
    expect(prep().items.find((i) => i.key === "btnSave")?.contextNoteStatus).toBe("current");
  });
});

describe("Open Questions", () => {
  it("flow open → answered → resolved, surface in check, prepare and QE review", async () => {
    const dir = project({ btnSave: "Speichern", intro: "Veröffentliche dein erstes Update", "checkout.total": "Summe", "checkout.couponHint": "Gutschein?" });
    const q1 = askQuestion(dir, { keys: ["intro"], question: "Is 'Post' a verb (publish) or a noun (a social post) here?" });
    expect(q1).toMatchObject({ created: true, question: { id: "Q1", status: "open" } });
    expect(askQuestion(dir, { keys: ["intro"], question: "Is 'Post' a verb (publish) or a noun (a social post) here?" }).created).toBe(false);
    expect(askQuestion(dir, { keys: ["checkout.total"], locale: "de", question: "Gross or net total?" }).question.id).toBe("Q2");

    expect(codes(dir, "open_question").map((i) => i.key).sort()).toEqual(["checkout.total", "intro"]);
    expect(() => resolveQuestion(dir, "Q1")).toThrow(/only answered/);

    // A flag given before the answer must not stick once the answer arrives (same text, new context)
    submitQeVerdicts({ rootDir: dir, verdicts: [{ locale: "de", key: "intro", verdict: "flag", reason: "Unclear meaning: Post verb or noun?" }] });
    expect(summarizeQe({ rootDir: dir, locales: ["de"] }).summary.flagged).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    answerQuestion(dir, { id: "q1", answer: "Verb: it asks the user to publish their first update.", via: "cli" });
    expect(summarizeQe({ rootDir: dir, locales: ["de"] }).summary.flagged).toBe(0);
    const item = prepareBatch({ rootDir: dir, targetLocale: "de", includeTranslated: true }).items.find((i) => i.key === "intro")!;
    expect(item.reason).toBe("question_answered");
    expect(item.questions?.[0]).toMatchObject({ id: "Q1", status: "answered", answer: expect.stringContaining("Verb") });
    expect(codes(dir, "answer_pending").map((i) => i.key)).toEqual(["intro"]);

    const task = prepareQeReview({ rootDir: dir, locales: ["de"], write: false }).tasks[0];
    const introStr = task.strings.find((s) => s.key === "intro")!;
    expect(introStr.answers?.[0].answer).toContain("Verb");
    expect(task.strings.find((s) => s.key === "checkout.total")?.openQuestions?.[0].id).toBe("Q2");

    resolveQuestion(dir, "Q1");
    expect(codes(dir, "answer_pending")).toHaveLength(0);
    expect(listQuestions(dir, "open").map((q) => q.id)).toEqual(["Q2"]);
    expect(runCheck({ rootDir: dir, locale: "de" }).issues.items.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});
