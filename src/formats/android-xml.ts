import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../core/security.js";
import { FormatAdapter, FormatWriteUpdate, LocaleEntry, LocaleFileData } from "./types.js";

/**
 * Lossless Android `strings.xml` format adapter.
 *
 * - Reads `<string name="...">...</string>` (skipping `translatable="false"`) and
 *   `<plurals name="..."><item quantity="...">...</item></plurals>`.
 * - Preserves XML comments, indentation, `translatable="false"` entries, and Android
 *   format specifiers (`%1$s`, `%d`, `%2$.2f`).
 */

function decodeAndroidXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"');
}

function encodeAndroidXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "\\'");
}

export class AndroidXmlFormatAdapter implements FormatAdapter {
  readonly id = "android-xml";
  readonly extensions = [".xml"] as const;
  readonly placeholderSyntaxes = ["python-printf", "single-brace"] as const;

  readFile(filePath: string, locale: string): LocaleFileData {
    const raw = fs.readFileSync(filePath, "utf8");
    const entries = new Map<string, LocaleEntry>();

    // Match <string name="...">...</string>
    const strRe = /<string\b([^>]*)>([\s\S]*?)<\/string>/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(raw)) !== null) {
      const attrs = m[1];
      if (/\btranslatable\s*=\s*["']false["']/.test(attrs)) continue;
      const nameMatch = attrs.match(/\bname\s*=\s*["']([^"']+)["']/);
      if (!nameMatch) continue;
      const key = nameMatch[1];
      entries.set(key, {
        key,
        value: decodeAndroidXml(m[2]),
        file: filePath,
      });
    }

    // Match <plurals name="...">...</plurals>
    const pluralsRe = /<plurals\b([^>]*)>([\s\S]*?)<\/plurals>/g;
    while ((m = pluralsRe.exec(raw)) !== null) {
      const attrs = m[1];
      if (/\btranslatable\s*=\s*["']false["']/.test(attrs)) continue;
      const nameMatch = attrs.match(/\bname\s*=\s*["']([^"']+)["']/);
      if (!nameMatch) continue;
      const key = nameMatch[1];
      const plurals: Record<string, string> = {};
      const itemRe = /<item\b[^>]*\bquantity\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/item>/g;
      let im: RegExpExecArray | null;
      while ((im = itemRe.exec(m[2])) !== null) {
        plurals[im[1]] = decodeAndroidXml(im[2]);
      }
      if (Object.keys(plurals).length > 0) {
        entries.set(key, {
          key,
          value: plurals.other ?? Object.values(plurals)[0] ?? "",
          plurals,
          file: filePath,
        });
      }
    }

    return { locale, filePath, entries };
  }

  applyUpdates(
    filePath: string,
    _locale: string,
    updates: FormatWriteUpdate[],
    options?: { sourceFilePath?: string; write?: boolean }
  ): string {
    let xml = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8")
      : `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n`;

    const appended: string[] = [];

    for (const u of updates) {
      if (u.plurals && Object.keys(u.plurals).length > 0) {
        const itemsXml = Object.entries(u.plurals)
          .map(([qty, text]) => `        <item quantity="${qty}">${encodeAndroidXml(text)}</item>`)
          .join("\n");
        const block = `<plurals name="${u.key}">\n${itemsXml}\n    </plurals>`;
        const existingRe = new RegExp(
          `<plurals\\b[^>]*\\bname\\s*=\\s*["']${u.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>[\\s\\S]*?<\\/plurals>`
        );
        if (existingRe.test(xml)) {
          xml = xml.replace(existingRe, block);
        } else {
          appended.push(`    ${block}`);
        }
      } else {
        const encoded = encodeAndroidXml(u.value);
        const existingRe = new RegExp(
          `(<string\\b[^>]*\\bname\\s*=\\s*["']${u.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>)([\\s\\S]*?)(<\\/string>)`
        );
        if (existingRe.test(xml)) {
          xml = xml.replace(existingRe, `$1${encoded}$3`);
        } else {
          appended.push(`    <string name="${u.key}">${encoded}</string>`);
        }
      }
    }

    if (appended.length > 0) {
      const insertBlock = appended.join("\n") + "\n";
      if (xml.includes("</resources>")) {
        xml = xml.replace("</resources>", `${insertBlock}</resources>`);
      } else {
        xml += insertBlock;
      }
    }

    if (options?.write !== false) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      atomicWriteFileSync(filePath, xml);
    }
    return xml;
  }
}
