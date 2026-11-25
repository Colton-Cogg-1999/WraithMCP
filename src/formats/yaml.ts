import fs from "node:fs";
import path from "node:path";
import { Document, isMap, isPair, isScalar, parseDocument, YAMLMap } from "yaml";
import { atomicWriteFileSync } from "../core/security.js";
import {
  FormatAdapter,
  FormatWriteUpdate,
  LocaleEntry,
  LocaleFileData,
} from "./types.js";

const PLURAL_SUBKEYS = new Set(["zero", "one", "two", "few", "many", "other"]);

function isPluralMap(node: YAMLMap): boolean {
  if (node.items.length === 0) return false;
  let hasOther = false;
  for (const item of node.items) {
    if (!isPair(item) || !isScalar(item.key) || !isScalar(item.value)) return false;
    const k = String(item.key.value);
    if (!PLURAL_SUBKEYS.has(k)) return false;
    if (k === "other") hasOther = true;
  }
  return hasOther;
}

function walkYamlMap(
  map: YAMLMap,
  prefix: string,
  filePath: string,
  out: Map<string, LocaleEntry>
): void {
  for (const item of map.items) {
    if (!isPair(item) || !isScalar(item.key)) continue;
    const keyPart = String(item.key.value);
    const fullKey = prefix ? `${prefix}.${keyPart}` : keyPart;
    const val = item.value;

    if (isScalar(val) && typeof val.value === "string") {
      const comment = item.key.commentBefore?.trim() || val.comment?.trim() || undefined;
      out.set(fullKey, { key: fullKey, value: val.value, comment, file: filePath });
    } else if (isMap(val)) {
      if (isPluralMap(val)) {
        const plurals: Record<string, string> = {};
        for (const pItem of val.items) {
          if (isPair(pItem) && isScalar(pItem.key) && isScalar(pItem.value)) {
            plurals[String(pItem.key.value)] = String(pItem.value.value ?? "");
          }
        }
        out.set(fullKey, {
          key: fullKey,
          value: plurals.other ?? Object.values(plurals)[0] ?? "",
          plurals,
          file: filePath,
        });
      } else {
        walkYamlMap(val, fullKey, filePath, out);
      }
    }
  }
}

export class RailsYamlFormatAdapter implements FormatAdapter {
  readonly id = "rails-yaml";
  readonly extensions = [".yml", ".yaml"] as const;
  readonly placeholderSyntaxes = ["percent-brace"] as const;

  readFile(filePath: string, locale: string): LocaleFileData {
    const entries = new Map<string, LocaleEntry>();
    if (!fs.existsSync(filePath)) return { locale, filePath, entries };
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return { locale, filePath, entries };

    const doc = parseDocument(raw);
    if (!isMap(doc.contents)) return { locale, filePath, entries };

    // Rails YAML wraps all keys under the top-level locale key (e.g. `en:` or `es-MX:`)
    const rootNode = doc.contents.get(locale, true);
    if (isMap(rootNode)) {
      walkYamlMap(rootNode, "", filePath, entries);
    } else if (doc.contents.items.length === 1 && isPair(doc.contents.items[0]) && isMap(doc.contents.items[0].value)) {
      walkYamlMap(doc.contents.items[0].value, "", filePath, entries);
    } else {
      walkYamlMap(doc.contents, "", filePath, entries);
    }

    return { locale, filePath, entries };
  }

  applyUpdates(
    filePath: string,
    locale: string,
    updates: FormatWriteUpdate[],
    options?: { sourceFilePath?: string; write?: boolean }
  ): string {
    const existed = fs.existsSync(filePath);
    let doc: Document;
    if (existed) {
      doc = parseDocument(fs.readFileSync(filePath, "utf8"));
    } else {
      doc = parseDocument(`${locale}: {}\n`);
    }

    if (!isMap(doc.contents)) {
      doc = parseDocument(`${locale}: {}\n`);
    }

    // Ensure top-level locale key is a YAMLMap
    if (!isMap(doc.get(locale, true))) {
      doc.set(locale, doc.createNode({}));
    }

    for (const u of updates) {
      const pathParts = [locale, ...u.key.split(".")];
      // Ensure intermediate maps exist cleanly without disturbing comments
      for (let i = 1; i < pathParts.length - 1; i++) {
        const subPath = pathParts.slice(0, i + 1);
        if (!isMap(doc.getIn(subPath, true))) {
          doc.setIn(subPath, doc.createNode({}));
        }
      }
      if (u.plurals && Object.keys(u.plurals).length > 0) {
        if (!isMap(doc.getIn(pathParts, true))) {
          doc.setIn(pathParts, doc.createNode({}));
        }
        for (const [pk, pv] of Object.entries(u.plurals)) {
          doc.setIn([...pathParts, pk], pv);
        }
      } else {
        doc.setIn(pathParts, u.value);
      }
    }

    const serialized = doc.toString({ indent: 2, lineWidth: 0 });
    if (options?.write !== false) {
      atomicWriteFileSync(filePath, serialized);
    }
    return serialized;
  }
}
