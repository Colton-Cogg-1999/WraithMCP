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
  isConstrainedElement,
  listQuestions,
  readContextNotes,
  resolveQuestion,
  setContextNoteForKey,
  visibleCharCount,
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

  it("fails check on declared and rendered UI limits, warns on heuristic ones without re-queueing forever", () => {
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

    // Default prepare only resurfaces binding limits (checkout.total), NOT heuristic warnings (btnSave)
    const defaultPrep = prepareBatch({ rootDir: dir, targetLocale: "de" });
    expect(defaultPrep.items.map((i) => i.key)).toEqual(["checkout.total"]);
    expect(defaultPrep.items[0].reason).toBe("char_limit_exceeded");

    // With includeTranslated, heuristic overflow shows distinct reason char_limit_inferred
    const item = prepareBatch({ rootDir: dir, targetLocale: "de", includeTranslated: true }).items.find((i) => i.key === "btnSave")!;
    expect(item.reason).toBe("char_limit_inferred");
    expect(item.charLimit).toEqual({ maxChars: 12, kind: "inferred", basis: "heuristic" });

    // A rendered measurement outranks the heuristic and IS binding (error in check + resurfaced in default prepare)
    new WraithStore(dir).setLayoutBudget("btnSave", "de", { maxWidthPx: 96, budgetChars: 14, element: "button", updatedAt: "2026-01-01T00:00:00Z" });
    expect(codes(dir, "char_limit_inferred")).toHaveLength(0);
    const renderedExceeded = codes(dir, "layout_budget_exceeded");
    expect(renderedExceeded).toHaveLength(1);
    expect(renderedExceeded[0].severity).toBe("error");
    expect(renderedExceeded[0].message).not.toContain("record an Open Question");
    expect(prepareBatch({ rootDir: dir, targetLocale: "de" }).items.find((i) => i.key === "btnSave")?.reason).toBe("layout_budget_exceeded");

    // Widening the rendered budget clears the error
    new WraithStore(dir).setLayoutBudget("btnSave", "de", { maxWidthPx: 200, budgetChars: 30, element: "button", updatedAt: "2026-01-01T00:00:00Z" });
    expect(codes(dir, "layout_budget_exceeded")).toHaveLength(0);
  });

  it("counts visible rendered characters across ICU branches, placeholders, and inline tags", () => {
    expect(visibleCharCount("Save")).toBe(4);
    // {longVariableName} counts as 4 nominal chars, not 18
    expect(visibleCharCount("Hi {longVariableName}!")).toBe(8); // "Hi " (3) + 4 + "!" (1)
    // Inline HTML tags stripped, inner text preserved
    expect(visibleCharCount("Read <b>the terms</b>")).toBe(14);
    // ICU plural takes max branch (# = 2 chars), ignoring raw ICU keywords/braces
    expect(visibleCharCount("{count, plural, one {# item} other {# items}}")).toBe(8); // "12 items" = 8, not 45!

    const dir = project({}, { "checkout.*": 12 });
    fs.writeFileSync(
      path.join(dir, "messages/en.json"),
      JSON.stringify(
        {
          btnSave: "Save",
          intro: "Welcome",
          checkout: {
            total: "{count, plural, one {# item} other {# items}}",
            couponHint: "Hello {customerDisplayName}",
          },
        },
        null,
        2
      )
    );
    applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "btnSave", value: "Speichern" },
        { key: "intro", value: "Willkommen" },
        { key: "checkout.total", value: "{count, plural, one {# Artikel} other {# Artikel}}" },
        { key: "checkout.couponHint", value: "Hallo {customerDisplayName}" },
      ],
    });
    // Raw checkout.total is 50 chars, visible max branch is "12 Artikel" (10 chars <= 12)
    // Raw checkout.couponHint is 27 chars, visible is "Hallo " (6) + 4 = 10 chars <= 12
    expect(codes(dir, "char_limit_exceeded")).toHaveLength(0);
    const chk = runCheck({ rootDir: dir, locale: "de" });
    expect(chk.errorCount).toBe(0);
    expect(chk.outcome).toBe("PASS");

    // Exceeding the 12-char limit on visible characters DOES fail check
    applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [{ key: "checkout.total", value: "{count, plural, one {# Bestellartikel} other {# Bestellartikel}}" }],
    });
    expect(codes(dir, "char_limit_exceeded").map((i) => i.key)).toEqual(["checkout.total"]);
  });

  it("matches constrained UI elements by word boundaries and checks all usage sites", () => {
    for (const pos of ["button", "IconButton", "SubmitBtn", "tab", "Tab", "TabsTrigger", "nav-link", "NavItem", "MenuItem", "Badge", "StatusChip", "Tag", "Tooltip"]) {
      expect(isConstrainedElement(pos)).toBe(true);
    }
    for (const neg of ["div", "p", "span", "table", "Table", "TableRow", "TableCell", "DataTable", "NavigationContainer", "StableLayout"]) {
      expect(isConstrainedElement(neg)).toBe(false);
    }

    // Multi-site key: first site is <p> (unconstrained), second site is <button> (constrained) -> gets heuristic limit
    const dir = project({ btnSave: "Speichern", intro: "Veröffentliche jetzt sofort dein allererstes Update hier", "checkout.total": "Summe", "checkout.couponHint": "Code?" });
    fs.writeFileSync(
      path.join(dir, "src/Panel.tsx"),
      `import { useTranslations } from "next-intl";
export function Panel() {
  const t = useTranslations();
  return <div><TableCell>{t("checkout.total")}</TableCell><p>{t("intro")}</p><button>{t("intro")}</button><button>{t("btnSave")}</button><span>{t("checkout.couponHint")}</span></div>;
}
declare const TableCell: any;
`
    );
    // checkout.total in <TableCell> must NOT get a heuristic limit even if stretched
    const de = JSON.parse(fs.readFileSync(path.join(dir, "messages/de.json"), "utf8"));
    de.checkout.total = "Gesamtbetrag inklusive Mehrwertsteuer";
    fs.writeFileSync(path.join(dir, "messages/de.json"), JSON.stringify(de, null, 2));

    const inf = codes(dir, "char_limit_inferred").map((i) => i.key);
    expect(inf).toContain("intro"); // seen on second site (<button>)
    expect(inf).not.toContain("checkout.total"); // <TableCell> is not a <Tab>
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
    submitQeVerdicts({ rootDir: dir, verdicts: [{ locale: "de", key: "intro", target: "Veröffentliche dein erstes Update", verdict: "flag", reason: "Unclear meaning: Post verb or noun?" }] });
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
