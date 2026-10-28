import { createHash } from "node:crypto";
import type { UploadedFile } from "../notion/property-mapper.js";
import { Sema } from "async-sema";
import type { VaultFS } from "./vault-fs.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { ImageReference } from "../types/convert.js";
import { MARKER_BRAND_RE, MARKER_PAYLOAD_CHAR } from "../constants/markers.js";
import { decodeMarkerTarget } from "../converter/marker-url.js";
import { getLogger } from "../utils/logger.js";
import { getBlockType, getMimeType, isHtmlBlockFile, isNotionUploadable } from "../utils/mime.js";
import { mapOutsideCodeFences } from "../utils/md-regions.js";
import {
  fileUrlOfBlock,
  isNotionHostedFileUrl,
  isNotionAttachmentUri,
  notionFileIdOf,
} from "../utils/notion-file-url.js";
import { fetchForDownload } from "../utils/download-fetch.js";
import { DEFAULT_CONFIG } from "../types/config.js";
import {
  recallUploadedMedia,
  rememberReceivedMedia,
  rememberUploadedMedia,
  type UploadedMedia,
} from "./uploaded-media.js";

/** 미디어(이미지/파일) 다운로드 운영 튜닝값. 미지정 시 기존 동작과 동일한 기본값 사용. */
export interface MediaOptions {
  readonly concurrency?: number;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly maxFileSizeBytes?: number;
  /** 다운로드 1회 시도의 시간 상한(ms). 기본 300초. 0 이하면 상한 없음(권장하지 않음). */
  readonly downloadTimeoutMs?: number;
}

export interface ImageDownloadResult {
  readonly originalUrl: string;
  readonly localPath: string;
  readonly hash: string;
  readonly size: number;
  /** 받은 파일의 전체 sha256 — 받은 미디어 기록에 적어 push 가 그 파일이 그대로인지 본다. */
  readonly fileHash?: string;
  /** 임베드 별칭으로 쓸 이름 — 받은 이름에서 이 볼트가 붙인 내용 해시를 뗀 것({@link withoutOwnHash}). */
  readonly name?: string;
}

/** 다운로드는 됐지만 아직 디스크에 쓰지 않은 이미지 — D6 dedup 판정 후 persist 한다. */
interface FetchedImage {
  readonly originalUrl: string;
  readonly localPath: string;
  readonly hash: string;
  /** 전체 sha256 — file_registry.fileHash 와 동일 산식의 비교 키. */
  readonly fullHash: string;
  readonly buffer: Buffer;
}

export interface ImageUploadResult {
  readonly localPath: string;
  readonly fileUploadId: string;
  /** 업로드한 이미지의 전체 sha256 — file_registry 비교 키(FileHandler 와 동일 산식). */
  readonly fileHash: string;
  readonly fileSize: number;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

/** 괄호 균형 스캔으로 찾은 마크다운 링크/임베드 한 건. */
export interface MarkdownLinkSpan {
  readonly full: string;
  readonly label: string;
  readonly url: string;
  readonly isEmbed: boolean;
}

/**
 * `![label](url)` / `[label](url)` 을 괄호 균형 스캔으로 추출한다.
 * Notion 캡션은 내부에 `[텍스트](url)` 링크를 허용하므로, `[^\]]*` 류 정규식은
 * 캡션 속 첫 `]` 에서 라벨을 끊고 캡션 내부 URL 을 이미지 URL 로 오인한다.
 */
export function scanMarkdownLinks(markdown: string): MarkdownLinkSpan[] {
  const spans: MarkdownLinkSpan[] = [];
  let i = 0;
  while (i < markdown.length) {
    const open = markdown.indexOf("[", i);
    if (open === -1) break;
    if (markdown[open - 1] === "\\") {
      i = open + 1;
      continue;
    }
    const isEmbed = markdown[open - 1] === "!" && markdown[open - 2] !== "\\";
    // 라벨: 대괄호 깊이 균형(이스케이프 스킵). 빈 줄을 만나면 링크가 아니다.
    let depth = 1;
    let j = open + 1;
    let broken = false;
    while (j < markdown.length && depth > 0) {
      const ch = markdown[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "\n" && markdown[j + 1] === "\n") {
        broken = true;
        break;
      }
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      j++;
    }
    if (broken || depth !== 0 || markdown[j] !== "(") {
      i = open + 1;
      continue;
    }
    const label = markdown.slice(open + 1, j - 1);
    let parenDepth = 1;
    let k = j + 1;
    while (k < markdown.length && parenDepth > 0) {
      const ch = markdown[k];
      if (ch === "\\") {
        k += 2;
        continue;
      }
      if (ch === "\n") {
        broken = true;
        break;
      }
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      k++;
    }
    if (broken || parenDepth !== 0) {
      i = open + 1;
      continue;
    }
    const start = isEmbed ? open - 1 : open;
    spans.push({
      full: markdown.slice(start, k),
      label,
      url: markdown.slice(j + 1, k - 1),
      isEmbed,
    });
    i = k;
  }
  return spans;
}

/** 라벨을 `![[경로|별칭]]` 별칭으로 안전하게 쓸 수 있는 평문으로 변환한다. */
export function toWikilinkAlias(label: string): string {
  return (
    label
      .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, d?: string) => d ?? t)
      .replace(/[\r\n]+/g, " ")
      // 캡션은 서식 없는 글이라 Notion 이 `*` 등을 `\*` 로 준다 — 별칭은 Obsidian 이 글자 그대로 쓴다(2026-10-23 실측).
      .replace(/\\([!-/:-@[-`{-~])/g, "$1")
      .replace(/\]\]/g, ")")
      .replace(/\|/g, "-")
      .trim()
  );
}

const INTERNAL_FILE_URL_RE = /^file:\/\/%7B.*%7D%7D$/;
const FILE_LABEL_PREFIX_RE = /^(?:📎|🎬|🎞|📄|🔊|🌐)\s*/u;

/**
 * 파일을 싣는 미디어 태그의 이름 — markdown API 가 파일 블록을 `<file|pdf|video|audio src="…">캡션</…>` 로 준다.
 * HTML 블록(파일을 붙인 embed)은 `<embed src="…">캡션</embed>` 로 온다 — 주소가 Notion 이 호스팅한 파일일 때만
 * 미디어로 본다(바깥 주소의 embed 는 링크다).
 */
const MEDIA_TAG_NAMES = "file|video|audio|pdf|embed";

/** 미디어 태그 `<이름 src="주소">캡션</이름>`. 주소 모양은 `src` 로 고른다. */
function mediaTagRe(src: string): RegExp {
  return new RegExp(
    `<(?:${MEDIA_TAG_NAMES})\\s+src="(${src})">([\\s\\S]*?)<\\/(?:${MEDIA_TAG_NAMES})>`,
    "g",
  );
}

const MEDIA_TAG_RE = mediaTagRe('[^"]+');

/** 미디어 태그의 이름 — 그대로 둘 미디어를 같은 종류의 태그로 다시 싣는다. */
const MEDIA_TAG_NAME_RE = new RegExp(`^<(${MEDIA_TAG_NAMES})\\s`);

/** 캡션 없는 미디어에 pull 변환이 붙이는 자리 이름(`[📎 file](…)`) — 사람이 적은 캡션이 아니다. */
const MEDIA_PLACEHOLDER_CAPTIONS = new Set(["file", "pdf", "video", "audio", "html"]);

/** Notion 이 붙여 넣은 이미지에 주는 자리 이름 — 이것으로 지으면 받은 이미지가 모두 `image-<해시>` 가 된다. */
const PLACEHOLDER_IMAGE_STEMS = new Set(["image", "untitled"]);

/** 별칭 끝의 `300` · `300x200` 은 크기다 — Obsidian 이 임베드의 너비(×높이)로 쓴다. */
const EMBED_SIZE_RE = /^\d+(?:x\d+)?$/;

/** 임베드 대상 `경로|설명|크기` 의 세 조각. 없는 조각은 빈 문자열이다. */
export interface EmbedTargetParts {
  readonly path: string;
  readonly description: string;
  readonly size: string;
}

/** 임베드 대상을 나눈다 — `a.png|설명|300` · `a.png|300` · `a.png|설명` · `a.png`. */
export function splitEmbedTarget(target: string): EmbedTargetParts {
  const [path = "", ...alias] = target.split("|");
  const last = alias[alias.length - 1]?.trim();
  if (last !== undefined && EMBED_SIZE_RE.test(last)) {
    return { path, description: alias.slice(0, -1).join("|").trim(), size: last };
  }
  return { path, description: alias.join("|").trim(), size: "" };
}

/**
 * push 가 미디어 블록에 다는 캡션 — 사람이 적은 설명만(S-05).
 *
 * 경로 · 크기 · 파일 이름은 Notion 에서 뜻이 없다. 경로는 볼트 안의 자리이고, 크기는 Obsidian
 * 이 그릴 너비이며, 파일 이름은 파일 블록이 이미 보여 준다. 어느 임베드였는지는 캡션 대신
 * 올린 파일의 id 로 적어 둔다({@link rememberUploadedMedia}).
 */
export function captionOfEmbed(target: string): string {
  return splitEmbedTarget(target).description;
}

/**
 * pull 이 받은 캡션으로 되살릴 임베드 대상(S-05).
 *
 * - 캡션이 그대로다(push 가 단 설명 · 옛 push 가 단 대상 전체) → 적어 둔 대상 그대로
 * - 파일 이름만 보인다 → 그대로. 파일 블록은 캡션 대신 이름을 보여 줄 수 있어, 설명을 지운
 *   것인지 가를 수 없다 — 지우지 않는 쪽을 고른다
 * - 캡션이 없고 별칭이 올라간 이름이다 → 그대로. 캡션 없는 파일을 받으면 올라간 이름을 별칭으로
 *   적는다({@link fileNameOf}) — 다시 받을 때 그 별칭을 지우면 임베드가 바뀐다
 * - 캡션을 비웠다 → 경로(+ 크기)
 * - 캡션을 고쳤다 → 경로|새 설명. 크기는 원래 설명과 함께 적혀 있었을 때만 잇는다 — 크기만
 *   있던 임베드에 설명을 붙이는 모양(`a.png|설명|300`)은 사용자가 쓴 적이 없는 모양이다
 *
 * @param caption 라벨에서 표시 이모지 · 이스케이프를 뗀 캡션
 */
export function embedTargetFromCaption(
  target: string,
  caption: string,
  uploadedName: string,
): string {
  const { path, description, size } = splitEmbedTarget(target);
  if (caption === description || caption === target || caption === uploadedName) return target;
  if (!caption && uploadedName && description === toWikilinkAlias(uploadedName)) return target;
  const sized = (base: string): string => (size ? `${base}|${size}` : base);
  const alias = toWikilinkAlias(caption);
  if (!alias) return sized(path);
  return description ? sized(`${path}|${alias}`) : `${path}|${alias}`;
}

/** 받은 본문의 미디어 라벨을 캡션 평문으로 — 앞의 표시 이모지와 NFM 이스케이프(`\|`)를 뗀다. */
function captionOfLabel(label: string): string {
  const caption = label.replace(FILE_LABEL_PREFIX_RE, "").replace(/\\(.)/g, "$1").trim();
  return FILE_LABEL_PREFIX_RE.test(label) && MEDIA_PLACEHOLDER_CAPTIONS.has(caption) ? "" : caption;
}

/**
 * 받은 파일의 이름 — 사람이 단 캡션, 없으면 Notion 에 올라간 파일 이름.
 *
 * 캡션 없는 파일 블록은 markdown API 가 서명 URL 만 주고(`<file src="…"></file>`) pull 변환이 자리 이름을
 * 붙인다(`[📎 file](…)`). 자리 이름으로 받으면 `file-<해시>` 로 저장하고 별칭이 `file` 이 된다 — 같은
 * 파일을 올라간 이름으로 받아 둔 볼트는 다시 받을 때 같은 바이트의 사본이 생기고 임베드가 바뀐다(실볼트
 * 사본, 2026-10-05). 올라간 이름은 서명 URL 의 경로 끝에만 있다. URL 에도 이름이 없으면 예전처럼 자리
 * 이름으로 받는다.
 *
 * 올라간 이름은 다듬지 않고 저장 이름으로 넘긴다 — 내부 참조(`attachment:<id>:<이름>`)로 받던 파일도
 * 이름 그대로 저장했다. 같은 파일이 어느 모양으로 와도 같은 자리에 받아야 사본이 생기지 않는다. 별칭은
 * {@link fileEmbedOf} 가 다듬는다.
 *
 * @param caption 라벨에서 표시 이모지를 뗀 캡션 · 태그 안의 글. 사람이 자리 이름과 같은 캡션을 달았으면
 *   가를 수 없다 — 이름으로 받는다.
 */
function fileNameOf(caption: string, url: string): string {
  return savedNameOf(caption, uploadedFileNameFromUrl(url));
}

/**
 * 받은 파일의 이름을 고르는 규칙 하나 — 서명 URL 로 오든 내부 참조(`attachment:<id>:<이름>`)로 오든 같다.
 * 예전에는 내부 참조 갈래만 올라간 이름을 캡션보다 앞세워, 같은 블록이 다른 모양으로 오면 다른 이름으로
 * 받아 사본이 생기고 임베드 별칭이 바뀌었다(B11).
 *
 * @param uploadedName Notion 에 올라간 파일 이름 — 모르면 빈 문자열.
 */
function savedNameOf(caption: string, uploadedName: string): string {
  const alias = toWikilinkAlias(caption);
  if (alias && !MEDIA_PLACEHOLDER_CAPTIONS.has(alias)) return alias;
  return uploadedName || alias || "file";
}

/**
 * 받은 파일의 임베드. 별칭은 이름을 별칭으로 쓸 수 있게 다듬은 것이다 — 이름의 `]]` · `|`
 * (`초안]]최종.pdf`)가 임베드를 끝내거나 나누지 않는다. 남는 글자가 없으면 자리 이름 `file`.
 */
function fileEmbedOf(localPath: string, name: string): string {
  return `![[${fileEmbedTargetOf(localPath, name)}]]`;
}

/** {@link fileEmbedOf} 의 임베드 대상 — `경로|별칭`. */
function fileEmbedTargetOf(localPath: string, name: string): string {
  return `${localPath}|${toWikilinkAlias(name) || "file"}`;
}

/**
 * 받은 미디어 한 건을 받은 미디어 기록의 한 줄로 — Notion 의 그 파일과 노트에 쓴 임베드를 잇는다.
 * 파일 id 를 읽지 못하거나 지문이 없으면 null(적지 않는다 — 그 노트를 push 하면 예전처럼 올린다).
 */
function receivedMediaOf(
  url: string,
  download: ImageDownloadResult,
  target: string,
): UploadedMedia | null {
  const fileId = notionFileIdOf(url) ?? notionFileIdOf(download.originalUrl);
  if (!fileId || !download.fileHash) return null;
  return { fileId, target, localPath: download.localPath, fileHash: download.fileHash };
}

/** Notion 이 호스팅한 미디어 URL — 서명 URL 이거나 markdown API 의 내부 참조(`file://`). */
function isNotionMediaUrl(url: string): boolean {
  return (/^https?:\/\//.test(url) && isNotionHostedFileUrl(url)) || INTERNAL_FILE_URL_RE.test(url);
}

/** 받은 본문의 Notion 미디어 한 건 — 이미지 임베드 · 파일 링크 · 미디어 태그. */
interface NotionMediaSpan {
  readonly full: string;
  /** 캡션(파일 블록이면 이름일 수도 있다). 표시 이모지 · 이스케이프가 붙어 있을 수 있다. */
  readonly label: string;
  readonly url: string;
}

/**
 * 받은 본문에서 Notion 이 호스팅한 미디어를 모두 찾는다 — 이미지 `![캡션](url)`, 파일
 * `[📎 캡션](url)`(pull 변환 뒤의 모양), 태그 `<file|pdf|video|audio src="url">캡션</…>`.
 */
function notionMediaSpans(markdown: string): NotionMediaSpan[] {
  const spans: NotionMediaSpan[] = [];
  for (const link of scanMarkdownLinks(markdown)) {
    if (!link.isEmbed && !FILE_LABEL_PREFIX_RE.test(link.label)) continue;
    if (isNotionMediaUrl(link.url)) spans.push(link);
  }
  for (const tag of markdown.matchAll(MEDIA_TAG_RE)) {
    const url = tag[1]!;
    if (isNotionMediaUrl(url)) spans.push({ full: tag[0], label: tag[2] ?? "", url });
  }
  return spans;
}

// 경로에 공백이 있을 수 있어(`![[내 사진.png]]`) 닫는 `%%` 까지 비탐욕으로 받는다.
// 경로는 push 가 퍼센트 인코딩해 실으므로 읽는 쪽은 반드시 `decodeMarkerTarget` 을 거친다.
// 인코딩 이전에 올라간 구버전 마커는 원문 `%` 를 품고 있어 payload 를 넓게 받는다.
const LOCAL_MARKER_RE = new RegExp(
  `${MARKER_BRAND_RE}:local-(?:image|file):(${MARKER_PAYLOAD_CHAR}+?)\\s*%%`,
  "g",
);

/** 자리표시자 블록 안의 마커 — 종류(image/file)와 원본 임베드 대상을 함께 뽑는다(R1). */
const PLACEHOLDER_MARKER_RE = new RegExp(
  `${MARKER_BRAND_RE}:local-(image|file):(${MARKER_PAYLOAD_CHAR}+?)\\s*%%`,
  "u",
);

/** 미디어 자리표시자를 실제 블록으로 바꾸기 위해 찾아 둔 위치 한 건. */
interface PlaceholderHit {
  /** 자리표시자가 들어 있는 부모 블록(페이지 또는 콜아웃/토글 등 컨테이너). */
  readonly parentId: string;
  /** 자리표시자 블록 자신 — 실제 블록을 그 뒤에 넣고 지운다. */
  readonly blockId: string;
  readonly kind: "image" | "file";
  /** `![[...]]` 안에 있던 원본 대상 문자열. `경로|별칭` 형태일 수 있다. */
  readonly target: string;
  /** 자리표시자 아래에 다른 블록이 묶였는가 — Notion 이 깊이 들여쓴 뒷줄을 자식으로 묶는다(S-33). */
  readonly hasChildren: boolean;
}

/**
 * 본문의 자리표시자 한 줄 — 앞 들여쓰기 · 종류 · 퍼센트 인코딩된 대상. push 는 자리표시자를 줄 단독으로
 * 심는다(`EmbedResolver` 의 `isolate`) — 콜아웃 안이면 탭, 목록 안이면 공백으로 들인다.
 */
const PLACEHOLDER_LINE_RE = new RegExp(
  `^([ \\t]*)>[ \\t]*📎[^\\n]*?%%\\s*${MARKER_BRAND_RE}:local-(image|file):(${MARKER_PAYLOAD_CHAR}+?)\\s*%%[ \\t]*$`,
  "gmu",
);

/**
 * 그대로 실을 수 있는 캡션 — markdown 서식 · 태그로 읽힐 글자가 없다. 올릴 때는 캡션을 글자 그대로
 * 싣는데({@link mediaBlock}) 본문 markdown 에 실으면 Notion 이 서식으로 읽는다. 이런 캡션의 미디어는
 * 예전처럼 다시 올린다.
 */
const PLAIN_CAPTION_RE = /^[^\\[\]()<>&*_`~$=#|\n\r]*$/u;

/** 본문 markdown 에 그대로 실을 수 있는 파일 URL — 괄호 · 따옴표 · 꺾쇠 · 공백이 없다. */
const PLAIN_URL_RE = /^https:\/\/[^\s()<>"']+$/;

/** {@link ImageHandler.keepUploadedMedia} 의 결과. */
export interface KeptMedia {
  /** 보낼 본문 — 다시 올리지 않아도 되는 자리표시자를 Notion 의 그 파일로 바꿨다. */
  readonly markdown: string;
  /** 그대로 둔 미디어 — 본문을 보낸 뒤 올린 미디어 기록에 다시 적는다. */
  readonly kept: readonly UploadedMedia[];
}

/** 제자리 교체 결과 — 어떤 임베드 대상이 처리됐는지 호출자가 알아야 중복 업로드를 막는다. */
export interface MaterializeResult {
  readonly uploaded: ImageUploadResult[];
  /** 실제 블록으로 바뀐 임베드 대상(원본 문자열 + 별칭 제거형 둘 다 담는다). */
  readonly handledTargets: Set<string>;
  /**
   * 자리표시자를 찾아 본문을 고치려 했다 — 도중에 실패했어도 페이지가 바뀌었을 수 있다. 호출측은
   * 보낸 본문으로 만든 지문을 버리고 다시 받는다.
   */
  readonly touched: boolean;
}

/** 별칭(`경로|300`)을 떼고 실제 볼트 경로만 남긴다. */
function stripAlias(target: string): string {
  return target.split("|")[0]!;
}

/** 서명 URL 경로 끝의 업로드 파일명. 캡션이 우리가 적은 것인지 대조하는 데 쓴다. */
/**
 * 받은 이미지 파일 이름의 앞부분 — 올라간 파일 이름(`pic.png` → `pic`). 그 이름이 없거나 Notion 의 자리 이름이면
 * 노트 제목이다. 뒤에 내용 해시를 붙이므로 같은 이름의 다른 이미지와 겹치지 않는다.
 */
/** 받은 첨부 이름에 붙이는 내용 해시(sha256 16진)의 길이 — `이름-<해시>.확장자`. */
const NAME_HASH_LENGTH = 12;

/** 받은 첨부 이름에 붙이는 내용 해시 — 전체 sha256 의 앞부분. */
function nameHashOf(fullHash: string): string {
  return fullHash.slice(0, NAME_HASH_LENGTH);
}

/** 이미지 파일 이름에서 제목 몫의 최대 글자 수 — 뒤에 내용 해시와 확장자가 붙어도 파일 이름 한도 안에 든다. */
const IMAGE_STEM_MAX = 50;

/**
 * 받은 이름에서 이 볼트가 붙인 꼬리표(`-<내용 해시 12자>` 와 그 뒤 확장자)를 뗀다.
 *
 * 받은 파일은 `이름-<해시>.확장자` 로 저장하고, push 는 그 파일 이름 그대로 올린다. 다른 볼트로 다시 받으면 올라간
 * 이름 뒤에 같은 해시가 또 붙어(`이름-<해시>-<해시>.png`) 받을 때마다 이름이 길어졌다(2026-10-23 전체 E2E 첨부 41개).
 * 해시는 받은 내용의 것과 같을 때만 뗀다 — 사람이 지은 이름은 그대로다.
 */
export function withoutOwnHash(name: string, hash: string): string {
  if (hash.length !== NAME_HASH_LENGTH || !/^[0-9a-f]+$/.test(hash)) return name;
  const stripped = name.replace(new RegExp(`-${hash}(\\.[^./]*)?$`), "");
  return stripped === "" ? name : stripped;
}

function imageStemOf(uploadedName: string, pageTitle: string): string {
  const stem = safeImageStem(uploadedName.replace(/\.[^.]*$/, ""));
  return stem && !PLACEHOLDER_IMAGE_STEMS.has(stem.toLowerCase()) ? stem : safeImageStem(pageTitle);
}

function safeImageStem(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, IMAGE_STEM_MAX);
}

function uploadedFileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

/** 하위 탐색에서 제외할 블록 — 별도 페이지이거나 자식이 다른 곳에 사는 것들. */
const NON_DESCENDABLE_TYPES = new Set(["child_page", "child_database", "synced_block", "table"]);

/** pull 원문(이스케이프 포함 가능)에서 제자리 보존 마커의 대상 파일명 집합을 뽑는다(D6). */
function collectLocalMarkerBasenames(markdown: string): Set<string> {
  const names = new Set<string>();
  const unescaped = markdown.replace(/\\/g, "");
  for (const m of unescaped.matchAll(LOCAL_MARKER_RE)) {
    names.add(baseName(decodeMarkerTarget(m[1]!)));
  }
  return names;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** 노트 경로에서 그 노트가 사는 폴더만 뽑는다(루트 노트면 undefined). */
function folderOf(notePath?: string): string | undefined {
  return notePath?.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : undefined;
}

/** 로그에 남길 실패 사유 — 오류 객체를 통째로 넘기면 응답 헤더까지 쏟아져 사유가 묻힌다. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 자리표시자 자리에 넣을 미디어 블록. 캡션은 사람이 적은 설명만({@link captionOfEmbed}) —
 * 설명이 없으면 비운다. 파일 블록은 이름으로 파일 이름을 보여 준다.
 *
 * 파일은 확장자로 블록 종류를 고른다({@link getBlockType}) — PDF · 동영상 · 소리를 일반 파일 블록으로 올리면
 * Notion 에서 미리보기 · 재생이 안 됐다(B12). PDF · 동영상 · 소리 블록은 `name` 을 거절한다(실측 2026-10-21:
 * `pdf.name should be not present`).
 */
function mediaBlock(
  kind: PlaceholderHit["kind"],
  fileUploadId: string,
  vaultTarget: string,
  target: string,
): Record<string, unknown> {
  const description = captionOfEmbed(target);
  const caption = description ? [{ type: "text", text: { content: description } }] : [];
  const file = { type: "file_upload", file_upload: { id: fileUploadId }, caption };
  if (kind !== "image" && isHtmlBlockFile(vaultTarget)) return { type: "embed", embed: file };
  const type = kind === "image" ? "image" : getBlockType(baseName(vaultTarget));
  return type === "file"
    ? { type, file: { ...file, name: baseName(vaultTarget) } }
    : { type, [type]: file };
}

/**
 * push 가 심은 자리표시자라면 그 마커를 돌려준다.
 *
 * 자리표시자는 quote 한 줄로만 심는다(`EmbedResolver`). 코드 블록 · 문단의 같은 모양 글은 형식을
 * 설명하는 사용자의 글이다 — 예전에는 블록 종류를 가리지 않아, 그 블록을 미디어로 바꾸고 지웠다(S-18).
 */
function placeholderMarkerOf(
  block: { readonly type: string } & Record<string, unknown>,
): RegExpExecArray | null {
  if (block.type !== "quote") return null;
  const body = block.quote as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  const text = (body?.rich_text ?? []).map((r) => r.plain_text ?? "").join("");
  return PLACEHOLDER_MARKER_RE.exec(text);
}

export class ImageHandler {
  private readonly customFetch?: typeof globalThis.fetch;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxFileSizeBytes: number;
  private readonly downloadTimeoutMs: number;

  constructor(
    private readonly vaultFs: VaultFS,
    private readonly attachmentFolder: string = DEFAULT_CONFIG.paths.attachments,
    private readonly notionClient?: NotionClient,
    customFetch?: typeof globalThis.fetch,
    options?: MediaOptions,
    private readonly stateDb?: IStateDB,
  ) {
    this.customFetch = customFetch;
    const defaults = DEFAULT_CONFIG.advanced;
    this.concurrency = options?.concurrency ?? defaults.mediaConcurrency;
    // 미디어의 maxRetries 는 «시도 횟수» 다(NotionClient 의 maxRetries 는 첫 시도 뒤 재시도 수). 설정은 0 을
    // 받는데, 예전에는 0 이면 시도를 한 번도 하지 않고 null 을 던졌다 — 적어도 한 번은 받는다.
    this.maxRetries = Math.max(1, options?.maxRetries ?? defaults.mediaMaxRetries);
    this.retryBaseMs = options?.retryBaseMs ?? defaults.mediaRetryBaseMs;
    this.maxFileSizeBytes = options?.maxFileSizeBytes ?? defaults.maxFileSizeBytes;
    this.downloadTimeoutMs = options?.downloadTimeoutMs ?? defaults.mediaDownloadTimeoutMs;
  }

  private get fetchFn(): typeof globalThis.fetch {
    return this.customFetch ?? globalThis.fetch;
  }

  /** 상한 로직은 첨부 경로와 공유한다 — 한쪽만 빠뜨리지 않도록(utils/download-fetch). */
  private fetchForDownload(url: string): ReturnType<typeof globalThis.fetch> {
    return fetchForDownload(this.fetchFn, url, this.downloadTimeoutMs);
  }

  async downloadImage(url: string, pageTitle: string): Promise<ImageDownloadResult> {
    return this.persistImage(await this.fetchImage(url, pageTitle, uploadedFileNameFromUrl(url)));
  }

  /** @param uploadedName Notion 에 올라간 파일 이름 — 받은 파일의 이름이 된다({@link imageStemOf}). */
  private async fetchImage(
    url: string,
    pageTitle: string,
    uploadedName: string,
  ): Promise<FetchedImage> {
    const maxRetries = this.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, this.retryBaseMs * attempt));
          getLogger().info(
            `[Im-Nobsidian] 이미지 다운로드 재시도 (${attempt + 1}/${maxRetries}): ${pageTitle}`,
          );
        }
        const response = await this.fetchForDownload(url);
        if (!response.ok) {
          throw new Error(`이미지 다운로드 실패: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") ?? "image/png";
        const extension = IMAGE_EXTENSIONS[contentType] ?? this.guessExtension(url) ?? ".png";

        const buffer = Buffer.from(await response.arrayBuffer());
        const fullHash = createHash("sha256").update(buffer).digest("hex");
        const hash = nameHashOf(fullHash);
        const fileName = `${imageStemOf(withoutOwnHash(uploadedName, hash), pageTitle)}-${hash}${extension}`;
        const localPath = `${this.attachmentFolder}/${fileName}`;

        return { originalUrl: url, localPath, hash, fullHash, buffer };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError!;
  }

  /**
   * 캡션이 push 가 적어 둔 원본 임베드 대상인지 판정한다(R1). 맞으면 그 문자열을
   * 그대로 돌려주고, 호출자는 사본을 내려받는 대신 `![[원본]]` 으로 되살린다.
   *
   * 사용자가 Notion 에서 손으로 쓴 캡션을 경로로 오인하면 깨진 위키링크가 되므로,
   * ① 파일명이 실제 업로드된 파일명과 같고 ② 볼트에 그 파일이 실재할 때만 인정한다.
   * 둘 중 하나라도 어긋나면 null 을 돌려 기존 다운로드 경로로 떨어진다.
   *
   * ②의 실재 확인은 push 와 **같은 후보 사다리**(노트 폴더 → 루트 → attachments/)를
   * 쓴다 — 위키링크는 파일명만 적는 게 관례라 볼트 루트만 보면 노트 옆 파일을 놓친다.
   */
  private async resolveOriginalTarget(
    label: string,
    uploadedName: string,
    noteFolder?: string,
  ): Promise<string | null> {
    if (!label || !uploadedName) return null;
    // NFM 은 캡션의 `|` 를 `\|` 로 이스케이프해서 돌려준다.
    const target = captionOfLabel(label);
    if (!target || /^https?:\/\//.test(target) || target.includes("\n")) return null;
    const vaultPath = stripAlias(target);
    if (baseName(vaultPath) !== uploadedName) return null;
    for (const candidate of this.vaultCandidates(vaultPath, noteFolder)) {
      try {
        if (await this.vaultFs.exists(candidate)) return target;
      } catch {
        // 후보 하나가 터져도 나머지는 계속 본다.
      }
    }
    return null;
  }

  private async persistImage(fetched: FetchedImage): Promise<ImageDownloadResult> {
    await this.vaultFs.ensureFolder(this.attachmentFolder);
    await this.vaultFs.writeBinary(fetched.localPath, fetched.buffer);
    return {
      originalUrl: fetched.originalUrl,
      localPath: fetched.localPath,
      hash: fetched.hash,
      size: fetched.buffer.length,
      fileHash: fetched.fullHash,
    };
  }

  /**
   * push 가 올린 미디어를 노트에 적혀 있던 임베드로 되돌린다 — 아무것도 내려받지 않는다(S-05).
   *
   * push 는 임베드 하나를 제자리 블록 하나로 올리고, Notion 이 그 파일을 저장한 id 를 임베드
   * 대상과 함께 적어 둔다({@link rememberUploadedMedia}). 여기서는 받은 본문의 미디어 URL 에서
   * 그 id 를 읽어 대상을 되찾는다. 캡션에 경로를 적지 않아도 되고, Notion 에서 같은 이름의 다른
   * 파일로 바꾼 것(id 가 다르다)을 옛 로컬 파일로 되돌리지도 않는다.
   *
   * 적어 둔 것이 없으면 옛 push 처럼 캡션이 임베드 대상인지 본다(R1). 둘 다 아니면 그대로 두고,
   * 뒤따르는 {@link downloadAllImages} · {@link downloadAllFiles} 가 사본을 받는다.
   *
   * 내려받지 않으므로 표시 전용 렌더(diff)나 이미지 다운로드를 끈 설정에서도 부른다.
   *
   * @param pageId 본문을 받은 페이지 — 그 페이지에 올린 것만 되찾는다
   * @param notePath 노트 경로 — 옛 캡션의 파일을 push 와 같은 사다리로 찾는다
   */
  async restoreUploadedMedia(
    markdown: string,
    pageId?: string,
    notePath?: string,
  ): Promise<string> {
    const spans = notionMediaSpans(markdown);
    if (spans.length === 0) return markdown;

    const known = pageId ? recallUploadedMedia(this.stateDb, pageId) : new Map();
    const noteFolder = folderOf(notePath);
    let result = markdown;
    for (const span of spans) {
      const uploadedName = this.uploadedNameOf(span.url);
      const target =
        (await this.knownEmbedTarget(known, span, uploadedName)) ??
        (await this.resolveOriginalTarget(span.label, uploadedName, noteFolder));
      // 대상에 `$` 가 있어도(`가격$1.png`) 치환 패턴으로 읽지 않도록 함수로 넘긴다.
      if (target) result = result.replace(span.full, () => `![[${target}]]`);
    }
    return result;
  }

  /** 적어 둔 업로드면 되살릴 임베드 대상. 볼트에서 그 파일이 사라졌으면 null — 사본을 받는다. */
  private async knownEmbedTarget(
    known: ReadonlyMap<string, UploadedMedia>,
    span: NotionMediaSpan,
    uploadedName: string,
  ): Promise<string | null> {
    const fileId = notionFileIdOf(span.url);
    const media = fileId ? known.get(fileId) : undefined;
    if (!media) return null;
    try {
      if (!(await this.vaultFs.exists(media.localPath))) return null;
    } catch {
      return null;
    }
    return embedTargetFromCaption(media.target, captionOfLabel(span.label), uploadedName);
  }

  /** 미디어 URL 이 가리키는 파일 이름 — 서명 URL 은 경로 끝, 내부 참조는 `attachment:` 뒤. */
  private uploadedNameOf(url: string): string {
    return INTERNAL_FILE_URL_RE.test(url)
      ? (this.parseNotionFileUrl(url)?.fileName ?? "")
      : uploadedFileNameFromUrl(url);
  }

  async downloadAllImages(
    markdown: string,
    pageTitle: string,
    pageId?: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    // F14: 캡션에 중첩 링크가 있으면 정규식이 URL 을 오인하므로 괄호 균형 스캔을 쓴다.
    const embeds = scanMarkdownLinks(markdown).filter((s) => s.isEmbed);
    const notionMatches = embeds.filter(
      (s) => /^https?:\/\//.test(s.url) && this.isNotionImageUrl(s.url),
    );
    const internalMatches = embeds.filter((s) => INTERNAL_FILE_URL_RE.test(s.url));

    // attachment:{id}:{filename} — 통합이 접근할 수 없는 파일의 불투명 참조(실측: 어떤
    // 공개 API 로도 해소 불가). 다운로드하지 않고 원문을 보존하되, 사용자가 원인을 알 수
    // 있게 경고만 남긴다.
    for (const span of embeds) {
      if (isNotionAttachmentUri(span.url)) {
        getLogger().warn(
          `[Im-Nobsidian] 접근 불가 첨부(attachment:) 감지 — Notion 통합에 공유되지 않은 ` +
            `원본의 파일이라 다운로드할 수 없습니다. 원문을 보존합니다: ${pageTitle}`,
        );
      }
    }

    if (notionMatches.length === 0 && internalMatches.length === 0) {
      return { content: markdown, downloads: [] };
    }

    // D6: push 는 본문 임베드 이미지를 quote+마커 쌍(제자리) + 페이지 끝 이미지 블록
    // (append)의 이중 표현으로 올린다. pull 에서 그 끝 블록을 그대로 받으면 노트 꼬리에
    // 중복 `![[attachments/...]]` 가 유입되므로, file_registry 해시(전체 sha256)와
    // 본문 마커의 파일명이 모두 일치하는 다운로드는 사본으로 판정해 라인째 버린다.
    const registryByHash = new Map<string, string[]>();
    if (pageId && this.stateDb) {
      for (const entry of this.stateDb.getFilesByPageId(pageId)) {
        const list = registryByHash.get(entry.fileHash) ?? [];
        list.push(entry.localPath);
        registryByHash.set(entry.fileHash, list);
      }
    }
    const markerBasenames = collectLocalMarkerBasenames(markdown);
    const isAppendedCopy = (fetched: FetchedImage): boolean => {
      const paths = registryByHash.get(fetched.fullHash);
      return paths !== undefined && paths.some((p) => markerBasenames.has(baseName(p)));
    };

    const sema = new Sema(this.concurrency);
    const downloads: ImageDownloadResult[] = [];
    const received: Array<UploadedMedia | null> = [];
    let result = markdown;

    const httpResults = await Promise.allSettled(
      notionMatches.map(async (span) => {
        await sema.acquire();
        try {
          return {
            span,
            fetched: await this.fetchImage(span.url, pageTitle, this.uploadedNameOf(span.url)),
          };
        } finally {
          sema.release();
        }
      }),
    );

    for (const settled of httpResults) {
      if (settled.status !== "fulfilled") continue;
      const { span, fetched } = settled.value;
      if (isAppendedCopy(fetched)) {
        result = result.replace(span.full, "");
        continue;
      }
      const download = await this.persistImage(fetched);
      downloads.push(download);
      const alias = toWikilinkAlias(span.label);
      const target = `${download.localPath}${alias ? `|${alias}` : ""}`;
      // 캡션에 `$` 가 있어도(`가격 $& 표`) 치환 패턴으로 읽지 않도록 함수로 넘긴다 — 원래 링크(서명
      // URL)가 별칭에 들어간다.
      result = result.replace(span.full, () => `![[${target}]]`);
      received.push(receivedMediaOf(span.url, download, target));
    }

    for (const span of internalMatches) {
      await sema.acquire();
      try {
        const parsed = this.parseNotionFileUrl(span.url);
        if (!parsed || !this.notionClient) continue;

        const realUrl = await this.notionClient.getFileBlockUrl(parsed.blockId);
        if (!realUrl) {
          getLogger().warn(`[Im-Nobsidian] 이미지 Block URL 조회 실패: ${parsed.fileName}`);
          continue;
        }

        const fetched = await this.fetchImage(realUrl, pageTitle, parsed.fileName);
        if (isAppendedCopy(fetched)) {
          result = result.replace(span.full, "");
          continue;
        }
        const download = await this.persistImage(fetched);
        downloads.push(download);
        const alias = toWikilinkAlias(span.label);
        const target = `${download.localPath}${alias ? `|${alias}` : ""}`;
        result = result.replace(span.full, () => `![[${target}]]`);
        received.push(receivedMediaOf(realUrl, download, target));
      } catch (error) {
        getLogger().warn(`내부 이미지 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    this.rememberReceived(pageId, received);
    return { content: result, downloads };
  }

  async uploadLocalImage(localPath: string, noteFolder?: string): Promise<ImageUploadResult> {
    if (!this.notionClient) {
      throw new Error("NotionClient required for image upload");
    }

    const { buffer, resolvedPath } = await this.readImageFromVault(localPath, noteFolder);
    const filename = localPath.split("/").pop() ?? "image.png";
    const contentType = getMimeType(filename);
    const blob = new Blob([buffer], { type: contentType });
    const fileUploadId = await this.notionClient.uploadFile(blob, filename, contentType);
    // FileHandler.pushAllFiles 의 dedup 비교(전체 sha256)와 동일 산식으로 계산해 두 경로가
    // 같은 첨부를 동일 키로 인식하게 한다. localPath 도 해석된 실제 볼트 경로로 돌려줘야
    // 레지스트리 키가 폴더 스캔(pushAllFiles)의 file.path 와 일치해 중복 업로드가 차단된다.
    const fileHash = createHash("sha256").update(buffer).digest("hex");

    return { localPath: resolvedPath, fileUploadId, fileHash, fileSize: buffer.length };
  }

  /**
   * 노트가 가리키는 볼트 첨부 하나를 올린다 — 파일 속성 값으로 보낼 것.
   *
   * @returns 보일 이름은 받을 때 붙인 내용 해시를 뗀 것이다 — 다시 받으면 같은 이름 · 같은 경로가 된다.
   */
  async uploadNoteAttachment(target: string, notePath: string): Promise<UploadedFile> {
    const uploaded = await this.uploadLocalImage(target, folderOf(notePath));
    const base = uploaded.localPath.split("/").pop() ?? uploaded.localPath;
    const name = withoutOwnHash(base, nameHashOf(uploaded.fileHash));
    // 이미지는 확장자 없는 줄기에 해시를 붙여 받는다(`도식-<해시>.png`) — 뗀 이름에 확장자를 돌려준다.
    const extension = /\.[^./]+$/.exec(base)?.[0] ?? "";
    return {
      fileUploadId: uploaded.fileUploadId,
      name: name !== base && !/\.[^./]+$/.test(name) ? `${name}${extension}` : name,
    };
  }

  async uploadAndAppendImages(
    pageId: string,
    images: ImageReference[],
    notePath?: string,
  ): Promise<ImageUploadResult[]> {
    if (!this.notionClient) return [];

    const localImages = images.filter((img) => !img.isExternal && img.localPath);
    if (localImages.length === 0) return [];

    const noteFolder = folderOf(notePath);
    const results: ImageUploadResult[] = [];
    const imageBlocks: unknown[] = [];

    for (const img of localImages) {
      try {
        const result = await this.uploadLocalImage(img.localPath!, noteFolder);
        results.push(result);
        imageBlocks.push({
          type: "image",
          image: {
            type: "file_upload",
            file_upload: { id: result.fileUploadId },
          },
        });
      } catch (error) {
        // 경로 미해석(ENOENT)은 예상 가능한 상황(폴더 스캔 업로드가 후속 처리) —
        // 스택트레이스 대신 한 줄 경고로 낮춘다(F23). 그 외 오류는 사유를 남긴다.
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          getLogger().warn(`이미지 업로드 건너뜀 — 볼트에서 파일을 찾지 못함: ${img.localPath}`);
        } else {
          getLogger().warn(`이미지 업로드 실패 (${img.localPath}): ${messageOf(error)}`);
        }
      }
    }

    if (imageBlocks.length > 0) {
      // 자리표시자가 없어 제자리 교체가 불가능한 잔여분만 여기로 온다(R1 이후). 페이지 끝에
      // 붙이는 폴백이며, 정상 경로는 materializeLocalMedia 가 본문 자리에서 처리한다. 바뀌지
      // 않은 미디어는 keepUploadedMedia 가 본문에 Notion 의 그 파일로 실어 여기까지 오지 않는다.
      await this.notionClient.appendChildren(pageId, imageBlocks);
      this.registerUploads(pageId, results);
    }

    return results;
  }

  /**
   * 본문을 보내기 전에, 다시 올리지 않아도 되는 미디어 자리표시자를 Notion 에 이미 있는 그 파일로
   * 바꾼다.
   *
   * 본문 push 는 자리표시자를 심어 본문을 통째로 바꾸고, 바꾼 뒤 자리표시자를 하나씩 올려 블록으로
   * 바꾼다({@link materializeLocalMedia}). 그래서 글 한 줄만 고쳐도 그 페이지의 미디어를 모두 다시
   * 올렸다 — 업로드 요청이 미디어마다 셋이고, Notion 의 블록 · 파일이 새로 바뀌었다. 받은 본문의 미디어
   * URL 을 그대로 실어 본문을 바꾸면 Notion 은 그 블록을 그대로 둔다 — 블록 id · 파일이 같고 캡션만
   * 실은 글로 바뀐다. 자리를 옮겨도, 서명(쿼리)을 떼도 같다(2026-10-12 실측).
   *
   * 둘 다 맞는 자리표시자만 바꾼다 — 나머지는 예전처럼 올린다.
   * - 그 페이지의 미디어 기록에 같은 경로의 임베드가 있고, 받은 본문에 그 파일이 지금 있다
   * - 볼트의 그 파일이 적어 둔 지문과 같다 — 같은 이름에 다른 내용이면 올려야 한다
   *
   * 기록이 없거나(이 기능 이전에 올린 미디어) 본문을 읽지 못하면 아무것도 바꾸지 않는다 — 다시 올릴
   * 뿐 잃는 것은 없다.
   *
   * @param markdown 보낼 본문(Notion markdown) — 자리표시자가 줄 단독으로 있다
   */
  async keepUploadedMedia(pageId: string, markdown: string, notePath?: string): Promise<KeptMedia> {
    const unchanged: KeptMedia = { markdown, kept: [] };
    if (!this.notionClient) return unchanged;
    LOCAL_MARKER_RE.lastIndex = 0;
    if (!LOCAL_MARKER_RE.test(markdown)) return unchanged;
    const known = recallUploadedMedia(this.stateDb, pageId);
    if (![...known.values()].some((media) => media.fileHash)) return unchanged;

    let remote: string;
    try {
      remote = (await this.notionClient.getPageMarkdown(pageId)).markdown;
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 본문을 읽지 못해 미디어를 그대로 두지 못함 (${notePath ?? pageId}) — 다시 올린다: ` +
          messageOf(error),
      );
      return unchanged;
    }

    // 받은 본문에 지금 있는 미디어 — 임베드한 경로마다 본문 차례대로. 같은 파일을 두 번 임베드하면
    // 둘을 따로 올렸으므로 둘 다 있다. 설명 · 크기는 견주지 않는다 — Notion 에서 캡션을 고쳐 받은
    // 노트는 임베드의 설명만 바뀌고, 보낼 캡션은 노트의 것이다.
    const onPage = new Map<string, Array<{ media: UploadedMedia; span: NotionMediaSpan }>>();
    for (const span of notionMediaSpans(remote)) {
      const fileId = notionFileIdOf(span.url);
      const media = fileId ? known.get(fileId) : undefined;
      if (!media?.fileHash) continue;
      const path = stripAlias(media.target);
      const list = onPage.get(path) ?? [];
      list.push({ media, span });
      onPage.set(path, list);
    }
    if (onPage.size === 0) return unchanged;

    const placeholders: Array<{
      start: number;
      end: number;
      lead: string;
      kind: string;
      target: string;
    }> = [];
    mapOutsideCodeFences(markdown, (segment, base) => {
      for (const m of segment.matchAll(PLACEHOLDER_LINE_RE)) {
        placeholders.push({
          start: base + m.index,
          end: base + m.index + m[0].length,
          lead: m[1]!,
          kind: m[2]!,
          target: decodeMarkerTarget(m[3]!),
        });
      }
      return segment;
    });

    const noteFolder = folderOf(notePath);
    const kept: UploadedMedia[] = [];
    let result = "";
    let cursor = 0;
    for (const placeholder of placeholders) {
      const found = onPage.get(stripAlias(placeholder.target))?.shift();
      const line = found && (await this.keptMediaLine(placeholder, found, noteFolder));
      if (!line) continue;
      result += markdown.slice(cursor, placeholder.start) + line;
      cursor = placeholder.end;
      kept.push({ ...found.media, target: placeholder.target });
    }
    if (kept.length === 0) return unchanged;
    return { markdown: result + markdown.slice(cursor), kept };
  }

  /**
   * 자리표시자 자리에 실을 Notion 미디어 한 줄. 종류 · 캡션 · URL 을 그대로 실을 수 없거나 볼트의 파일이
   * 올린 것과 다르면 null — 그 자리표시자는 다시 올린다.
   */
  private async keptMediaLine(
    placeholder: { lead: string; kind: string; target: string },
    found: { media: UploadedMedia; span: NotionMediaSpan },
    noteFolder: string | undefined,
  ): Promise<string | null> {
    const isImage = placeholder.kind === "image";
    if (isImage !== found.span.full.startsWith("![")) return null;
    // 파일은 Notion 에 있는 블록 종류 그대로 둔다 — PDF · 동영상 · 소리 블록도(B12).
    const tag = MEDIA_TAG_NAME_RE.exec(found.span.full)?.[1];
    if (!isImage && !tag) return null;
    const caption = this.keptCaptionOf(placeholder.target, found.span);
    const url = found.span.url.split("?")[0]!;
    if (!PLAIN_CAPTION_RE.test(caption) || !PLAIN_URL_RE.test(url)) return null;
    try {
      const { buffer, resolvedPath } = await this.readImageFromVault(
        stripAlias(placeholder.target),
        noteFolder,
      );
      if (resolvedPath !== found.media.localPath) return null;
      if (createHash("sha256").update(buffer).digest("hex") !== found.media.fileHash) return null;
    } catch {
      // 볼트에서 못 찾으면 자리표시자를 둔다 — 올리는 쪽이 같은 사유로 알린다.
      return null;
    }
    return isImage
      ? `${placeholder.lead}![${caption}](${url})`
      : `${placeholder.lead}<${tag} src="${url}">${caption}</${tag}>`;
  }

  /**
   * 그대로 둔 미디어에 실을 캡션 — 임베드의 설명. 캡션 없는 파일을 받으면 올라간 이름을 별칭으로
   * 적으므로({@link fileNameOf}), Notion 에 캡션이 없고 별칭이 그 이름이면 캡션을 비운 채 둔다 — 실으면
   * 받은 파일마다 이름이 캡션으로 붙는다.
   */
  private keptCaptionOf(target: string, span: NotionMediaSpan): string {
    const caption = captionOfEmbed(target);
    if (captionOfLabel(span.label)) return caption;
    return caption === toWikilinkAlias(this.uploadedNameOf(span.url)) ? "" : caption;
  }

  /**
   * push 가 심어 둔 자리표시자 quote 를 **제자리에서** 실제 image/file 블록으로 바꾼다(R1).
   *
   * 그 전에는 임베드 하나가 Notion 에서 두 조각으로 갈라졌다 — 본문 자리에는
   * `> 📎 foo.png` + `%% im-nobsidian:local-image:… %%` 리터럴 마커가, 실제 이미지는
   * 페이지 맨 끝에 따로. 실측: 볼트 175개 파일에서 마커 978건이 Notion 에 그대로
   * 텍스트로 새고 있었고 그중 964건(98.6%)이 이 미디어 쌍이었다. 사용자가 Notion 에서
   * 보는 화면이 깨질 뿐 아니라 이미지가 본문 흐름에서 이탈한다.
   *
   * 캡션에는 사람이 적은 설명만 단다({@link captionOfEmbed}). 어느 임베드였는지는 Notion 이
   * 그 파일을 저장한 id 와 함께 적어 두고({@link rememberUploadedMedia}), pull 이 그것으로
   * 임베드를 되찾는다(S-05). 예전에는 캡션에 임베드 대상을 그대로 적어 Notion 에 경로 · 크기 ·
   * 파일 이름이 보였다.
   *
   * 볼트에서 파일을 못 찾으면 자리표시자를 그대로 둔다 — 마커가 남아야 pull 이
   * 임베드를 복원할 수 있으므로, 반쯤 지우는 것보다 안전하다.
   */
  async materializeLocalMedia(
    pageId: string,
    pushedMarkdown: string,
    notePath?: string,
    kept: readonly UploadedMedia[] = [],
  ): Promise<MaterializeResult> {
    // 그대로 둔 미디어도 처리된 임베드다 — 호출측이 페이지 끝에 또 붙이지 않는다.
    const handledTargets = new Set<string>();
    for (const media of kept) {
      handledTargets.add(media.target);
      handledTargets.add(stripAlias(media.target));
      handledTargets.add(media.localPath);
    }
    const empty: MaterializeResult = { uploaded: [], handledTargets, touched: false };
    if (!this.notionClient) return empty;
    // 마커가 없는 페이지에서는 블록 조회조차 하지 않는다 — 대부분의 페이지가 여기서 끝난다.
    LOCAL_MARKER_RE.lastIndex = 0;
    if (!LOCAL_MARKER_RE.test(pushedMarkdown)) {
      if (kept.length > 0) this.rememberUploads(pageId, kept);
      return empty;
    }

    let hits: PlaceholderHit[];
    try {
      hits = await this.collectPlaceholders(pageId);
    } catch (error) {
      getLogger().warn(`미디어 자리표시자 조회 실패 (${pageId}): ${messageOf(error)}`);
      return empty;
    }
    if (hits.length === 0) {
      if (kept.length > 0) this.rememberUploads(pageId, kept);
      return empty;
    }

    const noteFolder = folderOf(notePath);
    const uploaded: ImageUploadResult[] = [];
    const remembered: UploadedMedia[] = [...kept];
    const unsupported: string[] = [];
    const holding: string[] = [];
    let attempted = false;

    for (const hit of hits) {
      const vaultTarget = stripAlias(hit.target);
      // 자리표시자를 지우면 그 아래 묶인 블록도 함께 지워진다 — 바꾸지 않고 남긴다. push 는
      // 자리표시자를 뒷줄 깊이로 들여 이 모양을 만들지 않는다(converter/placeholder-indent).
      if (hit.hasChildren) {
        holding.push(vaultTarget);
        continue;
      }
      // Notion 이 받지 않는 형식은 올리지 않는다(S-14). 업로드를 만들 때 400 으로 거절되는데,
      // 자리표시자가 그대로 남으니 push 할 때마다 같은 요청이 같은 이유로 실패했다. 자리표시자는
      // 두어야 pull 이 임베드를 되살린다.
      if (!isNotionUploadable(vaultTarget)) {
        unsupported.push(vaultTarget);
        continue;
      }
      attempted = true;
      try {
        const result = await this.uploadLocalImage(vaultTarget, noteFolder);
        const block = mediaBlock(hit.kind, result.fileUploadId, vaultTarget, hit.target);

        const [created] = await this.notionClient.appendChildBlocks(hit.parentId, [block], {
          after: hit.blockId,
        });
        await this.notionClient.deleteBlock(hit.blockId);

        uploaded.push(result);
        handledTargets.add(hit.target);
        handledTargets.add(vaultTarget);
        handledTargets.add(result.localPath);
        const fileId = created ? await this.storedFileIdOf(created) : null;
        if (fileId) {
          remembered.push({
            fileId,
            target: hit.target,
            localPath: result.localPath,
            fileHash: result.fileHash,
          });
        } else {
          // 블록은 제자리에 있다. 다만 pull 이 이 임베드를 알아보지 못해 사본을 받는다.
          getLogger().warn(
            `[Im-Nobsidian] 올린 미디어의 Notion 파일을 확인하지 못함 (${vaultTarget}) — ` +
              "다음 pull 이 사본을 받을 수 있다",
          );
        }
      } catch (error) {
        // 자리표시자는 손대지 않고 남긴다 — 마커가 살아 있어야 pull 이 임베드를 되살린다.
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          getLogger().warn(`미디어 제자리 삽입 건너뜀 — 볼트에서 파일을 찾지 못함: ${vaultTarget}`);
        } else {
          getLogger().warn(`미디어 제자리 삽입 실패 (${vaultTarget}): ${messageOf(error)}`);
        }
      }
    }

    if (holding.length > 0) {
      getLogger().warn(
        `[Im-Nobsidian] 자리표시자 아래에 다른 블록이 묶여 이미지로 바꾸지 않은 임베드 (${notePath ?? pageId}): ` +
          `${holding.join(", ")} — 바꾸면 그 블록이 함께 지워진다. Notion 에는 파일 이름 자리표시자로 남는다`,
      );
    }
    if (unsupported.length > 0) {
      getLogger().info(
        `[Im-Nobsidian] Notion 이 받지 않는 형식이라 올리지 않은 임베드 (${notePath ?? pageId}): ` +
          `${unsupported.join(", ")} — Notion 에는 파일 이름 자리표시자로 남는다`,
      );
    }
    this.registerUploads(pageId, uploaded);
    this.rememberUploads(pageId, remembered);
    // 올리려 한 것이 없으면 페이지는 그대로다 — 보낸 본문의 지문이 아직 맞다.
    return { uploaded, handledTargets, touched: attempted };
  }

  /**
   * 방금 만든 미디어 블록의 파일을 Notion 이 저장한 id. 만든 응답에 파일 URL 이 실려 오고,
   * 없으면 블록을 한 번 조회한다. 끝내 모르면 null — 던지지 않는다(블록은 이미 제자리에 있다).
   */
  private async storedFileIdOf(block: { id: string; type?: string }): Promise<string | null> {
    const url =
      fileUrlOfBlock(block) ??
      (await this.notionClient?.getFileBlockUrl(block.id).catch((error: unknown) => {
        getLogger().warn(`[Im-Nobsidian] 올린 파일 블록 조회 실패(${block.id}): ${error}`);
        return null;
      }));
    return url ? notionFileIdOf(url) : null;
  }

  /**
   * 페이지 블록 트리를 훑어 자리표시자를 부모와 함께 모은다. 콜아웃·토글·목록 안에
   * 들어간 임베드도 제자리 교체하려면 부모 id 가 필요하다(append 의 after_block 은
   * 같은 부모의 자식만 기준으로 삼는다).
   */
  private async collectPlaceholders(rootId: string, depth = 0): Promise<PlaceholderHit[]> {
    if (depth > 4) return [];
    const client = this.notionClient!;
    const children = await client.fetchAllChildren(rootId);
    const hits: PlaceholderHit[] = [];

    for (const block of children) {
      const marker = placeholderMarkerOf(block);
      if (marker) {
        hits.push({
          parentId: rootId,
          blockId: block.id,
          kind: marker[1] === "image" ? "image" : "file",
          // 마커에 실린 경로는 퍼센트 인코딩돼 있다 — 볼트 조회·캡션 모두 원문이어야 한다.
          target: decodeMarkerTarget(marker[2]!),
          hasChildren: block.has_children === true,
        });
        continue;
      }
      if (block.has_children && !NON_DESCENDABLE_TYPES.has(block.type)) {
        hits.push(...(await this.collectPlaceholders(block.id, depth + 1)));
      }
    }
    return hits;
  }

  /**
   * 업로드분을 file_registry 에 남긴다. 노트 임베드는 여기서 페이지에 붙으므로,
   * 이후 FileHandler.pushAllFiles 가 같은 첨부를 폴더 페이지에 standalone 으로
   * 재업로드하는 중복을 공유 레지스트리로 차단한다.
   */
  private registerUploads(pageId: string, results: ImageUploadResult[]): void {
    if (!this.stateDb || results.length === 0) return;
    for (const r of results) {
      try {
        this.stateDb.registerFile({
          localPath: r.localPath,
          notionPageId: pageId,
          fileUploadId: r.fileUploadId,
          fileType: "image",
          fileHash: r.fileHash,
          fileSize: r.fileSize,
        });
      } catch (error) {
        getLogger().warn(`미디어 레지스트리 등록 실패 (${r.localPath}):`, error);
      }
    }
  }

  /**
   * 올린 미디어를 임베드와 함께 적어 둔다(S-05). 적지 못해도 push 는 깨뜨리지 않는다 — 블록은
   * 이미 제자리에 있고, 다음 pull 이 그 파일을 알아보지 못해 사본을 받을 뿐이다.
   */
  private rememberUploads(pageId: string, media: readonly UploadedMedia[]): void {
    if (!this.stateDb) return;
    try {
      rememberUploadedMedia(this.stateDb, pageId, media);
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 올린 미디어 기록 실패 (${pageId}) — 다음 pull 이 사본을 받을 수 있다: ` +
          messageOf(error),
      );
    }
  }

  /**
   * 받은 미디어를 그 페이지의 미디어 기록에 더한다 — 그 노트를 고쳐 push 할 때 Notion 의 원래 블록을
   * 둔다({@link keepUploadedMedia}). 적지 못해도 pull 은 깨뜨리지 않는다 — 그 노트를 push 하면 예전처럼
   * 다시 올릴 뿐이다.
   */
  private rememberReceived(
    pageId: string | undefined,
    received: ReadonlyArray<UploadedMedia | null>,
  ): void {
    const media = received.filter((item): item is UploadedMedia => item !== null);
    if (!pageId || !this.stateDb || media.length === 0) return;
    try {
      rememberReceivedMedia(this.stateDb, pageId, media);
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 받은 미디어 기록 실패 (${pageId}) — 그 노트를 올리면 미디어를 다시 올린다: ` +
          messageOf(error),
      );
    }
  }

  /**
   * 임베드 경로가 가리킬 수 있는 볼트 실제 파일 후보를 우선순위대로 만든다(F23).
   * Obsidian 위키링크 임베드는 노트 옆 파일을 파일명만으로 참조하는 게 관례라
   * 노트 폴더 → 볼트 루트 → attachments/ 순.
   *
   * push(업로드)와 pull(원본 복원)이 **같은 사다리**를 봐야 왕복이 닫힌다. 예전에는
   * pull 쪽이 볼트 루트만 확인해서, `__e2e_probe__/노트.md` 안의 `![[t-img.png]]` 는
   * 올라갈 때는 노트 폴더에서 잘 찾아 올리고도 내려올 때는 원본을 못 찾아 사본을
   * 새로 받았다(실측) — 왕복할 때마다 첨부가 한 벌씩 늘어난다.
   */
  private vaultCandidates(localPath: string, noteFolder?: string): string[] {
    const candidates: string[] = [];
    if (noteFolder && !localPath.includes("/")) {
      candidates.push(`${noteFolder}/${localPath}`);
    }
    candidates.push(localPath, `${this.attachmentFolder}/${localPath}`);
    return candidates;
  }

  /**
   * 임베드 경로를 볼트 실제 파일로 해석해 읽는다(F23).
   * 폴백은 조용히 진행하고, 전부 실패했을 때만 마지막 오류를 던진다.
   */
  private async readImageFromVault(
    localPath: string,
    noteFolder?: string,
  ): Promise<{ buffer: Buffer; resolvedPath: string }> {
    const candidates = this.vaultCandidates(localPath, noteFolder);

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return { buffer: await this.vaultFs.readBinary(candidate), resolvedPath: candidate };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async downloadAllFiles(
    markdown: string,
    pageTitle: string,
    pageId?: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    // F14: 캡션 중첩 링크 대응 — 괄호 균형 스캔 후 파일 라벨(이모지 프리픽스)만 취한다.
    const fileLinks = scanMarkdownLinks(markdown).filter(
      (s) => !s.isEmbed && FILE_LABEL_PREFIX_RE.test(s.label),
    );
    const notionHttpMatches = fileLinks.filter(
      (s) => /^https?:\/\//.test(s.url) && this.isNotionFileUrl(s.url),
    );
    const mdInternalMatches = fileLinks.filter((s) => INTERNAL_FILE_URL_RE.test(s.url));

    const xmlHttpMatches = [...markdown.matchAll(mediaTagRe('https?:\\/\\/[^"]+'))];
    const notionXmlHttpMatches = xmlHttpMatches.filter((m) => m[1] && this.isNotionFileUrl(m[1]));

    const xmlInternalMatches = [...markdown.matchAll(mediaTagRe("file:\\/\\/%7B.*?%7D%7D"))];

    const totalMatches =
      notionHttpMatches.length +
      mdInternalMatches.length +
      notionXmlHttpMatches.length +
      xmlInternalMatches.length;

    if (totalMatches === 0) {
      return { content: markdown, downloads: [] };
    }

    const sema = new Sema(this.concurrency);
    const downloads: ImageDownloadResult[] = [];
    const received: Array<UploadedMedia | null> = [];
    let result = markdown;

    for (const span of notionHttpMatches) {
      await sema.acquire();
      try {
        const caption = fileNameOf(span.label.replace(FILE_LABEL_PREFIX_RE, ""), span.url);
        const download = await this.downloadFile(span.url, pageTitle, caption);
        if (!download.localPath) continue;
        downloads.push(download);
        // F19: 다운로드한 미디어는 링크가 아니라 임베드(![[..]])로 복원해야 인라인 렌더된다.
        const obsidianLink = fileEmbedOf(download.localPath, download.name ?? caption);
        // 이름 · 캡션에 `$` 가 있어도(`가격$&.pdf`) 치환 패턴으로 읽지 않도록 함수로 넘긴다.
        result = result.replace(span.full, () => obsidianLink);
        received.push(
          receivedMediaOf(
            span.url,
            download,
            fileEmbedTargetOf(download.localPath, download.name ?? caption),
          ),
        );
      } catch (error) {
        getLogger().warn(`파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    for (const span of mdInternalMatches) {
      await sema.acquire();
      try {
        const parsed = this.parseNotionFileUrl(span.url);
        if (!parsed || !this.notionClient) continue;

        const blockId = parsed.blockId;
        const fileName = parsed.fileName;
        const realUrl = await this.notionClient.getFileBlockUrl(blockId);
        if (!realUrl) {
          getLogger().warn(`[Im-Nobsidian] 파일 Block URL 조회 실패: ${fileName}`);
          continue;
        }

        const caption = savedNameOf(span.label.replace(FILE_LABEL_PREFIX_RE, ""), fileName);
        const download = await this.downloadFile(realUrl, pageTitle, caption);
        if (!download.localPath) continue;
        downloads.push(download);
        const obsidianLink = fileEmbedOf(download.localPath, download.name ?? caption);
        result = result.replace(span.full, () => obsidianLink);
        received.push(
          receivedMediaOf(
            realUrl,
            download,
            fileEmbedTargetOf(download.localPath, download.name ?? caption),
          ),
        );
      } catch (error) {
        getLogger().warn(`내부 파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    for (const match of notionXmlHttpMatches) {
      await sema.acquire();
      try {
        const url = match[1]!;
        const caption = fileNameOf(match[2] ?? "", url);
        const download = await this.downloadFile(url, pageTitle, caption);
        if (!download.localPath) continue;
        downloads.push(download);
        const obsidianLink = fileEmbedOf(download.localPath, download.name ?? caption);
        result = result.replace(match[0]!, () => obsidianLink);
        received.push(
          receivedMediaOf(
            url,
            download,
            fileEmbedTargetOf(download.localPath, download.name ?? caption),
          ),
        );
      } catch (error) {
        getLogger().warn(`파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    for (const match of xmlInternalMatches) {
      await sema.acquire();
      try {
        const fileUrl = match[1]!;
        const parsed = this.parseNotionFileUrl(fileUrl);
        if (!parsed || !this.notionClient) continue;

        const blockId = parsed.blockId;
        const fileName = parsed.fileName;
        const realUrl = await this.notionClient.getFileBlockUrl(blockId);
        if (!realUrl) {
          getLogger().warn(`[Im-Nobsidian] 파일 Block URL 조회 실패: ${fileName}`);
          continue;
        }

        const caption = savedNameOf(match[2] ?? "", fileName);
        const download = await this.downloadFile(realUrl, pageTitle, caption);
        if (!download.localPath) continue;
        downloads.push(download);
        const obsidianLink = fileEmbedOf(download.localPath, download.name ?? caption);
        result = result.replace(match[0]!, () => obsidianLink);
        received.push(
          receivedMediaOf(
            realUrl,
            download,
            fileEmbedTargetOf(download.localPath, download.name ?? caption),
          ),
        );
      } catch (error) {
        getLogger().warn(`내부 파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    this.rememberReceived(pageId, received);
    return { content: result, downloads };
  }

  private parseNotionFileUrl(fileUrl: string): { blockId: string; fileName: string } | null {
    try {
      const decoded = decodeURIComponent(fileUrl.replace("file://", ""));
      const json = JSON.parse(decoded) as {
        source?: string;
        permissionRecord?: { id?: string };
      };
      const blockId = json.permissionRecord?.id ?? "";
      const source = json.source ?? "";
      const fileNameMatch = source.match(/attachment:[^:]+:(.+)$/);
      const fileName = fileNameMatch ? decodeURIComponent(fileNameMatch[1]!) : "";
      return blockId ? { blockId, fileName } : null;
    } catch {
      return null;
    }
  }

  private async downloadFile(
    url: string,
    _pageTitle: string,
    caption: string,
  ): Promise<ImageDownloadResult> {
    const maxRetries = this.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, this.retryBaseMs * attempt));
          getLogger().info(
            `[Im-Nobsidian] 파일 다운로드 재시도 (${attempt + 1}/${maxRetries}): ${caption}`,
          );
        }
        const response = await this.fetchForDownload(url);
        if (!response.ok) {
          throw new Error(`파일 다운로드 실패: ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get("content-length");
        const MAX_FILE_SIZE = this.maxFileSizeBytes;
        if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
          const sizeMB = Math.round(parseInt(contentLength, 10) / 1024 / 1024);
          // 원본 링크가 노트에 남는 의도된 degrade — 사용자가 이유를 알 수 있게 info 로 알린다.
          // push 는 restoreMediaTags 가 태그로 복원해 Notion 블록을 보존한다(실측: 동일 블록 유지).
          getLogger().info(
            `[Im-Nobsidian] 파일 다운로드 건너뜀 — 크기 상한 초과 (${sizeMB}MB > ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB), Notion 원본 링크 유지: ${caption}`,
          );
          return { originalUrl: url, localPath: "", hash: "", size: 0 };
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const fileHash = createHash("sha256").update(buffer).digest("hex");
        const hash = nameHashOf(fileHash);

        const extension = this.guessFileExtension(url, response.headers.get("content-type"));
        const name = withoutOwnHash(caption, hash);
        const safeName = name
          .replace(/[^a-zA-Z0-9가-힣\s._-]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 80);
        const fileName = `${safeName}-${hash}${extension}`;
        const localPath = `${this.attachmentFolder}/${fileName}`;

        await this.vaultFs.ensureFolder(this.attachmentFolder);
        await this.vaultFs.writeBinary(localPath, buffer);

        return { originalUrl: url, localPath, hash, size: buffer.length, fileHash, name };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError!;
  }

  private isNotionImageUrl(url: string): boolean {
    return this.isNotionFileUrl(url);
  }

  private isNotionFileUrl(url: string): boolean {
    return isNotionHostedFileUrl(url);
  }

  /**
   * notion-hosted 파일 URL 하나를 로컬 첨부로 로컬라이즈한다(P3-A).
   * DB 행의 `files` 속성처럼 본문 밖에 있는 서명 URL 용 — 서명 URL 은 약 1시간 뒤
   * 만료되어 frontmatter 에 남으면 깨진 링크가 되고, push 로 되밀면 Notion 원본이
   * external(만료 URL)로 오염된다(실측). notion-hosted 가 아닌 URL(사용자가 넣은
   * 진짜 외부 링크)은 다운로드 대상이 아니므로 null 을 반환한다.
   *
   * @returns 로컬 첨부 경로(`attachments/...`), 다운로드 대상이 아니거나 실패 시 null
   */
  async localizeNotionFileUrl(url: string, caption: string): Promise<string | null> {
    if (!/^https?:\/\//.test(url) || !this.isNotionFileUrl(url)) return null;
    try {
      const download = await this.downloadFile(url, caption, caption);
      return download.localPath || null;
    } catch (error) {
      getLogger().warn(`[Im-Nobsidian] 속성 파일 다운로드 실패 (${caption}): ${error}`);
      return null;
    }
  }

  private guessExtension(url: string): string | null {
    const pathname = new URL(url).pathname;
    const ext = pathname.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff)(\?|$)/i);
    return ext ? `.${ext[1]!.toLowerCase()}` : null;
  }

  private guessFileExtension(url: string, contentType: string | null): string {
    try {
      const pathname = new URL(url).pathname;
      const extMatch = pathname.match(/\.([a-zA-Z0-9]{1,10})(?:\?|$)/);
      if (extMatch) return `.${extMatch[1]!.toLowerCase()}`;
    } catch {
      // URL 파싱 실패 시 MIME 타입으로 폴백
    }

    const mimeMap: Record<string, string> = {
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/x-hwp": ".hwp",
      "application/gzip": ".gz",
    };
    if (contentType && mimeMap[contentType]) return mimeMap[contentType]!;
    return "";
  }
}
