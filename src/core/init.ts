import fs from "node:fs";
import path from "node:path";
import { importExistingLocales } from "./importers.js";
import { atomicWriteFileSync, resolveConfinedPath } from "./security.js";
import { WraithStore } from "./store.js";
import { FrameworkName, WraithConfig, ReviewMode } from "./types.js";

function existsOrSymlink(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export const AGENT_RULE_MARKER = "<!-- wraith:rule -->";
export const AGENT_RULE_TEXT = `${AGENT_RULE_MARKER}
## Localization (Wraith)
Localization is not done until \`wraith check\` passes.
- Use Wraith MCP tools (\`scan\`, \`prepare\`, \`apply\`, \`check\`, \`report\`) to translate in context and write locale files through \`apply\`.
- Never bypass placeholder, plural, glossary, or hardcoded-string checks.
`;

export interface InitOptions {
  rootDir: string;
  sourceLocale?: string;
  targetLocales?: string[];
  review?: ReviewMode;
  framework?: FrameworkName;
  localesPath?: string;
  sourcePaths?: string[];
  documents?: string[];
  writeAgentRule?: boolean;
  installHook?: boolean;
}

export interface InitResult {
  configPath: string;
  created: boolean;
  config: WraithConfig;
  agentFilesUpdated: string[];
  hookInstalled: string | null;
  mcpConfigSnippet: Record<string, unknown>;
}

export function initProject(options: InitOptions): InitResult {
  const store = new WraithStore(options.rootDir);
  const existed = store.exists();
  const current = store.readConfig();

  const next: WraithConfig = {
    version: 1,
    sourceLocale: options.sourceLocale ?? current.sourceLocale ?? "en",
    targetLocales: options.targetLocales ?? current.targetLocales ?? [],
    review: options.review ?? current.review ?? "auto",
    framework: options.framework ?? current.framework ?? "auto",
    i18nLibrary: current.i18nLibrary,
    paths: {
      locales: options.localesPath ?? current.paths.locales,
      source: options.sourcePaths ?? current.paths.source,
      documents: options.documents ?? current.paths.documents,
      ignore: current.paths.ignore,
    },
  };

  store.writeConfig(next);
  // Ensure baseline files exist cleanly
  if (!fs.existsSync(store.filePath("glossary.json"))) {
    store.writeGlossary({ version: 1, entries: [] });
  }
  if (!fs.existsSync(store.filePath("assumptions.json"))) {
    store.writeAssumptions({ version: 1, assumptions: [] });
  }
  if (!fs.existsSync(store.filePath("reviews.json"))) {
    store.writeReviews({ version: 1, reviews: [] });
  }

  // Establish staleness baseline for any pre-existing target locale translations (L1)
  if (!existed) {
    try {
      importExistingLocales(store.rootDir);
    } catch {
      // Never fail init if locale files are not yet valid or absent
    }
  }

  const agentFilesUpdated: string[] = [];
  if (options.writeAgentRule !== false) {
    const candidates = ["AGENTS.md", "CLAUDE.md"];
    const existingTargets = candidates.filter((f) =>
      existsOrSymlink(path.join(store.rootDir, f))
    );
    const targets = existingTargets.length > 0 ? existingTargets : ["AGENTS.md"];
    for (const rel of targets) {
      const full = resolveConfinedPath(store.rootDir, rel, { label: rel });
      const existingText = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
      if (!existingText.includes(AGENT_RULE_MARKER) && !existingText.includes("wraith check")) {
        const sep = existingText.length > 0 && !existingText.endsWith("\n\n")
          ? existingText.endsWith("\n") ? "\n" : "\n\n"
          : "";
        atomicWriteFileSync(full, existingText + sep + AGENT_RULE_TEXT);
        agentFilesUpdated.push(rel);
      }
    }
  }

  let hookInstalled: string | null = null;
  if (options.installHook) {
    const dotGitPath = path.join(store.rootDir, ".git");
    if (existsOrSymlink(dotGitPath)) {
      resolveConfinedPath(store.rootDir, ".git", { label: ".git directory" });
      const stat = fs.statSync(dotGitPath);
      let gitDirRel = ".git";
      if (stat.isFile()) {
        const pointer = fs.readFileSync(dotGitPath, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/m.exec(pointer);
        if (!match) {
          throw new Error(`Cannot install pre-commit hook: invalid .git file in ${store.rootDir}`);
        }
        const resolvedGitDir = path.resolve(store.rootDir, match[1].trim());
        const rootReal = fs.realpathSync(store.rootDir);
        const relToRoot = path.relative(rootReal, resolvedGitDir);
        if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
          throw new Error(
            `Cannot install pre-commit hook automatically in a git worktree whose gitdir (${resolvedGitDir}) lies outside the workspace root. Install the hook in the main repository's .git/hooks directory instead.`
          );
        }
        gitDirRel = relToRoot;
      }
      const gitHooksDir = resolveConfinedPath(store.rootDir, path.join(gitDirRel, "hooks"), {
        label: ".git/hooks directory",
      });
      const hookPath = resolveConfinedPath(
        store.rootDir,
        path.join(gitDirRel, "hooks", "pre-commit"),
        { label: ".git/hooks/pre-commit" }
      );
      fs.mkdirSync(gitHooksDir, { recursive: true });
      const hookSnippet = `
# wraith-pre-commit
if [ -n "\${WRAITH_BIN:-}" ] && { [ -x "\${WRAITH_BIN}" ] || [ -f "\${WRAITH_BIN}" ]; }; then
  "\${WRAITH_BIN}" check
elif [ -x "./node_modules/.bin/wraith" ] || [ -f "./node_modules/.bin/wraith" ]; then
  ./node_modules/.bin/wraith check
elif command -v wraith >/dev/null 2>&1; then
  wraith check
else
  echo "wraith pre-commit hook: could not locate 'wraith' CLI." >&2
  echo "Put 'wraith' on PATH, install it in node_modules, or set WRAITH_BIN=/path/to/wraith." >&2
  exit 1
fi
`;
      if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, "utf8");
        if (!existing.includes("wraith-pre-commit")) {
          atomicWriteFileSync(hookPath, existing + hookSnippet);
        }
      } else {
        atomicWriteFileSync(hookPath, `#!/usr/bin/env sh\nset -e${hookSnippet}`);
      }
      fs.chmodSync(hookPath, 0o755);
      hookInstalled = path.relative(store.rootDir, hookPath).replace(/\\/g, "/");
    }
  }

  const mcpConfigSnippet = {
    mcpServers: {
      wraith: {
        command: "wraith",
        args: ["mcp"],
      },
    },
  };

  return {
    configPath: path.relative(store.rootDir, store.filePath("config.json")).replace(/\\/g, "/"),
    created: !existed,
    config: next,
    agentFilesUpdated,
    hookInstalled,
    mcpConfigSnippet,
  };
}
