import fs from "node:fs";
import path from "node:path";
import { importExistingLocales } from "./importers.js";
import { PolyglotStore } from "./store.js";
import { FrameworkName, PolyglotConfig, ReviewMode } from "./types.js";

export const AGENT_RULE_MARKER = "<!-- polyglot:rule -->";
export const AGENT_RULE_TEXT = `${AGENT_RULE_MARKER}
## Localization (Polyglot)
Localization is not done until \`polyglot check\` passes.
- Use Polyglot MCP tools (\`scan\`, \`prepare\`, \`apply\`, \`check\`, \`report\`) to translate in context and write locale files through \`apply\`.
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
  config: PolyglotConfig;
  agentFilesUpdated: string[];
  hookInstalled: string | null;
  mcpConfigSnippet: Record<string, unknown>;
}

export function initProject(options: InitOptions): InitResult {
  const store = new PolyglotStore(options.rootDir);
  const existed = store.exists();
  const current = store.readConfig();

  const next: PolyglotConfig = {
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
      fs.existsSync(path.join(store.rootDir, f))
    );
    const targets = existingTargets.length > 0 ? existingTargets : ["AGENTS.md"];
    for (const rel of targets) {
      const full = path.join(store.rootDir, rel);
      const existingText = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
      if (!existingText.includes(AGENT_RULE_MARKER) && !existingText.includes("polyglot check")) {
        const sep = existingText.length > 0 && !existingText.endsWith("\n\n")
          ? existingText.endsWith("\n") ? "\n" : "\n\n"
          : "";
        fs.writeFileSync(full, existingText + sep + AGENT_RULE_TEXT, "utf8");
        agentFilesUpdated.push(rel);
      }
    }
  }

  let hookInstalled: string | null = null;
  if (options.installHook) {
    const gitHooksDir = path.join(store.rootDir, ".git", "hooks");
    if (fs.existsSync(path.join(store.rootDir, ".git"))) {
      fs.mkdirSync(gitHooksDir, { recursive: true });
      const hookPath = path.join(gitHooksDir, "pre-commit");
      const hookSnippet = `
# polyglot-pre-commit
if [ -n "\${POLYGLOT_BIN:-}" ] && [ -x "\${POLYGLOT_BIN}" ]; then
  "\${POLYGLOT_BIN}" check
elif [ -x "./node_modules/.bin/polyglot" ]; then
  ./node_modules/.bin/polyglot check
elif command -v polyglot >/dev/null 2>&1; then
  polyglot check
elif [ -f "./dist/bin.js" ] && command -v node >/dev/null 2>&1; then
  node ./dist/bin.js check
else
  echo "polyglot pre-commit hook: could not locate 'polyglot' CLI." >&2
  echo "Install locally (npm install -D polyglot-mcp), put 'polyglot' on PATH, or set POLYGLOT_BIN=/path/to/polyglot." >&2
  exit 1
fi
`;
      if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, "utf8");
        if (!existing.includes("polyglot-pre-commit")) {
          fs.writeFileSync(hookPath, existing + hookSnippet, { mode: 0o755 });
        }
      } else {
        fs.writeFileSync(
          hookPath,
          `#!/usr/bin/env sh\nset -e${hookSnippet}`,
          { mode: 0o755 }
        );
      }
      fs.chmodSync(hookPath, 0o755);
      hookInstalled = path.relative(store.rootDir, hookPath);
    }
  }

  const mcpConfigSnippet = {
    mcpServers: {
      polyglot: {
        command: "polyglot",
        args: ["mcp"],
      },
    },
  };

  return {
    configPath: path.relative(store.rootDir, store.filePath("config.json")),
    created: !existed,
    config: next,
    agentFilesUpdated,
    hookInstalled,
    mcpConfigSnippet,
  };
}
