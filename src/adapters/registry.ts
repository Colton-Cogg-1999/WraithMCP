import fs from "node:fs";
import path from "node:path";
import { FrameworkName } from "../core/types.js";
import { LocaleEntry } from "../formats/types.js";
import { AndroidAdapter } from "./android.js";
import { AstroAdapter } from "./astro.js";
import { DjangoAdapter } from "./django.js";
import { ElectronAdapter } from "./electron.js";
import { FlutterAdapter } from "./flutter.js";
import { IosAdapter } from "./ios.js";
import { RailsAdapter } from "./rails.js";
import { ReactNextAdapter } from "./react.js";
import { SvelteKitAdapter } from "./svelte.js";
import { FrameworkDetection, ScannerAdapter } from "./types.js";
import { VueNuxtAdapter } from "./vue.js";
import { GettextPoFormatAdapter } from "../formats/po.js";

const adapters: ScannerAdapter[] = [
  new ReactNextAdapter(),
  new VueNuxtAdapter(),
  new SvelteKitAdapter(),
  new AstroAdapter(),
  new ElectronAdapter(),
  new FlutterAdapter(),
  new AndroidAdapter(),
  new IosAdapter(),
  new RailsAdapter(),
  new DjangoAdapter(),
];

export function registerAdapter(adapter: ScannerAdapter): void {
  if (!adapters.some((a) => a.id === adapter.id)) {
    adapters.push(adapter);
  }
}

export function listAdapters(): readonly ScannerAdapter[] {
  return adapters;
}

function findWorkspaceAppDirs(absRoot: string): string[] {
  const candidates: string[] = [];
  const pkgPath = path.join(absRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const patterns = Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : Array.isArray(pkg.workspaces?.packages)
          ? pkg.workspaces.packages
          : [];
      for (const pat of patterns) {
        const clean = pat.replace(/\/\*$/, "").replace(/\/$/, "");
        const baseDir = path.join(absRoot, clean);
        if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) continue;
        if (pat.endsWith("*")) {
          for (const entry of fs.readdirSync(baseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
              candidates.push(path.join(baseDir, entry.name));
            }
          }
        } else {
          candidates.push(baseDir);
        }
      }
    } catch {
      // ignore invalid package.json
    }
  }
  for (const fallback of ["apps", "packages"]) {
    const dir = path.join(absRoot, fallback);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        candidates.push(path.join(dir, entry.name));
      }
    }
  }
  return [...new Set(candidates)];
}

export function detectProjectAdapter(
  rootDir: string,
  frameworkOverride?: string,
  localesPathOverride?: string
): { adapter: ScannerAdapter | null; detection: FrameworkDetection } {
  const resolvedRoot = path.resolve(rootDir);
  let absRoot = resolvedRoot;
  try {
    absRoot = fs.realpathSync(resolvedRoot);
  } catch {
    absRoot = resolvedRoot;
  }

  if (frameworkOverride && frameworkOverride !== "auto" && frameworkOverride !== "unknown") {
    const forced = adapters.find((a) =>
      a.frameworks.includes(frameworkOverride as FrameworkName)
    );
    if (forced) {
      const det = forced.detect(absRoot, localesPathOverride);
      if (det) return { adapter: forced, detection: det };
      return {
        adapter: forced,
        detection: {
          framework: frameworkOverride as FrameworkName,
          i18nLibrary: null,
          confidence: 1,
          localesDir: localesPathOverride ?? null,
          localeFiles: {},
          placeholderSyntaxes: [...forced.format.placeholderSyntaxes],
          notes: [],
        },
      };
    }
  }

  let best: { adapter: ScannerAdapter; detection: FrameworkDetection } | null = null;
  for (const adapter of adapters) {
    const det = adapter.detect(absRoot, localesPathOverride);
    if (det && (!best || det.confidence > best.detection.confidence)) {
      best = { adapter, detection: det };
    }
  }

  if (best) return best;

  // Monorepo fallback: inspect workspace sub-packages (e.g. apps/web)
  const subDirs = findWorkspaceAppDirs(absRoot);
  const subMatches: Array<{ subDir: string; adapter: ScannerAdapter; detection: FrameworkDetection }> = [];
  for (const subDir of subDirs) {
    let subBest: { adapter: ScannerAdapter; detection: FrameworkDetection } | null = null;
    for (const adapter of adapters) {
      const det = adapter.detect(subDir, localesPathOverride);
      if (det && (!subBest || det.confidence > subBest.detection.confidence)) {
        subBest = { adapter, detection: det };
      }
    }
    if (subBest) {
      subMatches.push({ subDir, ...subBest });
    }
  }

  if (subMatches.length === 1) {
    const m = subMatches[0];
    const relSub = path.relative(absRoot, m.subDir).replace(/\\/g, "/");
    return {
      adapter: m.adapter,
      detection: {
        ...m.detection,
        localesDir: m.detection.localesDir
          ? path.posix.join(relSub, m.detection.localesDir)
          : null,
        notes: [
          ...m.detection.notes,
          `Detected workspace app in "${relSub}".`,
        ],
      },
    };
  }

  if (subMatches.length > 1) {
    const names = subMatches.map((m) => path.relative(absRoot, m.subDir).replace(/\\/g, "/"));
    return {
      adapter: null,
      detection: {
        framework: "unknown",
        i18nLibrary: null,
        confidence: 0,
        localesDir: null,
        localeFiles: {},
        placeholderSyntaxes: ["icu"],
        notes: [
          `Monorepo with multiple apps detected (${names.join(", ")}). Run Wraith with --cwd <app-dir> or configure paths.source and paths.locales.`,
        ],
      },
    };
  }

  return {
    adapter: null,
    detection: {
      framework: "unknown",
      i18nLibrary: null,
      confidence: 0,
      localesDir: null,
      localeFiles: {},
      placeholderSyntaxes: ["icu"],
      notes: ["No supported web framework detected (checked React/Next.js, Vue/Nuxt, SvelteKit, Rails, Django)."],
    },
  };
}

export interface LoadedLocaleCatalog {
  entries: Map<string, LocaleEntry>;
  keyToFile: Map<string, string>;
  files: string[];
  errors: Array<{ file: string; locale: string; error: string }>;
  unsupportedConstructs: Array<{ file: string; key?: string; description: string }>;
}

export function loadLocaleCatalog(
  adapter: ScannerAdapter,
  files: string[],
  locale: string
): LoadedLocaleCatalog {
  const entries = new Map<string, LocaleEntry>();
  const keyToFile = new Map<string, string>();
  const errors: Array<{ file: string; locale: string; error: string }> = [];
  const unsupportedConstructs: Array<{ file: string; key?: string; description: string }> = [];

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const data = adapter.format.readFile(file, locale);
      const useNamespacePrefix =
        files.length > 1 && path.basename(path.dirname(file)) === locale;
      const ns = path.basename(file, path.extname(file));

      for (const [key, entry] of data.entries) {
        const fullKey = useNamespacePrefix && !key.startsWith(`${ns}.`) ? `${ns}.${key}` : key;
        entries.set(fullKey, { ...entry, key: fullKey, file });
        keyToFile.set(fullKey, file);
      }
      if (data.unsupportedConstructs) {
        for (const u of data.unsupportedConstructs) {
          unsupportedConstructs.push({ file, ...u });
        }
      }
    } catch (err) {
      errors.push({
        file,
        locale,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { entries, keyToFile, files, errors, unsupportedConstructs };
}

/**
 * Load the authoritative source catalog for a project.
 * For Django/gettext projects where `django-admin makemessages` generates target `.po`
 * files without an English `.po` (or with empty `msgstr`s), extracts source strings
 * directly from `msgid` / `msgid_plural`.
 */
export function loadSourceCatalog(
  adapter: ScannerAdapter,
  detection: FrameworkDetection,
  sourceLocale: string
): LoadedLocaleCatalog {
  const srcFiles = detection.localeFiles[sourceLocale] ?? [];

  if (adapter.format instanceof GettextPoFormatAdapter) {
    const poFormat = adapter.format;
    const candidateFiles =
      srcFiles.length > 0
        ? srcFiles
        : Object.values(detection.localeFiles).flat();
    const entries = new Map<string, LocaleEntry>();
    const keyToFile = new Map<string, string>();
    const errors: Array<{ file: string; locale: string; error: string }> = [];
    const unsupportedConstructs: Array<{ file: string; key?: string; description: string }> = [];

    for (const file of candidateFiles) {
      if (!fs.existsSync(file)) continue;
      try {
        const data = poFormat.readSourceFromMsgids(file, sourceLocale);
        for (const [k, entry] of data.entries) {
          if (!entries.has(k)) {
            entries.set(k, { ...entry, file });
            keyToFile.set(k, file);
          }
        }
      } catch (err) {
        errors.push({
          file,
          locale: sourceLocale,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { entries, keyToFile, files: candidateFiles, errors, unsupportedConstructs };
  }

  return loadLocaleCatalog(adapter, srcFiles, sourceLocale);
}
