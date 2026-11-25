export type PlaceholderSyntax =
  | "icu"
  | "double-mustache"
  | "single-brace"
  | "percent-brace"
  | "python-printf";

export interface LocaleEntry {
  key: string;
  value: string;
  /** Optional plural variants for formats that store plurals as subkeys (Rails YAML, PO) */
  plurals?: Record<string, string>;
  /** True if this entry is a gettext #, fuzzy entry (ignored at runtime by Django/gettext) */
  fuzzy?: boolean;
  /** Optional gettext Plural-Forms metadata parsed from PO header */
  pluralForms?: { nplurals: number; pluralExpr?: string };
  /** Optional translator or extracted comment */
  comment?: string;
  /** Source file where this entry lives */
  file?: string;
  /** Line number if known */
  line?: number;
}

export interface LocaleFileData {
  locale: string;
  filePath: string;
  entries: Map<string, LocaleEntry>;
  /** Optional gettext Plural-Forms parsed from PO file header */
  pluralForms?: { nplurals: number; pluralExpr?: string };
  /** Optional list of unsupported constructs encountered in the file */
  unsupportedConstructs?: Array<{ key?: string; description: string }>;
}

export interface FormatWriteUpdate {
  key: string;
  value: string;
  plurals?: Record<string, string>;
}

export interface FormatAdapter {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly placeholderSyntaxes: readonly PlaceholderSyntax[];

  /** Read a locale file losslessly into a normalized key map. */
  readFile(filePath: string, locale: string): LocaleFileData;

  /**
   * Apply updates to an existing (or new) locale file losslessly,
   * preserving key order, indentation, comments, and formatting.
   * Returns the new file contents without mutating unless write=true.
   */
  applyUpdates(
    filePath: string,
    locale: string,
    updates: FormatWriteUpdate[],
    options?: { sourceFilePath?: string; write?: boolean }
  ): string;
}
