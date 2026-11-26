import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { askQuestion, listAssumptions, listQuestions } from "../src/core/context.js";
import { initProject } from "../src/core/init.js";
import { recordAssumption } from "../src/core/memory-ops.js";

ensureBootstrapped();

const require = createRequire(import.meta.url);
const helper = require("../action/answer.cjs") as {
  isAllowedAuthorAssociation: (a: string) => boolean;
  parseAnswerComment: (body: string) => Array<{ id: string; text: string }>;
  buildAnswerArgs: (bin: string, id: string, text: string) => string[];
  existingStatePaths: (cwd: string) => string[];
  firstErrorLine: (err: unknown) => string;
  formatAnswerReply: (opts: {
    done: Array<{ id: string; text: string }>;
    failed: Array<{ id: string; error: string }>;
    pushed: boolean;
    pushError?: string;
  }) => string;
};

const REPO_ROOT = path.resolve(__dirname, "..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const WRAITH_BIN = path.join(REPO_ROOT, "src/bin.ts");

describe("GitHub Action /wraith answer helper & CLI safety", () => {
  it("parses Q/A lines, preserves shell metacharacters & leading dashes, and ignores unrelated text", () => {
    const comment = [
      "Looks good overall!",
      "  /wraith answer Q1: It's a verb; do NOT execute $(whoami) or `id`",
      "/wraith   answer   a2   --help -v --json",
      "/wraith answer Qabc invalid id",
      "/wraith answer Q3",
      "```",
      "not an answer line",
    ].join("\n");

    expect(helper.parseAnswerComment(comment)).toEqual([
      { id: "Q1", text: "It's a verb; do NOT execute $(whoami) or `id`" },
      { id: "A2", text: "--help -v --json" },
    ]);
  });

  it("checks collaborator associations strictly", () => {
    expect(helper.isAllowedAuthorAssociation("OWNER")).toBe(true);
    expect(helper.isAllowedAuthorAssociation("MEMBER")).toBe(true);
    expect(helper.isAllowedAuthorAssociation("COLLABORATOR")).toBe(true);
    expect(helper.isAllowedAuthorAssociation("CONTRIBUTOR")).toBe(false);
    expect(helper.isAllowedAuthorAssociation("FIRST_TIME_CONTRIBUTOR")).toBe(false);
    expect(helper.isAllowedAuthorAssociation("NONE")).toBe(false);
  });

  it("filters existing .wraith state files so overriding A1 without questions.json never fails git add", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-act-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } })
    );
    fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify({ save: "Save" }));
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    recordAssumption(dir, { category: "tone", locale: "de", summary: "Formal Sie" });

    // Before any question is asked, only assumptions.json exists
    expect(fs.existsSync(path.join(dir, ".wraith/questions.json"))).toBe(false);
    expect(helper.existingStatePaths(dir)).toEqual([".wraith/assumptions.json"]);

    // Run real CLI with buildAnswerArgs on A1 whose text starts with '--help'
    const a1Args = helper.buildAnswerArgs(WRAITH_BIN, "a1", "--help use informal du instead");
    execFileSync(process.execPath, [TSX_CLI, ...a1Args], { cwd: dir, stdio: "pipe" });
    expect(listAssumptions(dir)[0]).toMatchObject({
      label: "A1",
      status: "overridden",
      override: "--help use informal du instead",
    });

    // Now ask Q1 and answer it with leading '-x $(touch /tmp/pwn)'
    askQuestion(dir, { keys: ["save"], question: "Save file or save money?" });
    expect(helper.existingStatePaths(dir)).toEqual([".wraith/questions.json", ".wraith/assumptions.json"]);

    const q1Args = helper.buildAnswerArgs(WRAITH_BIN, "Q1", "-x $(echo not_executed)");
    execFileSync(process.execPath, [TSX_CLI, ...q1Args], { cwd: dir, stdio: "pipe" });
    expect(listQuestions(dir, "answered")[0]).toMatchObject({
      id: "Q1",
      answer: "-x $(echo not_executed)",
    });
  });

  it("formats reply clearly both when pushed and when git push fails", () => {
    const okReply = helper.formatAnswerReply({
      done: [{ id: "Q1", text: "Social post" }],
      failed: [],
      pushed: true,
    });
    expect(okReply).toContain("Recorded:\n- **Q1**: Social post");
    expect(okReply).toContain("Committed to this branch.");

    const pushFailReply = helper.formatAnswerReply({
      done: [{ id: "A1", text: "Use du" }],
      failed: [{ id: "Q99", error: "Error: no question Q99" }],
      pushed: false,
      pushError: "remote: Permission to repo denied",
    });
    expect(pushFailReply).toContain("Could not commit/push to this branch (`remote: Permission to repo denied`)");
    expect(pushFailReply).toContain("Could not record:\n- **Q99**: Error: no question Q99");
  });
});
