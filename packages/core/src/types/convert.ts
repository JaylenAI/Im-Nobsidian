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
  /**
   * 원시 Notion markdown export 가 압축형(펜스 밖 빈 줄 0)이었는지 — orchestrator 가
   * `notionEnhancedToObsidian` **이전**에 판정해 전달한다. enhanced 변환의
   * `<empty-block/>`→빈 줄 치환이 끝난 뒤에는 BlockSpacer 가 스스로 판정할 수 없다(D1).
   * true: 무조건 재간격 / false: 무동작 / 미지정: 내용 기반 휴리스틱 폴백.
   */
  readonly notionExportCompact?: boolean;
  readonly [key: string]: unknown;
}

export interface ConversionContext {
  readonly direction: "push" | "pull";
  readonly path: ConversionPath;
  readonly filePath: string;
  readonly parentMode?: "page" | "database";
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
