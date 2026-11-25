import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Resolve Playwright module from either local node_modules or mise's playwright installation.
 */
async function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const candidates = [
    "playwright",
    "/home/colton/.local/share/mise/installs/playwright/latest/node_modules/playwright",
    "/home/colton/.local/share/mise/installs/playwright/latest/lib/node_modules/playwright",
    "/home/colton/.local/share/mise/installs/node/latest/lib/node_modules/playwright",
  ];
  for (const c of candidates) {
    try {
      return req(c);
    } catch {
      // try next
    }
  }
  // Discover via `playwright` binary symlink realpath
  try {
    const binPath = execFileSync("which", ["playwright"], { encoding: "utf8" }).trim();
    if (binPath) {
      const real = fs.realpathSync(binPath);
      const pkgDir = path.resolve(path.dirname(real), "..");
      return req(pkgDir);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Render an HTML page for a given locale via an ephemeral localhost server and detect
 * DOM text overflow, clipping, button/tab overlap, and horizontal page overflow with Playwright.
 */
export async function inspectVisualLayout({
  htmlByLocale,
  screenshotDir,
  appName,
  systemLabel,
  viewports = [
    { name: "desktop", width: 1280, height: 800 },
    { name: "narrow", width: 420, height: 844 },
  ],
}) {
  const pw = await loadPlaywright();
  if (!pw) {
    return {
      available: false,
      error: "Playwright JS module could not be resolved.",
      locales: {},
    };
  }

  fs.mkdirSync(screenshotDir, { recursive: true });
  const server = http.createServer((req, res) => {
    const locale = decodeURIComponent((req.url ?? "/en").replace(/^\//, "").split("?")[0] || "en");
    const html = htmlByLocale[locale];
    if (!html) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  let browser;
  try {
    const sysBrowsers = ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
    const foundSys = sysBrowsers.find((b) => fs.existsSync(b));
    try {
      browser = await pw.chromium.launch({ headless: true });
    } catch {
      if (!foundSys) throw new Error("Playwright chromium not installed and no system chromium found");
      browser = await pw.chromium.launch({ headless: true, executablePath: foundSys });
    }
    const localeResults = {};

    for (const locale of Object.keys(htmlByLocale)) {
      localeResults[locale] = { viewports: {}, totalDefects: 0 };
      for (const vp of viewports) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
        await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(locale)}`, {
          waitUntil: "networkidle",
        });

        const defects = await page.evaluate(() => {
          const found = [];
          const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
          if (docOverflow > 2) {
            found.push({
              kind: "viewport_horizontal_overflow",
              selector: "html",
              overflowPx: Math.round(docOverflow),
              text: "",
            });
          }

          const els = document.querySelectorAll("button, a, h1, h2, h3, label, span, p, [role='tab'], .tight-btn, .tab-item, .badge");
          for (const el of els) {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const text = (el.textContent ?? "").trim().slice(0, 80);
            if (!text) continue;

            const clipsX =
              (style.overflowX === "hidden" || style.overflowX === "clip" || style.textOverflow === "ellipsis") &&
              el.scrollWidth > el.clientWidth + 2;
            const clipsY =
              (style.overflowY === "hidden" || style.overflowY === "clip") &&
              el.scrollHeight > el.clientHeight + 2;

            if (clipsX) {
              found.push({
                kind: "horizontal_text_clipping",
                selector: el.getAttribute("data-testid") || `${el.tagName.toLowerCase()}.${el.className}`,
                overflowPx: Math.round(el.scrollWidth - el.clientWidth),
                text,
              });
            }
            if (clipsY) {
              found.push({
                kind: "vertical_text_clipping",
                selector: el.getAttribute("data-testid") || `${el.tagName.toLowerCase()}.${el.className}`,
                overflowPx: Math.round(el.scrollHeight - el.clientHeight),
                text,
              });
            }
          }

          // Check sibling overlap inside nav/tablist containers
          const containers = document.querySelectorAll("nav, [role='tablist']");
          for (const container of containers) {
            const kids = [...container.children].map((k) => ({
              el: k,
              r: k.getBoundingClientRect(),
            }));
            for (let i = 0; i < kids.length; i++) {
              for (let j = i + 1; j < kids.length; j++) {
                const a = kids[i].r;
                const b = kids[j].r;
                const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (overlapX > 2 && overlapY > 2) {
                  found.push({
                    kind: "sibling_overlap",
                    selector: `${kids[i].el.tagName.toLowerCase()}+${kids[j].el.tagName.toLowerCase()}`,
                    overflowPx: Math.round(overlapX),
                    text: `${(kids[i].el.textContent ?? "").trim()} / ${(kids[j].el.textContent ?? "").trim()}`.slice(0, 80),
                  });
                }
              }
            }
          }
          return found;
        });

        const shotName = `${appName}-${systemLabel}-${locale}-${vp.name}.png`;
        const shotPath = path.join(screenshotDir, shotName);
        await page.screenshot({ path: shotPath, fullPage: true });
        await page.close();

        localeResults[locale].viewports[vp.name] = {
          defectCount: defects.length,
          defects,
          screenshot: shotPath,
        };
        localeResults[locale].totalDefects += defects.length;
      }
    }

    return { available: true, locales: localeResults };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
      locales: {},
    };
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}
