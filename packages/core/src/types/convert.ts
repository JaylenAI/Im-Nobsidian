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
  /**
   * pull 직전 로컬 노트 원문 — 있을 때만. Notion 에 남길 자리가 없는 표기(코드 펜스의 원래 언어 ·
   * 펜스 기호 S-20, 주석 S-29)를 되살리는 근거다. 호출측이 로컬 파일을 읽어 넘긴다.
   */
  readonly localContent?: string;
  /** Markdown API 로 보낼 수 없어 본문을 쓴 뒤 블록으로 채울 코드({@link DeferredCode}). */
  readonly deferredCode?: DeferredCode[];
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
  readonly deferredCode: DeferredCode[];
}

/**
 * 본문을 쓴 뒤 블록으로 채울 코드(S-22). Notion Markdown API 는 코드에 ``` 로 시작하는 줄이 있으면
 * 어떤 펜스로 보내도 그 줄에서 블록을 가른다 — 코드 자리에 자리표시(`token`)만 보내고, 페이지를
 * 쓴 뒤 그 자리표시를 가진 코드 블록의 글을 `code` 로 바꾼다.
 */
export interface DeferredCode {
  /** 코드 블록에 대신 보낸 자리표시 — 페이지 안에서 하나뿐이다. */
  readonly token: string;
  /** Obsidian 이 보여 주는 그대로의 코드 — 컨테이너 접두 · 펜스 들여쓰기를 뗀 것. */
  readonly code: string;
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
