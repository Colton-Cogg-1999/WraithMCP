export interface DocumentInlineTagMeta {
  id: string;
  kind: "x" | "g";
  type: string;
}

export type DocumentFormat = "markdown" | "mdx" | "docx" | "vtt" | "srt" | "pptx" | "xlsx";

export interface DocumentSegmentConstraints {
  maxChars?: number;
  maxLines?: number;
  maxCharsPerLine?: number;
  durationSec?: number;
}

export interface DocumentSegment {
  id: string;
  part: string;
  location: string;
  text: string;
  plainText: string;
  tags: DocumentInlineTagMeta[];
  constraints?: DocumentSegmentConstraints;
}

export interface ExtractedDocument {
  file: string;
  format: DocumentFormat;
  /** Whole document plain/tagged view so the coding agent always has document-level context */
  fullDocumentContext: string;
  segments: DocumentSegment[];
  stats: {
    segmentCount: number;
    wordCount: number;
    parts: string[];
    protectedTrackedChanges: number;
  };
}

export interface DocumentTranslationUpdate {
  id: string;
  text: string;
}

export interface DocumentApplyResult {
  ok: boolean;
  sourceFile: string;
  targetFile: string;
  segmentsTotal: number;
  segmentsUpdated: number;
  byteIdentical: boolean;
  errors: Array<{ id: string; code: string; message: string }>;
}

export interface DocumentAdapter {
  readonly format: DocumentFormat;
  readonly extensions: readonly string[];

  extract(filePath: string): ExtractedDocument;
  apply(
    sourcePath: string,
    targetPath: string,
    updates: DocumentTranslationUpdate[],
    options?: { targetLocale?: string }
  ): DocumentApplyResult;
}
