import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8 } from "fflate";
import { safeUnzipSync } from "../core/security.js";
import { CheckOutcome } from "../core/types.js";

/**
 * Nuanced LibreOffice formatting-integrity verifier for OOXML documents (.docx, .pptx, .xlsx).
 *
 * Design principles:
 * 1. DOCX (reflowing prose — patient letters, clinical studies, legal contracts, manuals):
 *    Natural page-count growth (e.g., 3 -> 4 pages in German) is NORMAL and reported purely as
 *    informational (`doc_reflow_info`), NEVER as an error. What fails a DOCX is XML/render
 *    corruption (`doc_render_failed`) or exceeding an explicit opt-in `maxPages` budget
 *    (e.g., for a fixed 1-page flyer or form).
 * 2. PPTX (fixed-canvas slides): Slide/page count mismatches (`pptx_slide_count_mismatch`) or
 *    render failures fail loudly because slides have fixed visual canvases.
 * 3. XLSX (spreadsheets): Verifies clean LibreOffice PDF rendering AND checks that every `<f>`
 *    formula in the source workbook is preserved identically in the translated workbook
 *    (`xlsx_formula_mismatch`).
 * 4. Returns `INCONCLUSIVE` (never fake `PASS`) when `soffice` is not installed.
 */

export interface DocumentVerifyFinding {
  code:
    | "doc_render_failed"
    | "pptx_slide_count_mismatch"
    | "doc_page_budget_exceeded"
    | "xlsx_formula_mismatch"
    | "doc_reflow_info"
    | "libreoffice_unavailable";
  severity: "error" | "warning" | "info";
  message: string;
}

export interface DocumentVerifyResult {
  outcome: CheckOutcome;
  format: "docx" | "pptx" | "xlsx";
  sourceFile: string;
  targetFile: string;
  libreOfficeAvailable: boolean;
  sourcePages: number | null;
  targetPages: number | null;
  findings: DocumentVerifyFinding[];
}

function findSoffice(): string | null {
  const candidates =
    process.platform === "win32"
      ? ["soffice.exe", "C:\\Program Files\\LibreOffice\\program\\soffice.exe"]
      : ["/usr/bin/soffice", "/usr/local/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice", "soffice"];

  for (const c of candidates) {
    if (c.includes(path.sep) || c.includes("/")) {
      if (fs.existsSync(c)) return c;
    } else {
      try {
        execFileSync(process.platform === "win32" ? "where" : "which", [c], { stdio: "ignore" });
        return c;
      } catch {
        // continue
      }
    }
  }
  return null;
}

/** Count pages in a PDF buffer without external dependencies. */
export function countPdfPages(pdfBuffer: Buffer): number {
  const latin1 = pdfBuffer.toString("latin1");
  // Match `/Type /Page` (excluding `/Type /Pages`)
  const matches = latin1.match(/\/Type\s*\/Page\b(?!s)/g);
  return matches ? matches.length : 0;
}

function convertToPdfWithSoffice(soffice: string, inputFile: string, outDir: string): { ok: true; pdfPath: string; pages: number } | { ok: false; error: string } {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-lo-profile-"));
  try {
    const profileUrl = `file://${profileDir.replace(/\\/g, "/")}`;
    execFileSync(
      soffice,
      [
        `-env:UserInstallation=${profileUrl}`,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        inputFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }
    );
    const pdfName = path.basename(inputFile, path.extname(inputFile)) + ".pdf";
    const pdfPath = path.join(outDir, pdfName);
    if (!fs.existsSync(pdfPath)) {
      return { ok: false, error: `LibreOffice did not produce PDF output for ${path.basename(inputFile)}.` };
    }
    const buf = fs.readFileSync(pdfPath);
    const pages = countPdfPages(buf);
    if (buf.length < 100 || pages < 1) {
      return { ok: false, error: `Rendered PDF for ${path.basename(inputFile)} is empty or malformed.` };
    }
    return { ok: true, pdfPath, pages };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

function extractXlsxFormulas(filePath: string): string[] {
  const entries = safeUnzipSync(fs.readFileSync(filePath));
  const formulas: string[] = [];
  for (const name of Object.keys(entries).sort()) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = strFromU8(entries[name]);
    for (const m of xml.matchAll(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/g)) {
      formulas.push(`${name}:${m[1].trim()}`);
    }
  }
  return formulas;
}

export function verifyDocumentFormatting(options: {
  sourceFile: string;
  targetFile: string;
  /** Optional explicit page budget (e.g., for fixed 1-page flyers/forms). Never inferred for reflowing DOCX! */
  maxPages?: number;
}): DocumentVerifyResult {
  const ext = path.extname(options.sourceFile).toLowerCase();
  if (ext !== ".docx" && ext !== ".pptx" && ext !== ".xlsx") {
    throw new Error(`Unsupported document format for formatting verification: ${ext}`);
  }
  const format = ext.slice(1) as "docx" | "pptx" | "xlsx";
  const findings: DocumentVerifyFinding[] = [];

  // 1. Structural XLSX formula check (runs even without LibreOffice!)
  if (format === "xlsx") {
    const srcFormulas = extractXlsxFormulas(options.sourceFile);
    const tgtFormulas = extractXlsxFormulas(options.targetFile);
    if (JSON.stringify(srcFormulas) !== JSON.stringify(tgtFormulas)) {
      findings.push({
        code: "xlsx_formula_mismatch",
        severity: "error",
        message: `XLSX formulas changed after translation (source: ${srcFormulas.length}, target: ${tgtFormulas.length}). Formulas must remain identical.`,
      });
    }
  }

  // 2. Headless LibreOffice render check
  const soffice = findSoffice();
  if (!soffice) {
    findings.push({
      code: "libreoffice_unavailable",
      severity: "warning",
      message: "LibreOffice (soffice) is not installed; cannot verify visual PDF rendering.",
    });
    return {
      outcome: findings.some((f) => f.severity === "error") ? "FAIL" : "INCONCLUSIVE",
      format,
      sourceFile: options.sourceFile,
      targetFile: options.targetFile,
      libreOfficeAvailable: false,
      sourcePages: null,
      targetPages: null,
      findings,
    };
  }

  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-doc-verify-"));
  try {
    const srcOutDir = path.join(tmpOut, "src");
    const tgtOutDir = path.join(tmpOut, "tgt");
    fs.mkdirSync(srcOutDir, { recursive: true });
    fs.mkdirSync(tgtOutDir, { recursive: true });

    const srcRender = convertToPdfWithSoffice(soffice, options.sourceFile, srcOutDir);
    if (!srcRender.ok) {
      findings.push({
        code: "doc_render_failed",
        severity: "error",
        message: `Source document failed to render in LibreOffice: ${srcRender.error}`,
      });
    }

    const tgtRender = convertToPdfWithSoffice(soffice, options.targetFile, tgtOutDir);
    if (!tgtRender.ok) {
      findings.push({
        code: "doc_render_failed",
        severity: "error",
        message: `Translated document failed to render in LibreOffice (possible XML/formatting corruption): ${tgtRender.error}`,
      });
    }

    const sourcePages = srcRender.ok ? srcRender.pages : null;
    const targetPages = tgtRender.ok ? tgtRender.pages : null;

    if (sourcePages !== null && targetPages !== null) {
      if (format === "pptx" && targetPages !== sourcePages) {
        findings.push({
          code: "pptx_slide_count_mismatch",
          severity: "error",
          message: `PPTX slide count changed after translation (${sourcePages} -> ${targetPages} slides).`,
        });
      } else if (options.maxPages !== undefined && targetPages > options.maxPages) {
        findings.push({
          code: "doc_page_budget_exceeded",
          severity: "error",
          message: `Translated ${format.toUpperCase()} rendered to ${targetPages} page(s), exceeding explicit maxPages budget (${options.maxPages}).`,
        });
      } else if (format === "docx" && targetPages !== sourcePages) {
        // Nuanced DOCX behavior: reflowing prose documents (letters, studies, contracts) naturally expand
        findings.push({
          code: "doc_reflow_info",
          severity: "info",
          message: `Translated DOCX reflowed cleanly from ${sourcePages} to ${targetPages} page(s) with intact formatting (informational; set maxPages only for fixed-page layouts).`,
        });
      }
    }

    const hasError = findings.some((f) => f.severity === "error");
    return {
      outcome: hasError ? "FAIL" : "PASS",
      format,
      sourceFile: options.sourceFile,
      targetFile: options.targetFile,
      libreOfficeAvailable: true,
      sourcePages,
      targetPages,
      findings,
    };
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
}
