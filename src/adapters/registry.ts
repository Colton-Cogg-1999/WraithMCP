import fs from "node:fs";
import path from "node:path";
import { FrameworkName } from "../core/types.js";
import { LocaleEntry } from "../formats/types.js";
import { DjangoAdapter } from "./django.js";
import { RailsAdapter } from "./rails.js";
import { ReactNextAdapter } from "./react.js";
import { SvelteKitAdapter } from "./svelte.js";
import { FrameworkDetection, ScannerAdapter } from "./types.js";
import { VueNuxtAdapter } from "./vue.js";

const adapters: ScannerAdapter[] = [
  new ReactNextAdapter(),
  new VueNuxtAdapter(),
  new SvelteKitAdapter(),
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

export function detectProjectAdapter(
  rootDir: string,
  frameworkOverride?: string,
  localesPathOverride?: string
): { adapter: ScannerAdapter | null; detection: FrameworkDetection } {
  const absRoot = path.resolve(rootDir);

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
}

export function loadLocaleCatalog(
  adapter: ScannerAdapter,
  files: string[],
  locale: string
): LoadedLocaleCatalog {
  const entries = new Map<string, LocaleEntry>();
  const keyToFile = new Map<string, string>();

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const data = adapter.format.readFile(file, locale);
    const useNamespacePrefix =
      files.length > 1 && path.basename(path.dirname(file)) === locale;
    const ns = path.basename(file, path.extname(file));

    for (const [key, entry] of data.entries) {
      const fullKey = useNamespacePrefix && !key.startsWith(`${ns}.`) ? `${ns}.${key}` : key;
      entries.set(fullKey, { ...entry, key: fullKey, file });
      keyToFile.set(fullKey, file);
    }
  }

  return { entries, keyToFile, files };
}
