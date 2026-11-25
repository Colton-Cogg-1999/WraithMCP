import { describe, expect, it } from "vitest";
import { validateTranslationString } from "../src/index.js";

describe("vue-i18n per-branch pipe plural placeholder validation (N8)", () => {
  it("accepts multi-branch Slavic pipe plurals where {count} appears once per non-zero branch", () => {
    const src = "no messages | one message | {count} messages";
    const pl = "brak wiadomości | {count} wiadomość | {count} wiadomości | {count} wiadomości";
    expect(validateTranslationString(src, pl, "pl", ["single-brace"])).toEqual([]);
  });

  it("rejects different branch counts when a plural branch drops a required placeholder", () => {
    const src = "no cars | one car | {count} cars";
    // Missing {count} in branch 3 (few)
    const missingInFew = "нет машин | {count} машина | машины | {count} машин";
    const res1 = validateTranslationString(src, missingInFew, "ru", ["single-brace"]);
    expect(res1.some((p) => p.code === "placeholder_mismatch")).toBe(true);

    // Missing {count} in last branch (many)
    const missingInMany = "нет машин | {count} машина | {count} машины | машин";
    const res2 = validateTranslationString(src, missingInMany, "ru", ["single-brace"]);
    expect(res2.some((p) => p.code === "placeholder_mismatch")).toBe(true);

    // Missing universal {user} placeholder in branch 0 when all source branches use {user}
    const srcWithUser = "{user}: no files | {user}: one file | {user}: {count} files";
    const missingUser = "нет файлов | {user}: {count} файл | {user}: {count} файла | {user}: {count} файлов";
    const res3 = validateTranslationString(srcWithUser, missingUser, "ru", ["single-brace"]);
    expect(res3.some((p) => p.code === "placeholder_mismatch")).toBe(true);

    // Rejects duplicating {count} twice in a single branch
    const dupInBranch = "нет машин | {count} машина | {count} {count} машины | {count} машин";
    const res4 = validateTranslationString(src, dupInBranch, "ru", ["single-brace"]);
    expect(res4.some((p) => p.code === "placeholder_mismatch")).toBe(true);
  });
});
