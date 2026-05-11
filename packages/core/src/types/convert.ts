export type ConversionPath = "markdown-api" | "block-api";

export interface ProcessorInput {
  readonly content: string;
  readonly metadata: ProcessorMetadata;
  readonly context: ConversionContext;
}

export interface ProcessorOutput {
  readonly content: string;
  readonly metadata: ProcessorMetadata;
}

export interface ProcessorMetadata {
  readonly properties?: Record<string, unknown>;
  readonly preserveMarkers?: PreserveMarker[];
  readonly images?: ImageReference[];
  readonly [key: string]: unknown;
}

export interface ConversionContext {
  readonly direction: "push" | "pull";
  readonly path: ConversionPath;
  readonly filePath: string;
}

export interface Processor {
  readonly name: string;
  readonly order: number;
  process(input: ProcessorInput): ProcessorOutput;
}

export interface ConversionResult {
  readonly content: string;
  readonly properties: Record<string, unknown>;
  readonly images: ImageReference[];
  readonly preserveMarkers: PreserveMarker[];
}

export interface PreserveMarker {
  readonly type: string;
  readonly params: Record<string, string>;
  readonly startIndex: number;
  readonly endIndex?: number;
}

export interface ImageReference {
  readonly url: string;
  readonly localPath?: string;
  readonly hash?: string;
  readonly isExternal: boolean;
}

export interface WikilinkEntry {
  readonly obsidianPath: string;
  readonly notionPageId: string;
  readonly title: string;
  readonly aliases: readonly string[];
}
