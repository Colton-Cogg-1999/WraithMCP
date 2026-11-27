import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReactNextAdapter } from "../src/adapters/react.js";
import { runCheck } from "../src/core/check.js";
import { prepareBatch } from "../src/core/prepare.js";
import { prepareQeReview } from "../src/core/qe.js";
import { WraithStore } from "../src/core/store.js";
import { mcpTextResult } from "../src/mcp/formatting.js";

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("react-intl, token optimizations, and QE context parity", () => {
  it("detects react-intl, discovers app/javascript/mastodon/locales, and maps FormattedMessage / defineMessages / formatMessage without false-positive hardcoded strings", () => {
    const dir = makeTmpDir("wraith-react-intl-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0", "react-intl": "7.0.0" } })
    );
    fs.mkdirSync(path.join(dir, "app/javascript/mastodon/locales"), { recursive: true });
    fs.mkdirSync(path.join(dir, "app/javascript/mastodon/components"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "app/javascript/mastodon/locales/en.json"),
      JSON.stringify({
        "account.follow": "Follow",
        "account.unfollow": "Unfollow",
        "account.mute": "Mute {name}",
        "account.block": "Block",
      })
    );
    fs.writeFileSync(
      path.join(dir, "app/javascript/mastodon/components/AccountActions.tsx"),
      `import { FormattedMessage, defineMessages, useIntl } from 'react-intl';
const messages = defineMessages({
  unfollow: { id: 'account.unfollow', defaultMessage: 'Unfollow' },
  mute: { id: 'account.mute', defaultMessage: 'Mute {name}' },
});
export function AccountActions({ name }: { name: string }) {
  const intl = useIntl();
  const label = intl.formatMessage(messages.mute, { name });
  const blockLabel = intl.formatMessage({ id: 'account.block', defaultMessage: 'Block' });
  return (
    <div>
      <button><FormattedMessage id="account.follow" defaultMessage="Follow" /></button>
      <button title={label}><FormattedMessage {...messages.unfollow} /></button>
      <button>{blockLabel}</button>
    </div>
  );
}
`
    );

    const adapter = new ReactNextAdapter();
    const det = adapter.detect(dir);
    expect(det).not.toBeNull();
    expect(det!.i18nLibrary).toBe("react-intl");
    expect(det!.localesDir).toBe("app/javascript/mastodon/locales");

    const scan = adapter.scanSource(dir, {
      sourcePaths: ["app/javascript/mastodon"],
      ignore: ["node_modules/**"],
      i18nLibrary: det!.i18nLibrary,
    });
    expect(Object.keys(scan.usageByKey).sort()).toEqual([
      "account.block",
      "account.follow",
      "account.mute",
      "account.unfollow",
    ]);
    // defaultMessage props on FormattedMessage must not be flagged as hardcoded strings
    expect(scan.hardcodedStrings.filter((h) => h.text === "Follow")).toHaveLength(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("delivers full linguistic & contextual parity to fresh-context QE and uses compact MCP JSON", () => {
    const dir = makeTmpDir("wraith-qe-parity-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0", "react-intl": "7.0.0" } })
    );
    fs.mkdirSync(path.join(dir, "locales"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "locales/en.json"),
      JSON.stringify({ "nav.boost": "Boost {count} posts" })
    );
    fs.writeFileSync(
      path.join(dir, "locales/es-MX.json"),
      JSON.stringify({ "nav.boost": "Impulsar {count} publicaciones" })
    );
    fs.writeFileSync(
      path.join(dir, "src/Nav.tsx"),
      `import { FormattedMessage } from 'react-intl';
export function Nav() { return <button><FormattedMessage id="nav.boost" defaultMessage="Boost {count} posts" /></button>; }
`
    );

    const store = new WraithStore(dir);
    store.ensureDir();
    store.writeConfig({
      ...store.readConfig(),
      framework: "react",
      sourceLocale: "en",
      targetLocales: ["es-MX"],
      paths: { locales: "locales", source: ["src"], ignore: ["node_modules/**"] },
      styleGuide: {
        instructions: "Keep UI buttons concise and idiomatic.",
        translationPrompt: "Always use Mexican Spanish vocabulary.",
        qePrompt: "Flag Spain-only lexical choices.",
        byLocale: { "es-MX": "Use informal tú for consumer UI." },
      },
    });
    const now = new Date().toISOString();
    store.writeGlossary({
      version: 1,
      entries: [
        { term: "Mastodon", doNotTranslate: true, caseSensitive: true, translations: {}, updatedAt: now },
        { term: "Boost", doNotTranslate: false, caseSensitive: false, translations: { "es-MX": "Impulsar" }, updatedAt: now },
      ],
    });

    const qe = prepareQeReview({ rootDir: dir, locales: ["es-MX"], write: false });
    expect(qe.instructions).toContain("Keep UI buttons concise and idiomatic.");
    expect(qe.instructions).toContain("Always use Mexican Spanish vocabulary.");
    expect(qe.instructions).toContain("Flag Spain-only lexical choices.");
    expect(qe.instructions).toContain("Use informal tú for consumer UI.");
    expect(qe.instructions).toContain("Never add units, nouns, or facts absent from the source");
    expect(qe.conventionsByLocale["es-MX"]).toBeDefined();
    expect(qe.doNotTranslate).toContain("Mastodon");
    expect(qe.tasks).toHaveLength(1);
    const s = qe.tasks[0].strings[0];
    expect(s.placeholders).toContain("count");
    expect(s.termBase?.some((t) => t.term === "Boost" && t.approved === "Impulsar")).toBe(true);
    expect(s.element).toBe("button");

    // Compact JSON formatting (no pretty-print indentation newlines)
    const mcpRes = mcpTextResult({ ok: true, nested: { a: 1 } });
    expect(mcpRes.content[0].text).toBe('{"ok":true,"nested":{"a":1}}');

    // Scoped translation check skips source_scan while keeping catalog checks active
    const scoped = runCheck({ rootDir: dir, locale: "es-MX", scope: "translations" });
    expect(scoped.coverage.executedChecks).not.toContain("source_scan");
    expect(scoped.coverage.executedChecks).toContain("catalog_parity");

    // Compact followup guidance when offset > 0
    const p0 = prepareBatch({ rootDir: dir, targetLocale: "es-MX", includeTranslated: true, offset: 0, limit: 1 });
    const p1 = prepareBatch({ rootDir: dir, targetLocale: "es-MX", includeTranslated: true, offset: 1, limit: 1 });
    expect(p0.contextGuidance.length).toBeGreaterThan(100);
    expect(p1.contextGuidance).toBe("Same context guidance as offset=0.");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
