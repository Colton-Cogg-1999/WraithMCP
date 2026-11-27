import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { detectProjectAdapter, loadSourceCatalog } from "../src/adapters/registry.js";
import { FlutterAdapter } from "../src/adapters/flutter.js";
import { IosAdapter } from "../src/adapters/ios.js";
import { applyTranslations } from "../src/core/apply.js";
import { runCheck } from "../src/core/check.js";
import { initProject } from "../src/core/init.js";
import { prepareQeReview, submitQeVerdicts } from "../src/core/qe.js";
import { WraithStore } from "../src/core/store.js";
import { runTmsExport, runTmsImport } from "../src/core/tms.js";
import { DocxDocumentAdapter } from "../src/documents/docx.js";
import { applyDocumentTranslations, extractDocument, prepareDocument } from "../src/documents/registry.js";
import { verifyDocumentFormatting } from "../src/documents/verify.js";
import { JsonFormatAdapter } from "../src/formats/json.js";

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Real-world reliability regression suite (CI deterministic)", () => {
  it("preserves flat dot-keyed JSON structure with parent/child prefix collisions (Mastodon bug) even when target file starts as {}", () => {
    const dir = makeTmp("wraith-flat-json-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0", "react-intl": "7.0.0" } })
    );
    fs.mkdirSync(path.join(dir, "app/javascript/mastodon/locales"), { recursive: true });
    fs.mkdirSync(path.join(dir, "app/javascript/mastodon/components"), { recursive: true });

    const enPath = path.join(dir, "app/javascript/mastodon/locales/en.json");
    const esPath = path.join(dir, "app/javascript/mastodon/locales/es-MX.json");
    // Exact Mastodon parent/child prefix collision pattern!
    const enCatalog = {
      "account.followers": "Followers",
      "account.followers.empty": "No followers yet",
      "account.following": "Following",
      "account.following.empty": "Not following anyone",
      "status.boost": "Boost",
      "status.boost.confirm": "Are you sure you want to boost this post?",
      "trends.counter": "{count, plural, one {# person} other {# people}} in {days, plural, one {# day} other {# days}}",
    };
    fs.writeFileSync(enPath, JSON.stringify(enCatalog, null, 2) + "\n");
    // Pre-existing empty target file `{}` — this previously triggered nested mode and silently dropped parent keys!
    fs.writeFileSync(esPath, "{}\n");

    const store = new WraithStore(dir);
    store.ensureDir();
    store.writeConfig({
      ...store.readConfig(),
      framework: "react",
      sourceLocale: "en",
      targetLocales: ["es-MX"],
      paths: { locales: "app/javascript/mastodon/locales", source: ["app/javascript/mastodon"], ignore: ["node_modules/**"] },
    });

    const applyRes = applyTranslations({
      rootDir: dir,
      targetLocale: "es-MX",
      translations: [
        { key: "account.followers", value: "Seguidores" },
        { key: "account.followers.empty", value: "Aún no hay seguidores" },
        { key: "account.following", value: "Siguiendo" },
        { key: "account.following.empty", value: "No sigues a nadie" },
        { key: "status.boost", value: "Impulsar" },
        { key: "status.boost.confirm", value: "¿Seguro que quieres impulsar esta publicación?" },
        { key: "trends.counter", value: "{count, plural, one {# persona} other {# personas}} en {days, plural, one {# día} other {# días}}" },
      ],
    });

    expect(applyRes.ok).toBe(true);
    expect(applyRes.errors).toHaveLength(0);
    expect(applyRes.appliedCount).toBe(7);

    // Independently verify raw JSON on disk is STILL FLAT and ALL 7 keys survived
    const written = JSON.parse(fs.readFileSync(esPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written)).toHaveLength(7);
    expect(Object.values(written).every((v) => typeof v === "string")).toBe(true);
    expect(written["account.followers"]).toBe("Seguidores");
    expect(written["account.followers.empty"]).toBe("Aún no hay seguidores");

    const chk = runCheck({ rootDir: dir, locale: "es-MX", scope: "translations" });
    expect(chk.errorCount).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses silent data loss on nested JSON parent/child key-path collisions instead of overwriting", () => {
    const dir = makeTmp("wraith-json-collision-");
    const target = path.join(dir, "es.json");
    fs.writeFileSync(target, JSON.stringify({ account: { followers: "Seguidores" } }, null, 2) + "\n");

    const adapter = new JsonFormatAdapter();
    expect(() =>
      adapter.applyUpdates(target, "es", [{ key: "account.followers.empty", value: "Vacío" }])
    ).toThrow(/collision/i);

    // Reverse collision: overwriting object subtree with a string must also throw
    const target2 = path.join(dir, "es2.json");
    fs.writeFileSync(target2, JSON.stringify({ account: { followers: { empty: "Vacío" } } }, null, 2) + "\n");
    expect(() =>
      adapter.applyUpdates(target2, "es", [{ key: "account.followers", value: "Seguidores" }])
    ).toThrow(/collision/i);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("discovers root-level locales when frameworkOverride + localesPathOverride are configured in a monorepo (Immich pattern)", () => {
    const dir = makeTmp("wraith-monorepo-");
    fs.mkdirSync(path.join(dir, "i18n"), { recursive: true });
    fs.mkdirSync(path.join(dir, "web/src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "i18n/en.json"), JSON.stringify({ album_title: "Albums", delete_item: "Delete" }));
    fs.writeFileSync(path.join(dir, "i18n/ar.json"), JSON.stringify({ album_title: "الألبومات", delete_item: "حذف" }));
    fs.writeFileSync(path.join(dir, "web/src/Album.svelte"), `<script>import { t } from 'svelte-i18n';</script><h1>{$t('album_title')}</h1>`);

    const { adapter, detection } = detectProjectAdapter(dir, "sveltekit", "i18n");
    expect(adapter?.id).toBe("sveltekit");
    expect(detection.localesDir).toBe("i18n");
    expect(Object.keys(detection.localeFiles).sort()).toEqual(["ar", "en"]);

    const src = loadSourceCatalog(adapter!, detection, "en");
    expect(src.entries.size).toBe(2);

    const scan = adapter!.scanSource(dir, { sourcePaths: ["web/src"], ignore: ["node_modules/**"] });
    expect(scan.usageByKey["album_title"]).toBeDefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts and round-trips complex DOCX (nested tables, footnotes, headers/footers, textboxes) and reports unsupported chart parts transparently", () => {
    const dir = makeTmp("wraith-docx-complex-");
    const srcDocx = path.join(dir, "complex.docx");
    const outDocx = path.join(dir, "complex.es-MX.docx");

    const entries: Record<string, Uint8Array> = {
      "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
      "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>Main heading</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Outer cell</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nested cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>
        <w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Textbox callout</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>
      </w:body></w:document>`),
      "word/header1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential Policy</w:t></w:r></w:p></w:hdr>`),
      "word/footer1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page footer</w:t></w:r></w:p></w:ftr>`),
      "word/footnotes.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Footnote citation text</w:t></w:r></w:p></w:footnote></w:footnotes>`),
      "word/charts/chart1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>`),
    };
    fs.writeFileSync(srcDocx, zipSync(entries));

    const adapter = new DocxDocumentAdapter();
    const extracted = adapter.extract(srcDocx);
    const plainTexts = extracted.segments.map((s) => s.plainText);
    expect(plainTexts).toContain("Main heading");
    expect(plainTexts).toContain("Outer cell");
    expect(plainTexts).toContain("Nested cell text");
    expect(plainTexts).toContain("Textbox callout");
    expect(plainTexts).toContain("Confidential Policy");
    expect(plainTexts).toContain("Page footer");
    expect(plainTexts).toContain("Footnote citation text");
    // Transparent reporting of non-paragraph chart XML (never silently omitted)
    expect((extracted.stats as { unsupportedParts?: string[] }).unsupportedParts).toEqual(["word/charts/chart1.xml"]);

    // Round-trip translation and verify every single translated segment survived
    const updates = extracted.segments.map((s) => ({ id: s.id, text: `[ES] ${s.text}` }));
    const applyRes = adapter.apply(srcDocx, outDocx, updates);
    expect(applyRes.ok).toBe(true);
    const reExtracted = adapter.extract(outDocx);
    expect(reExtracted.segments).toHaveLength(extracted.segments.length);
    expect(reExtracted.segments.every((s) => s.plainText.startsWith("[ES] "))).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips XLIFF 2.0 human post-edits (Crowdin/Phrase workflow) and protects human-verified QE sign-offs", async () => {
    const dir = makeTmp("wraith-xliff-rt-");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0", "react-intl": "7.0.0" } }));
    fs.mkdirSync(path.join(dir, "locales"), { recursive: true });
    fs.writeFileSync(path.join(dir, "locales/en.json"), JSON.stringify({ "nav.home": "Home", "nav.boost": "Boost" }));
    fs.writeFileSync(path.join(dir, "locales/es-MX.json"), JSON.stringify({ "nav.home": "Inicio", "nav.boost": "Impulsar" }));

    const store = new WraithStore(dir);
    store.ensureDir();
    store.writeConfig({
      ...store.readConfig(),
      framework: "react",
      sourceLocale: "en",
      targetLocales: ["es-MX"],
      paths: { locales: "locales", source: ["src"], ignore: ["node_modules/**"] },
    });

    const exp = runTmsExport({ rootDir: dir, locales: ["es-MX"], outDir: "tms-out", format: "xliff2" });
    const xlfRel = exp.files.find((f) => f.endsWith(".xliff") || f.endsWith(".xlf"))!;
    expect(xlfRel).toBeDefined();
    const xlfPath = path.join(dir, xlfRel);

    // Simulate human post-edit in Crowdin/Phrase XLIFF 2.0 export (state="final" on <segment>)
    const edited = fs
      .readFileSync(xlfPath, "utf8")
      .replace(/state="[^"]+"/g, 'state="final"')
      .replace(">Inicio</target>", ">Página principal</target>");
    fs.writeFileSync(xlfPath, edited);

    const imp = await runTmsImport({ rootDir: dir, input: xlfRel });
    expect(imp.rejected).toHaveLength(0);
    const live = JSON.parse(fs.readFileSync(path.join(dir, "locales/es-MX.json"), "utf8"));
    expect(live["nav.home"]).toBe("Página principal");

    // Verify human-verified QE sign-off cannot be overwritten by agent QE verdicts
    const sub = submitQeVerdicts({
      rootDir: dir,
      verdicts: [{ locale: "es-MX", key: "nav.home", target: "Página principal", verdict: "flag", reason: "test override" }],
    });
    expect(sub.rejected.some((r) => r.code === "human_verified")).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("maps Flutter null-safety l10n!./l10n?. calls and iOS SwiftUI LocalizedStringKey / interpolated Text keys", () => {
    // Flutter null-safety (Musify pattern)
    const fDir = makeTmp("wraith-flutter-nullsafe-");
    fs.writeFileSync(path.join(fDir, "pubspec.yaml"), "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n");
    fs.mkdirSync(path.join(fDir, "lib/screens"), { recursive: true });
    fs.writeFileSync(
      path.join(fDir, "lib/screens/home.dart"),
      `final a = context.l10n!.about;
final b = context.l10n?.settings ?? 'Settings';
final c = AppLocalizations.of(context)!.albums;`
    );
    const fScan = new FlutterAdapter().scanSource(fDir, { sourcePaths: ["lib"], ignore: [] });
    expect(Object.keys(fScan.usageByKey).sort()).toEqual(["about", "albums", "settings"]);
    fs.rmSync(fDir, { recursive: true, force: true });

    // iOS SwiftUI (IceCubesApp pattern)
    const iDir = makeTmp("wraith-ios-swiftui-");
    fs.mkdirSync(path.join(iDir, "Sources"), { recursive: true });
    fs.writeFileSync(
      path.join(iDir, "Sources/ProfileView.swift"),
      `let label: LocalizedStringKey = "profile.tab.bookmarks"
let k = LocalizedStringKey("profile.options.title")
Button("profile.action.follow") {}
Text("profile.count %lld \\(count)")
Text("profile.posts \\(count)")`
    );
    const iScan = new IosAdapter().scanSource(iDir, { sourcePaths: ["Sources"], ignore: [] });
    expect(iScan.usageByKey["profile.tab.bookmarks"]).toBeDefined();
    expect(iScan.usageByKey["profile.options.title"]).toBeDefined();
    expect(iScan.usageByKey["profile.action.follow"]).toBeDefined();
    expect(iScan.usageByKey["profile.posts %lld"]).toBeDefined();
    fs.rmSync(iDir, { recursive: true, force: true });
  });

  it("REL-012: incremental DOCX v2 update after prepending a paragraph preserves human edits without false manual_edit_conflict on run-normalized tags", () => {
    const dir = makeTmp("wraith-rel-docx-v2-");
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    const wNs = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${wNs}><w:body>
  <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Manual Slips;</w:t></w:r><w:r><w:t xml:space="preserve"> Muscle strains when pulling.</w:t></w:r></w:p>
  <w:p><w:r><w:t>Hot Work</w:t></w:r></w:p>
</w:body></w:document>`;
    const makeDoc = (xml: string) =>
      zipSync({
        "[Content_Types].xml": strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
        "word/document.xml": strToU8(xml),
      });
    const srcPath = path.join(dir, "docs/sop.docx");
    const tgtPath = path.join(dir, "docs/sop.es-MX.docx");
    fs.writeFileSync(srcPath, makeDoc(docXml));
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], documents: ["docs"], writeAgentRule: false });

    const v1 = extractDocument(srcPath);
    const r1 = applyDocumentTranslations(dir, {
      sourceFile: "docs/sop.docx",
      targetFile: "docs/sop.es-MX.docx",
      targetLocale: "es-MX",
      updates: [
        { id: v1.segments[0].id, text: `Prefijo ${v1.segments[0].text}` },
        { id: v1.segments[1].id, text: "Trabajo en caliente" },
      ],
    });
    expect(r1.ok).toBe(true);

    // Human edits second paragraph directly in target DOCX
    const tgtZip = unzipSync(fs.readFileSync(tgtPath));
    tgtZip["word/document.xml"] = strToU8(
      strFromU8(tgtZip["word/document.xml"]).replace("Trabajo en caliente", "Trabajo con fuego (humano)")
    );
    fs.writeFileSync(tgtPath, zipSync(tgtZip));

    // Source v2 prepends a new paragraph at top, shifting positional IDs
    const v2Xml = docXml.replace("<w:body>", "<w:body><w:p><w:r><w:t>Revision 2 Addendum</w:t></w:r></w:p>");
    fs.writeFileSync(srcPath, makeDoc(v2Xml));

    const prep2 = prepareDocument(dir, { documentPath: "docs/sop.docx", targetLocale: "es-MX" });
    expect(prep2.translatedSegments).toBe(2);
    expect(prep2.pendingSegments).toBe(1);
    const pending = prep2.segments.filter((s) => s.status !== "translated");
    const r2 = applyDocumentTranslations(dir, {
      sourceFile: "docs/sop.docx",
      targetFile: "docs/sop.es-MX.docx",
      targetLocale: "es-MX",
      updates: [{ id: pending[0].id, text: "Anexo Revisión 2" }],
    });
    expect(r2.ok).toBe(true);
    expect(r2.errors).toHaveLength(0);

    const finalTgt = extractDocument(tgtPath);
    expect(finalTgt.segments.some((s) => s.plainText === "Anexo Revisión 2")).toBe(true);
    expect(finalTgt.segments.some((s) => s.plainText === "Trabajo con fuego (humano)")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("REL-013: verifyDocumentFormatting fails loudly on dropped segments or missing XML parts and cannot conceal missing content", () => {
    const dir = makeTmp("wraith-rel-docverify-");
    const wNs = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const fullDoc = zipSync({
      "[Content_Types].xml": strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><w:document ${wNs}><w:body><w:p><w:r><w:t>Heading One</w:t></w:r></w:p><w:p><w:r><w:t>Body paragraph two.</w:t></w:r></w:p><w:p><w:r><w:t>1</w:t></w:r></w:p></w:body></w:document>`
      ),
      "word/footnotes.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${wNs}><w:footnote w:id="1"><w:p><w:r><w:t>Important legal footnote.</w:t></w:r></w:p></w:footnote></w:footnotes>`
      ),
    });
    // Broken target drops paragraph two AND drops word/footnotes.xml completely!
    const brokenDoc = zipSync({
      "[Content_Types].xml": strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><w:document ${wNs}><w:body><w:p><w:r><w:t>Encabezado Uno</w:t></w:r></w:p><w:p><w:r><w:t>1</w:t></w:r></w:p></w:body></w:document>`
      ),
    });
    const srcPath = path.join(dir, "src.docx");
    const badPath = path.join(dir, "bad.docx");
    fs.writeFileSync(srcPath, fullDoc);
    fs.writeFileSync(badPath, brokenDoc);

    const res = verifyDocumentFormatting({ sourceFile: srcPath, targetFile: badPath });
    expect(res.outcome).toBe("FAIL");
    expect(res.findings.some((f) => f.code === "doc_missing_parts" && f.severity === "error")).toBe(true);
    expect(res.findings.some((f) => f.code === "doc_missing_segments" && f.severity === "error")).toBe(true);
    expect(res.segmentStats?.missingParts).toContain("word/footnotes.xml");
    expect(res.segmentStats?.sourceSegments).toBe(4);
    expect(res.segmentStats?.targetSegments).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
