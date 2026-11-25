import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { detectProjectAdapter } from "../adapters/registry.js";
import { getLocaleConventions } from "./locales.js";
import { decodeZeroWidthKeyIds, stripZeroWidthKeyIds } from "./pseudo.js";
import { resolveConfinedPath } from "./security.js";
import { PolyglotStore } from "./store.js";
import { CheckOutcome, LayoutViewport, UsageSite } from "./types.js";

export type LayoutDefectType =
  | "horizontal_overflow"
  | "vertical_overflow"
  | "clipped_text"
  | "element_overlap"
  | "tofu_glyph"
  | "dir_lang_mismatch"
  | "hardcoded_format";

export type RemediationStep =
  | "mechanical_codemod"
  | "agent_code_fix"
  | "copy_budget_retranslate"
  | "glossary_abbreviation"
  | "escalate_human";

export interface LayoutFinding {
  id: string;
  type: LayoutDefectType;
  locale: string;
  route: string;
  viewport: LayoutViewport;
  key?: string;
  file?: string;
  line?: number;
  element: string;
  constraint: string;
  overflowPx: number;
  textSample: string;
  remediationStep: RemediationStep;
  prescription: string;
  budgetChars?: number;
  maxWidthPx?: number;
  approvedAbbreviation?: string;
}

export interface LayoutCheckOptions {
  rootDir: string;
  baseUrl?: string;
  routes?: string[];
  locales?: string[];
  localeUrlPattern?: "query" | "prefix" | "cookie";
  viewports?: LayoutViewport[];
  screenshotsDir?: string;
  saveBudgets?: boolean;
  /** Optional custom Playwright module loader (for testing missing-Playwright INCONCLUSIVE behavior) */
  playwrightLoader?: () => Promise<unknown>;
}

export interface LayoutCheckResult {
  outcome: CheckOutcome;
  passed: boolean;
  inconclusiveReason?: string;
  baseUrl?: string;
  routesChecked: string[];
  localesChecked: string[];
  viewportsChecked: LayoutViewport[];
  findingCount: number;
  countsByType: Record<string, number>;
  findings: LayoutFinding[];
  budgetsRecorded: number;
  screenshots: string[];
  nextSteps: string[];
}

const DEFAULT_VIEWPORTS: LayoutViewport[] = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
];

export const SYSTEM_CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

export function buildRouteUrl(
  baseUrl: string,
  route: string,
  locale: string,
  pattern: "query" | "prefix" | "cookie"
): string {
  const cleanBase = baseUrl.replace(/\/$/, "");
  const cleanRoute = route.startsWith("/") ? route : `/${route}`;
  if (pattern === "prefix") {
    return `${cleanBase}/${locale}${cleanRoute === "/" ? "" : cleanRoute}`;
  }
  if (pattern === "query") {
    const sep = cleanRoute.includes("?") ? "&" : "?";
    return `${cleanBase}${cleanRoute}${sep}locale=${encodeURIComponent(locale)}`;
  }
  return `${cleanBase}${cleanRoute}`;
}

function isFormatPseudoLocale(locale: string): boolean {
  const low = locale.toLowerCase();
  return low === "en-xa" || low === "ar-xb" || low === "ja-xc" || low === "th-xd" || low === "de-xe" || low === "en-xf";
}

function expectedDirectionForLocale(locale: string): "ltr" | "rtl" {
  return getLocaleConventions(locale).direction;
}

export async function defaultPlaywrightLoader(): Promise<unknown> {
  // 1. Standard ESM/CJS resolution from local node_modules
  try {
    const modName = "playwright";
    return await import(modName);
  } catch {
    // fallback below
  }
  const req = createRequire(import.meta.url);
  try {
    return req("playwright");
  } catch {
    // fallback below
  }
  // 2. Discover globally installed `playwright` CLI package via PATH (supports symlinks & .bin wrappers)
  const extraCandidates: string[] = [];
  if (process.env.POLYGLOT_PLAYWRIGHT_PATH) {
    extraCandidates.push(process.env.POLYGLOT_PLAYWRIGHT_PATH);
  }
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const binPath = execFileSync(whichCmd, ["playwright"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)[0]
      ?.trim();
    if (binPath && fs.existsSync(binPath)) {
      const real = fs.realpathSync(binPath);
      const binDir = path.dirname(real);
      extraCandidates.push(
        path.resolve(binDir, "..", "playwright"),
        path.resolve(binDir, ".."),
        path.resolve(binDir, "..", "lib", "node_modules", "playwright")
      );
    }
  } catch {
    // not installed globally via PATH
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (globalRoot) {
      extraCandidates.push(path.join(globalRoot, "playwright"));
    }
  } catch {
    // ignore
  }
  for (const candidate of extraCandidates) {
    try {
      const mod = req(candidate);
      if (mod?.chromium) return mod;
    } catch {
      // try next candidate
    }
  }
  throw new Error("Cannot find optional peer dependency 'playwright'");
}

interface RawBrowserDefect {
  type: LayoutDefectType;
  element: string;
  constraint: string;
  overflowPx: number;
  clientWidth: number;
  fontSizePx: number;
  rawText: string;
  testId?: string;
  className?: string;
}

/**
 * Inspect rendered pages with Playwright across routes, locales (pseudo + real), and viewports
 * (375px mobile & 1280px desktop), mapping every confirmed defect back to its translation key,
 * file:line, and the first applicable remediation ladder step.
 *
 * Returns INCONCLUSIVE (never PASS) when Playwright is not installed or baseUrl is not configured.
 */
export async function runLayoutCheck(options: LayoutCheckOptions): Promise<LayoutCheckResult> {
  const store = new PolyglotStore(options.rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const layoutCfg = config.layout;

  const baseUrl = options.baseUrl ?? layoutCfg?.baseUrl;
  const routes = options.routes ?? layoutCfg?.routes ?? ["/"];
  const viewports = options.viewports ?? layoutCfg?.viewports ?? DEFAULT_VIEWPORTS;
  const localeUrlPattern = options.localeUrlPattern ?? layoutCfg?.localeUrlPattern ?? "query";
  const screenshotsDirRel = options.screenshotsDir ?? layoutCfg?.screenshotsDir ?? ".polyglot/screenshots";

  // 1. Fail closed (INCONCLUSIVE) when baseUrl is missing
  if (!baseUrl) {
    return {
      outcome: "INCONCLUSIVE",
      passed: false,
      inconclusiveReason:
        "No baseUrl configured for rendered layout checks. Start your dev server and pass --url http://localhost:3000 (or set layout.baseUrl in .polyglot/config.json).",
      routesChecked: [],
      localesChecked: [],
      viewportsChecked: viewports,
      findingCount: 0,
      countsByType: {},
      findings: [],
      budgetsRecorded: 0,
      screenshots: [],
      nextSteps: [
        "Start your local dev server (e.g. npm run dev).",
        "Run `polyglot layout --url http://localhost:3000 --routes /,/settings` or add `layout.baseUrl` to `.polyglot/config.json`.",
      ],
    };
  }

  // 2. Load Playwright dynamically (optional peer dependency) -> INCONCLUSIVE if absent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any = null;
  try {
    const loader = options.playwrightLoader ?? defaultPlaywrightLoader;
    pw = await loader();
  } catch {
    return {
      outcome: "INCONCLUSIVE",
      passed: false,
      inconclusiveReason:
        "Playwright is not installed (optional peer dependency). Rendered layout checks cannot run without a browser.",
      baseUrl,
      routesChecked: [],
      localesChecked: [],
      viewportsChecked: viewports,
      findingCount: 0,
      countsByType: {},
      findings: [],
      budgetsRecorded: 0,
      screenshots: [],
      nextSteps: [
        "Install Playwright: `npm install -D playwright && npx playwright install chromium`",
        "Re-run `polyglot layout --url " + baseUrl + "`.",
      ],
    };
  }

  // Discover usage sites & locales from the project
  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );
  let usageByKey: Record<string, UsageSite[]> = {};
  if (adapter) {
    const scanRes = adapter.scanSource(store.rootDir, {
      sourcePaths: config.paths.source,
      ignore: config.paths.ignore,
      i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
    });
    usageByKey = scanRes.usageByKey;
  }

  const detectedPseudoLocales = Object.keys(detection.localeFiles).filter((l) =>
    /^(?:en-XA|ar-XB|ja-XC|th-XD|de-XE|en-XF|en-x-pseudo)$/i.test(l)
  );
  const locales =
    options.locales && options.locales.length > 0
      ? options.locales
      : [...new Set([...detectedPseudoLocales, ...config.targetLocales])];
  if (locales.length === 0) locales.push(config.sourceLocale);

  // Launch Chromium (fallback to system chromium if Playwright headless shell isn't downloaded)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch {
    const sysChrome = SYSTEM_CHROMIUM_PATHS.find((p) => fs.existsSync(p));
    if (!sysChrome) {
      return {
        outcome: "INCONCLUSIVE",
        passed: false,
        inconclusiveReason:
          "Playwright Chromium browser binary is not installed and no system Chromium was found.",
        baseUrl,
        routesChecked: [],
        localesChecked: [],
        viewportsChecked: viewports,
        findingCount: 0,
        countsByType: {},
        findings: [],
        budgetsRecorded: 0,
        screenshots: [],
        nextSteps: ["Run `npx playwright install chromium` and retry `polyglot layout`."],
      };
    }
    try {
      browser = await pw.chromium.launch({ headless: true, executablePath: sysChrome });
    } catch (launchErr) {
      return {
        outcome: "INCONCLUSIVE",
        passed: false,
        inconclusiveReason: `Playwright could not launch Chromium (${sysChrome}): ${launchErr instanceof Error ? launchErr.message.split("\n")[0] : String(launchErr)}`,
        baseUrl,
        routesChecked: [],
        localesChecked: [],
        viewportsChecked: viewports,
        findingCount: 0,
        countsByType: {},
        findings: [],
        budgetsRecorded: 0,
        screenshots: [],
        nextSteps: [
          "Ensure Chromium can run in this environment (or run `npx playwright install chromium`) and retry `polyglot layout`.",
        ],
      };
    }
  }

  const screenshotsAbsDir = resolveConfinedPath(store.rootDir, screenshotsDirRel, {
    label: "screenshots directory",
  });
  fs.mkdirSync(screenshotsAbsDir, { recursive: true });

  const findings: LayoutFinding[] = [];
  const screenshots: string[] = [];
  let budgetsRecorded = 0;
  const layoutState = store.readLayout();
  const now = new Date().toISOString();

  try {
    for (const locale of locales) {
      const expectedDir = expectedDirectionForLocale(locale);
      const formatCheckActive = isFormatPseudoLocale(locale);

      for (const route of routes) {
        const url = buildRouteUrl(baseUrl, route, locale, localeUrlPattern);

        for (const viewport of viewports) {
          const context = await browser.newContext({
            viewport,
            locale: locale.replace(/-X[A-F]$/i, ""),
          });
          if (localeUrlPattern === "cookie") {
            const parsedUrl = new URL(url);
            await context.addCookies([
              { name: "NEXT_LOCALE", value: locale, domain: parsedUrl.hostname, path: "/" },
              { name: "locale", value: locale, domain: parsedUrl.hostname, path: "/" },
            ]);
          }
          const page = await context.newPage();

          try {
            await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
          } catch {
            await page.goto(url, { waitUntil: "load", timeout: 15_000 });
          }

          const safeRoute = route.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_|_$/g, "") || "home";
          const shotName = `${locale}-${viewport.width}x${viewport.height}-${safeRoute}.png`;
          const shotAbs = path.join(screenshotsAbsDir, shotName);
          await page.screenshot({ path: shotAbs, fullPage: true });
          screenshots.push(path.relative(store.rootDir, shotAbs).replace(/\\/g, "/"));

          const rawDefects: RawBrowserDefect[] = await page.evaluate(
            ({ expectedDirArg, checkFormatsArg }: { expectedDirArg: string; checkFormatsArg: boolean }) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const g = globalThis as any;
              const doc = g.document;
              const win = g.window;
              const getCS = g.getComputedStyle;
              const out: RawBrowserDefect[] = [];
              const htmlEl = doc.documentElement;
              const actualDir = String(htmlEl.getAttribute("dir") || getCS(htmlEl).direction || "ltr").toLowerCase();
              const actualLang = String(htmlEl.getAttribute("lang") || "").trim();

              // 1. dir / lang mismatch on <html>
              if (expectedDirArg === "rtl" && actualDir !== "rtl") {
                out.push({
                  type: "dir_lang_mismatch",
                  element: "html",
                  constraint: `dir="${actualDir}" (expected "rtl")`,
                  overflowPx: 0,
                  clientWidth: win.innerWidth,
                  fontSizePx: 16,
                  rawText: `html[lang="${actualLang}" dir="${actualDir}"]`,
                });
              }
              if (!actualLang) {
                out.push({
                  type: "dir_lang_mismatch",
                  element: "html",
                  constraint: "missing lang attribute on <html>",
                  overflowPx: 0,
                  clientWidth: win.innerWidth,
                  fontSizePx: 16,
                  rawText: "<html> missing lang attribute",
                });
              }

              // 2. Viewport horizontal overflow
              const docOverflow = Math.round(doc.documentElement.scrollWidth - win.innerWidth);
              if (docOverflow > 2) {
                out.push({
                  type: "horizontal_overflow",
                  element: "document",
                  constraint: `viewport scrollWidth (${doc.documentElement.scrollWidth}px) > innerWidth (${win.innerWidth}px)`,
                  overflowPx: docOverflow,
                  clientWidth: win.innerWidth,
                  fontSizePx: 16,
                  rawText: String(doc.body.innerText || "").slice(0, 80),
                });
              }

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const textEls: any[] = Array.from(
                doc.querySelectorAll("button, a, span, p, h1, h2, h3, h4, h5, h6, label, td, th, li, div")
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ).filter((el: any) => {
                const style = getCS(el);
                if (style.display === "none" || style.visibility === "hidden") return false;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                // Only leaf-ish text containers to avoid counting ancestor wrappers twice
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const hasDirectText = Array.from(el.childNodes).some((n: any) => n.nodeType === 3 && String(n.textContent || "").trim().length > 0);
                return hasDirectText;
              });

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const boxes: Array<{ el: any; rect: any }> = [];

              for (const el of textEls) {
                const style = getCS(el);
                const rect = el.getBoundingClientRect();
                const rawText = String(el.textContent || "");
                const fontSizePx = parseFloat(style.fontSize) || 14;
                const tag = String(el.tagName).toLowerCase();
                const testId = el.getAttribute("data-testid") || undefined;
                const cls = typeof el.className === "string" ? el.className : "";
                boxes.push({ el, rect });

                const overflowX = Math.round(el.scrollWidth - el.clientWidth);
                const overflowY = Math.round(el.scrollHeight - el.clientHeight);
                const clipsX =
                  style.overflowX === "hidden" ||
                  style.overflowX === "clip" ||
                  style.textOverflow === "ellipsis" ||
                  style.whiteSpace === "nowrap";
                const clipsY =
                  style.overflowY === "hidden" ||
                  style.overflowY === "clip" ||
                  style.webkitLineClamp !== "none";

                // 3. Horizontal clipping / overflow
                if (overflowX > 2) {
                  const type: LayoutDefectType = clipsX ? "clipped_text" : "horizontal_overflow";
                  const constraints = [
                    style.whiteSpace === "nowrap" ? "white-space: nowrap" : "",
                    style.overflowX === "hidden" || style.overflowX === "clip" ? `overflow-x: ${style.overflowX}` : "",
                    style.textOverflow === "ellipsis" ? "text-overflow: ellipsis" : "",
                    `width: ${Math.round(el.clientWidth)}px`,
                  ].filter(Boolean);
                  out.push({
                    type,
                    element: tag,
                    constraint: constraints.join("; "),
                    overflowPx: overflowX,
                    clientWidth: Math.round(el.clientWidth),
                    fontSizePx,
                    rawText,
                    testId,
                    className: cls,
                  });
                }

                // 4. Vertical clipping / overflow (tall scripts / fixed-height cards)
                if (overflowY > 3 && clipsY) {
                  out.push({
                    type: "vertical_overflow",
                    element: tag,
                    constraint: `height: ${Math.round(el.clientHeight)}px; overflow-y: ${style.overflowY}`,
                    overflowPx: overflowY,
                    clientWidth: Math.round(el.clientWidth),
                    fontSizePx,
                    rawText,
                    testId,
                    className: cls,
                  });
                }

                // 5. Hardcoded formats surviving in format pseudo mode (e.g. $1,234.56 or 11/25/2026)
                if (checkFormatsArg) {
                  const trimmed = rawText.trim();
                  const hasRawCurrency = /\$\s*\d[\d,]*(?:\.\d{2})?/.test(trimmed);
                  const hasRawUsDate = /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12][0-9]|3[01])(?:\/\d{2,4})?\b/.test(trimmed);
                  const hasRawAsciiDecimal = /\b\d+\.\d{2}\b/.test(trimmed);
                  if (hasRawCurrency || hasRawUsDate || hasRawAsciiDecimal) {
                    out.push({
                      type: "hardcoded_format",
                      element: tag,
                      constraint: hasRawCurrency
                        ? "unformatted $ currency in format mode"
                        : hasRawUsDate
                          ? "unformatted MM/DD date in format mode"
                          : "unformatted ASCII decimal in format mode",
                      overflowPx: 0,
                      clientWidth: Math.round(el.clientWidth),
                      fontSizePx,
                      rawText,
                      testId,
                      className: cls,
                    });
                  }
                }
              }

              // 6. Overlapping sibling text boxes
              for (let i = 0; i < boxes.length; i++) {
                for (let j = i + 1; j < boxes.length; j++) {
                  const a = boxes[i];
                  const b = boxes[j];
                  if (a.el.parentElement !== b.el.parentElement) continue;
                  const ox = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
                  const oy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
                  if (ox > 3 && oy > 3) {
                    out.push({
                      type: "element_overlap",
                      element: `${String(a.el.tagName).toLowerCase()} / ${String(b.el.tagName).toLowerCase()}`,
                      constraint: `sibling overlap ${Math.round(ox)}x${Math.round(oy)}px`,
                      overflowPx: Math.round(ox),
                      clientWidth: Math.round(a.rect.width),
                      fontSizePx: 14,
                      rawText: `${a.el.textContent || ""} || ${b.el.textContent || ""}`,
                      testId: a.el.getAttribute("data-testid") || b.el.getAttribute("data-testid") || undefined,
                    });
                  }
                }
              }

              // 7. Tofu glyph probe (missing font glyphs for non-Latin CJK/Arabic/Thai chars)
              try {
                const canvas = doc.createElement("canvas");
                canvas.width = 24;
                canvas.height = 24;
                const ctx = canvas.getContext("2d");
                if (ctx) {
                  const renderCharSig = (ch: string, font: string) => {
                    ctx.clearRect(0, 0, 24, 24);
                    ctx.font = font;
                    ctx.fillStyle = "#000";
                    ctx.fillText(ch, 2, 18);
                    return canvas.toDataURL();
                  };
                  const nonLatinRe = /[\u0600-\u06FF\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF]/;
                  for (const el of textEls.slice(0, 40)) {
                    const txt = String(el.textContent || "");
                    const m = nonLatinRe.exec(txt);
                    if (!m) continue;
                    const font = getCS(el).font;
                    const tofuSig = renderCharSig("\uFFFD", font);
                    const unmappedSig = renderCharSig("\u0378", font);
                    const chSig = renderCharSig(m[0], font);
                    if (chSig === tofuSig || chSig === unmappedSig) {
                      out.push({
                        type: "tofu_glyph",
                        element: String(el.tagName).toLowerCase(),
                        constraint: `missing font glyph for '${m[0]}' in ${font}`,
                        overflowPx: 0,
                        clientWidth: Math.round(el.getBoundingClientRect().width),
                        fontSizePx: parseFloat(getCS(el).fontSize) || 14,
                        rawText: txt,
                        testId: el.getAttribute("data-testid") || undefined,
                      });
                      break;
                    }
                  }
                }
              } catch {
                // ignore canvas errors
              }

              return out;
            },
            { expectedDirArg: expectedDir, checkFormatsArg: formatCheckActive }
          );

          for (const d of rawDefects) {
            const decodedKeys = decodeZeroWidthKeyIds(d.rawText);
            const matchedKey =
              decodedKeys[0] ??
              (d.testId && usageByKey[d.testId] ? d.testId : undefined);
            const site = matchedKey ? usageByKey[matchedKey]?.[0] : undefined;
            const cleanText = stripZeroWidthKeyIds(d.rawText).replace(/\s+/g, " ").trim().slice(0, 80);

            // Remediation ladder (Steps 1 -> 5)
            let remediationStep: RemediationStep = "agent_code_fix";
            let prescription = "";
            let budgetChars: number | undefined;
            let maxWidthPx: number | undefined;
            let approvedAbbreviation: string | undefined;

            const hasFixedWidthClass = Boolean(d.className && /\bw-(?:\d+|\[[0-9]+px\])\b/.test(d.className));
            const hasPhysicalRtlClass = Boolean(
              d.className && /\b(?:ml|mr|pl|pr|left|right|text-left|text-right|border-l|border-r|rounded-l|rounded-r)(?:-|\b)/.test(d.className)
            );

            if (d.type === "dir_lang_mismatch" || hasFixedWidthClass || hasPhysicalRtlClass) {
              remediationStep = "mechanical_codemod";
              prescription =
                d.type === "dir_lang_mismatch"
                  ? `Run \`polyglot layout --fix\` to add lang and dir="${expectedDir}" to the root <html> element.`
                  : `Run \`polyglot layout --fix\` to mechanically rewrite fixed width / physical spacing classes on ${site ? `${site.file}:${site.line}` : `<${d.element}>`}.`;
            } else if (d.type === "hardcoded_format") {
              remediationStep = "agent_code_fix";
              prescription = `Replace hardcoded formatting (${d.constraint}) at ${site ? `${site.file}:${site.line}` : `<${d.element}>`} with Intl.NumberFormat(locale) / Intl.DateTimeFormat(locale).`;
            } else if (d.type === "tofu_glyph") {
              remediationStep = "agent_code_fix";
              prescription = `Add fallback font stack supporting ${locale} script (${d.constraint}).`;
            } else if (d.type === "clipped_text" || d.type === "horizontal_overflow") {
              // Check if an approved glossary abbreviation exists for this copy/locale
              const abbrEntry = glossary.entries.find(
                (g) => g.abbreviations?.[locale] && cleanText.toLowerCase().includes((g.translations[locale] ?? g.term).toLowerCase())
              );
              if (abbrEntry?.abbreviations?.[locale]) {
                remediationStep = "glossary_abbreviation";
                approvedAbbreviation = abbrEntry.abbreviations[locale];
                prescription = `Use approved glossary abbreviation "${approvedAbbreviation}" for "${abbrEntry.term}" and keep the full label in title / aria-label.`;
              } else if (matchedKey && d.clientWidth > 0) {
                // Step 3: Record width budget into .polyglot/layout.json so prepare & check enforce shorter copy
                const avgCharPx = Math.max(6, d.fontSizePx * 0.56);
                budgetChars = Math.max(4, Math.floor((d.clientWidth - 8) / avgCharPx));
                maxWidthPx = d.clientWidth;
                remediationStep = "copy_budget_retranslate";
                prescription = `Element <${d.element}> (${d.constraint}) clipped by ${d.overflowPx}px at ${viewport.width}px. Recorded width budget (${budgetChars} chars / ${maxWidthPx}px) for "${matchedKey}" (${locale}) in .polyglot/layout.json — re-run \`prepare\` and shorten translation, or relax CSS if wrapping is acceptable.`;
                if (options.saveBudgets !== false) {
                  if (!layoutState.budgets[matchedKey]) layoutState.budgets[matchedKey] = {};
                  layoutState.budgets[matchedKey][locale] = {
                    maxWidthPx,
                    budgetChars,
                    element: d.element,
                    constraint: d.constraint,
                    file: site?.file,
                    line: site?.line,
                    updatedAt: now,
                  };
                  budgetsRecorded++;
                }
              } else {
                remediationStep = "agent_code_fix";
                prescription = `Fix layout overflow (${d.overflowPx}px) on <${d.element}> (${d.constraint}) at ${site ? `${site.file}:${site.line}` : route} (${viewport.width}px viewport).`;
              }
            } else {
              remediationStep = "agent_code_fix";
              prescription = `Inspect ${d.type} (${d.constraint}, ${d.overflowPx}px) on <${d.element}> at ${site ? `${site.file}:${site.line}` : route} (${viewport.width}px viewport).`;
            }

            findings.push({
              id: `${locale}:${viewport.width}:${route}:${d.type}:${matchedKey ?? d.element}:${findings.length}`,
              type: d.type,
              locale,
              route,
              viewport,
              key: matchedKey,
              file: site?.file,
              line: site?.line,
              element: d.element,
              constraint: d.constraint,
              overflowPx: d.overflowPx,
              textSample: cleanText,
              remediationStep,
              prescription,
              budgetChars,
              maxWidthPx,
              approvedAbbreviation,
            });
          }

          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const countsByType: Record<string, number> = {};
  for (const f of findings) {
    countsByType[f.type] = (countsByType[f.type] ?? 0) + 1;
  }

  const outcome: CheckOutcome = findings.length === 0 ? "PASS" : "FAIL";
  layoutState.lastRun = {
    checkedAt: now,
    outcome,
    baseUrl,
    findingCount: findings.length,
    screenshots: screenshots.slice(0, 30),
  };
  if (options.saveBudgets !== false) {
    store.writeLayout(layoutState);
  }

  const nextSteps: string[] = [];
  if (findings.some((f) => f.remediationStep === "mechanical_codemod")) {
    nextSteps.push("Run `polyglot layout --fix` to apply deterministic mechanical codemods.");
  }
  if (findings.some((f) => f.remediationStep === "agent_code_fix")) {
    nextSteps.push("Apply the structured agent code prescriptions for remaining CSS/formatting issues.");
  }
  if (budgetsRecorded > 0) {
    nextSteps.push(
      `Re-run \`prepare\` for keys with recorded width budgets (${budgetsRecorded} saved in .polyglot/layout.json) and shorten translations to fit.`
    );
  }
  if (outcome === "FAIL") {
    nextSteps.push("Re-run `polyglot layout` and `polyglot check` until both return PASS.");
  }

  return {
    outcome,
    passed: outcome === "PASS",
    baseUrl,
    routesChecked: routes,
    localesChecked: locales,
    viewportsChecked: viewports,
    findingCount: findings.length,
    countsByType,
    findings,
    budgetsRecorded,
    screenshots,
    nextSteps,
  };
}
