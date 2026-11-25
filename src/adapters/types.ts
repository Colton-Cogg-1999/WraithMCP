import { HardcodedFormattingFinding } from "../core/formatting-scanner.js";
import { FrameworkName, UsageSite } from "../core/types.js";
import { FormatAdapter, PlaceholderSyntax } from "../formats/types.js";

export interface HardcodedStringFinding {
  file: string;
  line: number;
  column: number;
  text: string;
  kind: "jsx-text" | "attribute" | "toast" | "template-text" | "ruby-string" | "python-string";
  attribute?: string;
  component?: string;
  snippet: string;
}

export interface ConcatenationFinding {
  file: string;
  line: number;
  column: number;
  expression: string;
  reason: string;
  component?: string;
}

export interface FrameworkDetection {
  framework: FrameworkName;
  i18nLibrary: string | null;
  confidence: number;
  localesDir: string | null;
  localeFiles: Record<string, string[]>;
  placeholderSyntaxes: PlaceholderSyntax[];
  notes: string[];
}

export interface LayoutRiskFinding {
  file: string;
  line: number;
  kind: "truncation_or_fixed_width" | "rtl_physical_direction";
  constraint: string;
  key?: string;
  component?: string;
  suggestion: string;
  snippet: string;
}

export interface ParseFailure {
  file: string;
  error: string;
}

export interface ScanSourceResult {
  filesScanned: number;
  hardcodedStrings: HardcodedStringFinding[];
  concatenations: ConcatenationFinding[];
  usageByKey: Record<string, UsageSite[]>;
  layoutRisks?: LayoutRiskFinding[];
  hardcodedFormatting?: HardcodedFormattingFinding[];
  parseFailures?: ParseFailure[];
  /** Namespaces or "*" where dynamic translation keys were encountered (prevents false orphan claims) */
  dynamicKeyNamespaces?: string[];
  skippedFiles?: Array<{ file: string; reason: string }>;
}

export interface ScannerAdapter {
  readonly id: string;
  readonly frameworks: readonly FrameworkName[];
  readonly format: FormatAdapter;

  /** Detect whether this adapter applies to the repository. */
  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null;

  /** Scan source files for hardcoded strings, concatenations, and i18n key usage sites. */
  scanSource(
    rootDir: string,
    options: {
      sourcePaths: string[];
      ignore: string[];
      i18nLibrary?: string | null;
    }
  ): ScanSourceResult;

  /** Resolve where a target locale file should be written for a given source locale file. */
  resolveTargetLocaleFile(
    rootDir: string,
    sourceLocale: string,
    targetLocale: string,
    sourceFile: string
  ): string;
}
