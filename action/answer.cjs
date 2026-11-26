"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ANSWER_LINE_RE = /^\s*\/wraith\s+answer\s+([QA]\d+)\s*:?\s+(.+?)\s*$/i;
const STATE_PATHS = [".wraith/questions.json", ".wraith/assumptions.json"];

function isAllowedAuthorAssociation(association) {
  return ALLOWED_ASSOCIATIONS.has(String(association || ""));
}

function parseAnswerComment(body) {
  const lines = String(body || "").split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const m = ANSWER_LINE_RE.exec(line);
    if (!m) continue;
    entries.push({ id: m[1].toUpperCase(), text: m[2] });
  }
  return entries;
}

function buildAnswerArgs(wraithBin, id, text) {
  // '--' prevents Commander from parsing answers starting with '-' (e.g. '--help') as CLI flags.
  return [wraithBin, "answer", "--", String(id).toUpperCase(), String(text)];
}

function existingStatePaths(cwd) {
  return STATE_PATHS.filter((rel) => fs.existsSync(path.join(cwd, rel)));
}

function firstErrorLine(err) {
  const raw = String((err && (err.stderr || err.message)) || err || "unknown error").trim();
  return raw.split(/\r?\n/)[0] || "unknown error";
}

function formatAnswerReply({ done, failed, pushed, pushError }) {
  let body = "";
  if (done.length > 0) {
    body += `Recorded:\n${done.map((d) => `- **${d.id}**: ${d.text}`).join("\n")}\n\n`;
    if (pushed) {
      body +=
        "Committed to this branch. The affected strings now show as `answer_pending` / `assumption_overridden` until an agent revisits them (comment `/localize` if the Wraith localize workflow is installed).\n";
    } else if (pushError) {
      body += `⚠️ Could not commit/push to this branch (\`${pushError}\`). Re-run locally with \`wraith answer\` or check branch/fork permissions.\n`;
    } else {
      body += "No new changes needed to be committed.\n";
    }
  }
  if (failed.length > 0) {
    body += `${body ? "\n" : ""}Could not record:\n${failed.map((f) => `- **${f.id}**: ${f.error}`).join("\n")}\n`;
  }
  return body;
}

module.exports = {
  ALLOWED_ASSOCIATIONS,
  STATE_PATHS,
  isAllowedAuthorAssociation,
  parseAnswerComment,
  buildAnswerArgs,
  existingStatePaths,
  firstErrorLine,
  formatAnswerReply,
};
