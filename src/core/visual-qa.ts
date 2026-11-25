import fs from "node:fs";
import path from "node:path";
import { detectProjectAdapter } from "../adapters/registry.js";
import { SYSTEM_CHROMIUM_PATHS, buildRouteUrl, defaultPlaywrightLoader } from "./layout.js";
import { decodeZeroWidthKeyIds } from "./pseudo.js";
import { atomicWriteFileSync, resolveConfinedPath } from "./security.js";
import { PolyglotStore } from "./store.js";
import { UsageSite } from "./types.js";

/**
 * Token-Free Visual QA: deterministic, geometry-based visual regression across
 * routes × locales × viewports. Measures every translation-traced element in a real
 * Chromium, diffs against a stored baseline, and only captures cropped screenshots
 * for elements that actually regressed. Uses zero LLM tokens.
 */

export interface ElementGeometrySnapshot {
  key: string;
  file?: string;
  line?: number;
  tag: string;
  width: number;
  height: number;
  lineCount: number;
  scrollWidth: number;
  clientWidth: number;
  overflowX: number;
  clipped: boolean;
  occluded: boolean;
  fontLoaded: boolean;
  contrastRatio: number;
}

export type VisualDefectType =
  | "line_wrap_regression"
  | "container_blowout"
  | "text_truncation"
  | "element_occlusion"
  | "missing_glyph_tofu"
  | "contrast_regression";

export interface VisualDefect {
  id: string;
  type: VisualDefectType;
  route: string;
  locale: string;
  /** e.g. "375x812" */
  viewport: string;
  key: string;
  file?: string;
  line?: number;
  base?: ElementGeometrySnapshot;
  curr: ElementGeometrySnapshot;
  delta: Record<string, number>;
  screenshot?: string;
  message: string;
}

export interface VisualBaselineFile {
  version: 1;
  capturedAt: string;
  baseUrl?: string;
  /** keyed by `${route}|${viewport}|${locale}` */
  snapshots: Record<string, ElementGeometrySnapshot[]>;
}

export interface VisualQaOptions {
  rootDir: string;
  baseUrl?: string;
  routes?: string[];
  locales?: string[];
  viewports?: { width: number; height: number }[];
  localeUrlPattern?: "query" | "prefix" | "cookie";
  captureBaseline?: boolean;
  /** default .polyglot/visual-baseline.json, confined to rootDir */
  basePath?: string;
  playwrightLoader?: () => Promise<unknown>;
}

export interface VisualQaResult {
  outcome: "PASS" | "FAIL" | "INCONCLUSIVE";
  passed: boolean;
  mode: "capture" | "diff";
  inconclusiveReason?: string;
  baseUrl?: string;
  baselinePath: string;
  routesChecked: string[];
  localesChecked: string[];
  viewportsChecked: string[];
  elementsMeasured: number;
  defectCount: number;
  countsByType: Record<string, number>;
  defects: VisualDefect[];
  manifestPath?: string;
  screenshots: string[];
  nextSteps: string[];
  tokensUsed: 0;
}

const DEFAULT_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
];
const DEFAULT_BASELINE_PATH = ".polyglot/visual-baseline.json";
const ARTIFACTS_DIR = ".polyglot/artifacts/visual-qa";

// ---------------------------------------------------------------------------
// Contrast (WCAG 2.x)
// ---------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseCssColor(css: string): Rgba | null {
  const s = String(css ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (s === "black") return { r: 0, g: 0, b: 0, a: 1 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = /^rgba?\(\s*([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p: string) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const out = { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a: Number.isFinite(alpha) ? alpha : 1 };
    if (![out.r, out.g, out.b].every(Number.isFinite)) return null;
    return out;
  }
  return null;
}

function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = Math.min(255, Math.max(0, v)) / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio between a foreground and background CSS color (rgb()/rgba()/#hex). */
export function contrastRatio(fgCss: string, bgCss: string): number {
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  let bg = parseCssColor(bgCss) ?? white;
  if (bg.a < 1) {
    // composite translucent background over white canvas
    bg = {
      r: bg.r * bg.a + 255 * (1 - bg.a),
      g: bg.g * bg.a + 255 * (1 - bg.a),
      b: bg.b * bg.a + 255 * (1 - bg.a),
      a: 1,
    };
  }
  let fg = parseCssColor(fgCss) ?? { r: 0, g: 0, b: 0, a: 1 };
  if (fg.a < 1) {
    fg = {
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    };
  }
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return Math.round(ratio * 100) / 100;
}

// ---------------------------------------------------------------------------
// Pure geometry diff
// ---------------------------------------------------------------------------

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pair each snapshot with its occurrence index among same-key snapshots. */
function withOccurrence(list: ElementGeometrySnapshot[]): Array<{ id: string; occ: number; snap: ElementGeometrySnapshot }> {
  const seen = new Map<string, number>();
  return list.map((snap) => {
    const occ = seen.get(snap.key) ?? 0;
    seen.set(snap.key, occ + 1);
    return { id: `${snap.key}#${occ}`, occ, snap };
  });
}

export function diffGeometry(
  base: ElementGeometrySnapshot[] | undefined,
  curr: ElementGeometrySnapshot[],
  ctx: { route: string; locale: string; viewport: string }
): VisualDefect[] {
  const baseById = new Map<string, ElementGeometrySnapshot>();
  if (base) for (const b of withOccurrence(base)) baseById.set(b.id, b.snap);

  const defects: VisualDefect[] = [];
  for (const { id, occ, snap: c } of withOccurrence(curr)) {
    const b = baseById.get(id);
    const keyLabel = occ > 0 ? `${c.key}#${occ}` : c.key;
    const push = (type: VisualDefectType, delta: Record<string, number>, message: string) => {
      defects.push({
        id: `${type}:${ctx.locale}:${ctx.viewport}:${ctx.route}:${keyLabel}`,
        type,
        route: ctx.route,
        locale: ctx.locale,
        viewport: ctx.viewport,
        key: c.key,
        file: c.file ?? b?.file,
        line: c.line ?? b?.line,
        base: b,
        curr: c,
        delta,
        message,
      });
    };
    const where = `"${c.key}" <${c.tag}> (${ctx.locale}, ${ctx.viewport}, ${ctx.route})`;

    if (b && c.lineCount > b.lineCount) {
      push(
        "line_wrap_regression",
        { lineCount: c.lineCount - b.lineCount, height: r2(c.height - b.height) },
        `${where} wraps to ${c.lineCount} lines (baseline ${b.lineCount}).`
      );
    }
    if ((b && c.height > b.height * 1.15) || c.overflowX > 1) {
      push(
        "container_blowout",
        { height: r2(c.height - (b?.height ?? c.height)), width: r2(c.width - (b?.width ?? c.width)), overflowX: r2(c.overflowX) },
        b && c.height > b.height * 1.15
          ? `${where} grew from ${b.height}px to ${c.height}px tall (>15%).`
          : `${where} overflows its box horizontally by ${c.overflowX}px.`
      );
    }
    if (c.clipped || c.scrollWidth > c.clientWidth + 1) {
      push(
        "text_truncation",
        { overflowPx: r2(Math.max(0, c.scrollWidth - c.clientWidth)) },
        `${where} text is truncated/clipped (scrollWidth ${c.scrollWidth}px > clientWidth ${c.clientWidth}px).`
      );
    }
    if (c.occluded) {
      push("element_occlusion", { occluded: 1 }, `${where} is covered by another element at its center point.`);
    }
    if (!c.fontLoaded) {
      push("missing_glyph_tofu", { fontLoaded: 0 }, `${where} renders glyphs missing from the loaded font (tofu).`);
    }
    if (b && c.contrastRatio < 4.5 && c.contrastRatio < b.contrastRatio - 0.5) {
      push(
        "contrast_regression",
        { contrastRatio: r2(c.contrastRatio - b.contrastRatio) },
        `${where} contrast dropped to ${c.contrastRatio}:1 (baseline ${b.contrastRatio}:1, WCAG AA needs 4.5:1).`
      );
    }
  }
  return defects;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface RawMeasured {
  idx: number;
  directText: string;
  attrKey?: string;
  tag: string;
  width: number;
  height: number;
  lineCount: number;
  scrollWidth: number;
  clientWidth: number;
  clipped: boolean;
  occluded: boolean;
  fontLoaded: boolean;
  color: string;
  background: string;
}

function sanitizeForFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[_.]+|_+$/g, "").slice(0, 100) || "element";
}

function sortSnapshots(list: ElementGeometrySnapshot[]): ElementGeometrySnapshot[] {
  // Stable sort by key keeps DOM order among duplicates (occurrence index matching).
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.key < b.s.key ? -1 : a.s.key > b.s.key ? 1 : a.i - b.i))
    .map((x) => x.s);
}

function normalizeSnapshot(s: ElementGeometrySnapshot): ElementGeometrySnapshot {
  const out: ElementGeometrySnapshot = { key: s.key } as ElementGeometrySnapshot;
  if (s.file !== undefined) out.file = s.file;
  if (s.line !== undefined) out.line = s.line;
  out.tag = s.tag;
  out.width = s.width;
  out.height = s.height;
  out.lineCount = s.lineCount;
  out.scrollWidth = s.scrollWidth;
  out.clientWidth = s.clientWidth;
  out.overflowX = s.overflowX;
  out.clipped = s.clipped;
  out.occluded = s.occluded;
  out.fontLoaded = s.fontLoaded;
  out.contrastRatio = s.contrastRatio;
  return out;
}

/** Runs entirely in the browser page: tags traced elements and measures their geometry. */
function measureInPage(): RawMeasured[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const doc = g.document;
  const win = g.window;
  const getCS = g.getComputedStyle;
  const ZW_STRIP = /[\u200B\u2060\u2062\u2063\u2064]/g;
  const out: RawMeasured[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = Array.from(doc.body ? doc.body.querySelectorAll("*") : []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traced: Array<{ el: any; directText: string; attrKey?: string }> = [];
  for (const el of all) {
    const tagName = String(el.tagName).toLowerCase();
    if (tagName === "script" || tagName === "style" || tagName === "noscript" || tagName === "template") continue;
    let directText = "";
    for (const n of Array.from(el.childNodes)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = n as any;
      if (node.nodeType === 3) directText += String(node.textContent || "");
    }
    const hasZw = directText.indexOf("\u2064") !== -1;
    const attrKey = el.getAttribute("data-i18n-key") || el.getAttribute("data-testid") || undefined;
    if (!hasZw && !attrKey) continue;
    const style = getCS(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    traced.push({ el, directText, attrKey });
  }

  // Canvas .notdef probe (meaningful even when fonts.check() says true for system fallbacks)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ctx2d: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let canvas: any = null;
  try {
    canvas = doc.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    ctx2d = canvas.getContext("2d");
  } catch {
    ctx2d = null;
  }
  const renderSig = (ch: string, font: string): string => {
    ctx2d.clearRect(0, 0, 32, 32);
    ctx2d.font = font;
    ctx2d.fillStyle = "#000";
    ctx2d.fillText(ch, 2, 24);
    return String(canvas.toDataURL());
  };

  for (let i = 0; i < traced.length; i++) {
    const { el, directText, attrKey } = traced[i];
    el.setAttribute("data-pg-vqa-idx", String(i));
    const style = getCS(el);
    const rect = el.getBoundingClientRect();
    const fontSize = parseFloat(style.fontSize) || 16;
    const lh = style.lineHeight === "normal" ? fontSize * 1.2 : parseFloat(style.lineHeight) || fontSize * 1.2;
    const vChrome =
      (parseFloat(style.paddingTop) || 0) +
      (parseFloat(style.paddingBottom) || 0) +
      (parseFloat(style.borderTopWidth) || 0) +
      (parseFloat(style.borderBottomWidth) || 0);
    const contentH = Math.max(0, rect.height - vChrome);
    const lineCount = Math.max(1, Math.round(contentH / lh));

    const scrollWidth = Number(el.scrollWidth) || 0;
    const clientWidth = Number(el.clientWidth) || 0;
    const scrollHeight = Number(el.scrollHeight) || 0;
    const clientHeight = Number(el.clientHeight) || 0;
    const lineClamp = style.webkitLineClamp || style.getPropertyValue("-webkit-line-clamp") || "none";
    const clips =
      style.overflowX === "hidden" ||
      style.overflowX === "clip" ||
      style.textOverflow === "ellipsis" ||
      (lineClamp !== "none" && lineClamp !== "");
    const clipped = clips && (scrollWidth > clientWidth + 1 || scrollHeight > clientHeight + 1);

    // Occlusion: hit test at the element's center (scroll into view when off-screen)
    let occluded = false;
    let r = rect;
    const offscreen = (rr: { left: number; top: number; width: number; height: number }) => {
      const cx = rr.left + rr.width / 2;
      const cy = rr.top + rr.height / 2;
      return cx < 0 || cy < 0 || cx >= win.innerWidth || cy >= win.innerHeight;
    };
    if (offscreen(r)) {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch {
        // ignore
      }
      r = el.getBoundingClientRect();
    }
    if (!offscreen(r)) {
      const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      occluded = Boolean(hit && hit !== el && !el.contains(hit) && !hit.contains(el));
    }

    // Font / glyph coverage
    const stripped = directText.replace(ZW_STRIP, "").trim();
    const nonAscii = stripped.replace(/[\x00-\x7F]/g, "");
    const sample = (nonAscii || stripped).slice(0, 8) || "a";
    let fontLoaded = true;
    try {
      if (doc.fonts && typeof doc.fonts.check === "function") {
        fontLoaded = Boolean(doc.fonts.check(`${style.fontSize} ${style.fontFamily}`, sample));
      }
    } catch {
      fontLoaded = true;
    }
    if (fontLoaded && ctx2d && nonAscii) {
      try {
        const font = style.font || `${style.fontSize} ${style.fontFamily}`;
        const tofuSig = renderSig("\uFFFD", font);
        const unmappedSig = renderSig("\u0378", font);
        const chars = Array.from(nonAscii.replace(/\s+/g, "")).slice(0, 6);
        for (const ch of chars) {
          const sig = renderSig(ch, font);
          if (sig === tofuSig || sig === unmappedSig) {
            fontLoaded = false;
            break;
          }
        }
      } catch {
        // ignore canvas failures
      }
    }

    // Contrast: computed color vs first ancestor with non-transparent background
    let background = "rgb(255, 255, 255)";
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const bg = String(getCS(cur).backgroundColor || "");
      const transparent =
        !bg || bg === "transparent" || /^rgba\([^)]*,\s*0\s*\)$/.test(bg) || /\/\s*0\s*\)$/.test(bg);
      if (!transparent) {
        background = bg;
        break;
      }
      cur = cur.parentElement;
    }

    out.push({
      idx: i,
      directText,
      attrKey,
      tag: String(el.tagName).toLowerCase(),
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      lineCount,
      scrollWidth,
      clientWidth,
      clipped,
      occluded,
      fontLoaded,
      color: String(style.color || "rgb(0, 0, 0)"),
      background,
    });
  }
  try {
    win.scrollTo(0, 0);
  } catch {
    // ignore
  }
  return out;
}

export async function runVisualQa(options: VisualQaOptions): Promise<VisualQaResult> {
  const store = new PolyglotStore(options.rootDir);
  const config = store.readConfig();
  const layoutCfg = config.layout;
  const mode: "capture" | "diff" = options.captureBaseline ? "capture" : "diff";

  const baseUrl = options.baseUrl ?? layoutCfg?.baseUrl;
  const routes = options.routes && options.routes.length > 0 ? options.routes : layoutCfg?.routes ?? ["/"];
  const viewports = options.viewports && options.viewports.length > 0 ? options.viewports : DEFAULT_VIEWPORTS;
  const localeUrlPattern = options.localeUrlPattern ?? layoutCfg?.localeUrlPattern ?? "query";
  const locales =
    options.locales && options.locales.length > 0
      ? [...options.locales]
      : config.targetLocales.length > 0
        ? [...config.targetLocales]
        : [config.sourceLocale];
  const vpLabels = viewports.map((v) => `${v.width}x${v.height}`);

  const baselineRel = options.basePath ?? DEFAULT_BASELINE_PATH;
  const baselineAbs = resolveConfinedPath(store.rootDir, baselineRel, { label: "visual baseline path" });
  const baselinePath = path.relative(store.rootDir, baselineAbs).replace(/\\/g, "/") || baselineRel;

  const inconclusive = (reason: string, nextSteps: string[]): VisualQaResult => ({
    outcome: "INCONCLUSIVE",
    passed: false,
    mode,
    inconclusiveReason: reason,
    baseUrl,
    baselinePath,
    routesChecked: [],
    localesChecked: [],
    viewportsChecked: vpLabels,
    elementsMeasured: 0,
    defectCount: 0,
    countsByType: {},
    defects: [],
    screenshots: [],
    nextSteps,
    tokensUsed: 0,
  });

  if (!baseUrl) {
    return inconclusive(
      "No baseUrl configured for visual QA. Start your dev server and pass --url http://localhost:3000 (or set layout.baseUrl in .polyglot/config.json).",
      [
        "Start your local dev server (e.g. npm run dev).",
        "Run `polyglot visual-qa --url http://localhost:3000` or add `layout.baseUrl` to `.polyglot/config.json`.",
      ]
    );
  }

  let baseline: VisualBaselineFile | undefined;
  if (mode === "diff") {
    if (!fs.existsSync(baselineAbs)) {
      return inconclusive(`No visual baseline found at ${baselinePath}; cannot diff geometry without a baseline.`, [
        `Run \`polyglot visual-qa --capture-baseline --url ${baseUrl}\` on a known-good build first.`,
        "Then re-run `polyglot visual-qa` to diff against the baseline.",
      ]);
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(baselineAbs, "utf8")) as VisualBaselineFile;
      if (!parsed || typeof parsed !== "object" || typeof parsed.snapshots !== "object" || parsed.snapshots === null) {
        throw new Error("missing snapshots");
      }
      baseline = parsed;
    } catch (err) {
      return inconclusive(
        `Visual baseline at ${baselinePath} is unreadable (${err instanceof Error ? err.message : String(err)}).`,
        ["Re-run `polyglot visual-qa --capture-baseline` to regenerate the baseline."]
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any;
  try {
    pw = await (options.playwrightLoader ?? defaultPlaywrightLoader)();
    if (!pw?.chromium) throw new Error("no chromium export");
  } catch {
    return inconclusive(
      "Playwright is not installed (optional peer dependency). Visual QA cannot run without a browser.",
      ["Install Playwright: `npm install -D playwright && npx playwright install chromium`", "Re-run `polyglot visual-qa`."]
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (firstErr) {
    let lastErr: unknown = firstErr;
    for (const exe of SYSTEM_CHROMIUM_PATHS.filter((p) => fs.existsSync(p))) {
      try {
        browser = await pw.chromium.launch({ headless: true, executablePath: exe });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!browser) {
      return inconclusive(
        `Playwright could not launch Chromium: ${lastErr instanceof Error ? lastErr.message.split("\n")[0] : String(lastErr)}`,
        ["Run `npx playwright install chromium` (or install a system Chromium) and retry `polyglot visual-qa`."]
      );
    }
  }

  // Key -> file:line mapping (tolerate no adapter)
  let usageByKey: Record<string, UsageSite[]> = {};
  try {
    const { adapter, detection } = detectProjectAdapter(store.rootDir, config.framework, config.paths.locales);
    if (adapter) {
      usageByKey = adapter.scanSource(store.rootDir, {
        sourcePaths: config.paths.source,
        ignore: config.paths.ignore,
        i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
      }).usageByKey;
    }
  } catch {
    usageByKey = {};
  }

  const artifactsAbs = resolveConfinedPath(store.rootDir, ARTIFACTS_DIR, { label: "visual QA artifacts dir" });
  const manifestAbs = path.join(artifactsAbs, "manifest.json");
  const rel = (abs: string) => path.relative(store.rootDir, abs).replace(/\\/g, "/");

  const captured: Record<string, ElementGeometrySnapshot[]> = {};
  const defects: VisualDefect[] = [];
  const screenshots: string[] = [];
  const usedShotPaths = new Set<string>();
  let elementsMeasured = 0;

  try {
    for (const locale of locales) {
      for (const route of routes) {
        const url = buildRouteUrl(baseUrl, route, locale, localeUrlPattern);
        for (const viewport of viewports) {
          const vp = `${viewport.width}x${viewport.height}`;
          const tupleKey = `${route}|${vp}|${locale}`;
          const context = await browser.newContext({ viewport, locale: locale.replace(/-X[A-F]$/i, "") });
          try {
            if (localeUrlPattern === "cookie") {
              const host = new URL(url).hostname;
              await context.addCookies([
                { name: "NEXT_LOCALE", value: locale, domain: host, path: "/" },
                { name: "locale", value: locale, domain: host, path: "/" },
              ]);
            }
            const page = await context.newPage();
            try {
              await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
            } catch {
              await page.goto(url, { waitUntil: "load", timeout: 15_000 });
            }
            try {
              await page.evaluate(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const g = globalThis as any;
                return g.document.fonts ? g.document.fonts.ready.then(() => true) : true;
              });
            } catch {
              // ignore
            }

            const raw: RawMeasured[] = await page.evaluate(measureInPage);
            const measured: Array<{ idx: number; snap: ElementGeometrySnapshot }> = [];
            for (const m of raw) {
              const key = decodeZeroWidthKeyIds(m.directText)[0] ?? m.attrKey;
              if (!key) continue;
              const site = usageByKey[key]?.[0];
              measured.push({
                idx: m.idx,
                snap: normalizeSnapshot({
                  key,
                  file: site?.file,
                  line: site?.line,
                  tag: m.tag,
                  width: m.width,
                  height: m.height,
                  lineCount: m.lineCount,
                  scrollWidth: m.scrollWidth,
                  clientWidth: m.clientWidth,
                  overflowX: Math.max(0, m.scrollWidth - m.clientWidth),
                  clipped: m.clipped,
                  occluded: m.occluded,
                  fontLoaded: m.fontLoaded,
                  contrastRatio: contrastRatio(m.color, m.background),
                }),
              });
            }
            // Stable sort by key so occurrence indices line up with the (sorted) baseline.
            const order = measured
              .map((x, i) => ({ x, i }))
              .sort((a, b) => (a.x.snap.key < b.x.snap.key ? -1 : a.x.snap.key > b.x.snap.key ? 1 : a.i - b.i))
              .map((o) => o.x);
            elementsMeasured += order.length;
            const currSnaps = order.map((o) => o.snap);
            captured[tupleKey] = currSnaps;

            if (mode === "diff") {
              const tupleDefects = diffGeometry(baseline?.snapshots[tupleKey], currSnaps, { route, locale, viewport: vp });
              // Failure-only artifacts: one cropped screenshot per defective element
              const shotByElement = new Map<ElementGeometrySnapshot, string | undefined>();
              for (const d of tupleDefects) {
                if (!shotByElement.has(d.curr)) {
                  const entry = order.find((o) => o.snap === d.curr);
                  let shotRel: string | undefined;
                  if (entry) {
                    const localeDir = resolveConfinedPath(artifactsAbs, sanitizeForFile(locale), {
                      label: "visual QA locale dir",
                    });
                    fs.mkdirSync(localeDir, { recursive: true });
                    const baseName = `${sanitizeForFile(d.key)}-${vp}`;
                    let shotAbs = path.join(localeDir, `${baseName}.png`);
                    for (let n = 2; usedShotPaths.has(shotAbs); n++) {
                      shotAbs = path.join(localeDir, `${baseName}-${n}.png`);
                    }
                    try {
                      await page
                        .locator(`[data-pg-vqa-idx="${entry.idx}"]`)
                        .first()
                        .screenshot({ path: shotAbs, timeout: 5_000 });
                      usedShotPaths.add(shotAbs);
                      shotRel = rel(shotAbs);
                      screenshots.push(shotRel);
                    } catch {
                      shotRel = undefined;
                    }
                  }
                  shotByElement.set(d.curr, shotRel);
                }
                d.screenshot = shotByElement.get(d.curr);
                defects.push(d);
              }
            }
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  const base = {
    baseUrl,
    baselinePath,
    routesChecked: routes,
    localesChecked: locales,
    viewportsChecked: vpLabels,
    elementsMeasured,
    tokensUsed: 0 as const,
  };

  if (mode === "capture") {
    const snapshots: Record<string, ElementGeometrySnapshot[]> = {};
    for (const k of Object.keys(captured).sort()) snapshots[k] = sortSnapshots(captured[k]).map(normalizeSnapshot);
    const file: VisualBaselineFile = { version: 1, capturedAt: new Date().toISOString(), baseUrl, snapshots };
    atomicWriteFileSync(baselineAbs, JSON.stringify(file, null, 2) + "\n");
    return {
      outcome: "PASS",
      passed: true,
      mode,
      ...base,
      defectCount: 0,
      countsByType: {},
      defects: [],
      screenshots: [],
      nextSteps: [
        `Baseline captured (${elementsMeasured} elements) at ${baselinePath}. Run \`polyglot visual-qa\` after changes to diff against it.`,
      ],
    };
  }

  const countsByType: Record<string, number> = {};
  for (const d of defects) countsByType[d.type] = (countsByType[d.type] ?? 0) + 1;

  let manifestPath: string | undefined;
  if (defects.length > 0) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      defects: defects.map((d) => ({
        id: d.id,
        type: d.type,
        key: d.key,
        locale: d.locale,
        route: d.route,
        viewport: d.viewport,
        file: d.file,
        line: d.line,
        screenshot: d.screenshot,
        delta: d.delta,
      })),
    };
    atomicWriteFileSync(manifestAbs, JSON.stringify(manifest, null, 2) + "\n");
    manifestPath = rel(manifestAbs);
  } else if (fs.existsSync(manifestAbs)) {
    try {
      fs.unlinkSync(manifestAbs);
    } catch {
      // ignore stale manifest cleanup failure
    }
  }

  const outcome = defects.length === 0 ? "PASS" : "FAIL";
  const nextSteps: string[] = [];
  if (outcome === "FAIL") {
    nextSteps.push(
      `Inspect the cropped screenshots listed in ${manifestPath} and fix each element at its file:line (shorten copy, relax fixed widths, remove overlays, add font fallbacks, or restore contrast).`
    );
    nextSteps.push("Re-run `polyglot visual-qa` until it returns PASS.");
    nextSteps.push("If the new geometry is intentional, re-capture with `polyglot visual-qa --capture-baseline`.");
  }

  return {
    outcome,
    passed: outcome === "PASS",
    mode,
    ...base,
    defectCount: defects.length,
    countsByType,
    defects,
    manifestPath,
    screenshots,
    nextSteps,
  };
}
