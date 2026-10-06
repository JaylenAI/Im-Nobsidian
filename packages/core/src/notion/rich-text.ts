import { RICH_TEXT_ARRAY_MAX, RICH_TEXT_CONTENT_MAX } from "../constants/notion-limits.js";

/**
 * 글을 rich text 객체에 담을 조각으로 나눈다 — 객체 하나는 {@link RICH_TEXT_CONTENT_MAX}자까지라 긴 글을
 * 한 덩어리로 보내면 Notion 이 요청 전체를 거부한다. 서로게이트 쌍(이모지 등)은 가르지 않는다.
 *
 * @returns 조각들. 배열 한도({@link RICH_TEXT_ARRAY_MAX})를 넘을 만큼 길면 null — 담을 수 없다.
 */
export function richTextChunks(text: string): string[] | null {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk.length + char.length > RICH_TEXT_CONTENT_MAX) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length > RICH_TEXT_ARRAY_MAX ? null : chunks;
}

/** rich text 조각의 서식 — Notion 이 돌려준 모양 그대로 다시 보낸다. */
interface Annotations {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly underline?: boolean;
  readonly code?: boolean;
  readonly color?: string;
}

/** Notion 이 돌려준 rich text 한 조각 — 고칠 때 쓰는 만큼만. */
export interface RichTextItem {
  readonly type: string;
  readonly plain_text: string;
  readonly href?: string | null;
  readonly annotations?: Annotations;
  readonly text?: { readonly content: string; readonly link?: { readonly url: string } | null };
  readonly mention?: { readonly type: string; readonly [kind: string]: unknown };
  readonly equation?: { readonly expression: string };
}

interface TextRequest {
  text: { content: string; link?: { url: string } };
  annotations?: Annotations;
}

/**
 * 속성 값으로 보내는 rich text 한 조각 — 평문으로 보내던 모양(`{text: {content}}`)과 같게, 타입은 적지
 * 않고 기본 서식이면 서식도 적지 않는다.
 */
export type RichTextRequest =
  | TextRequest
  | { mention: Record<string, unknown>; annotations?: Annotations }
  | { equation: { expression: string }; annotations?: Annotations };

/**
 * 다시 보낼 수 있는 멘션 — 요청에 받는 멘션 중 돌려받은 모양 그대로 보낼 수 있는 것(SDK 5.23.1
 * `MentionRichTextItemRequest`). 링크 미리보기 같은 나머지는 글로 보낸다.
 */
const WRITABLE_MENTIONS: ReadonlySet<string> = new Set(["user", "page", "database", "date"]);

/** 고치는 단위 — 글 조각은 가를 수 있고, 멘션 · 수식은 통째로만 남기거나 지운다. */
interface Piece {
  readonly item: RichTextItem;
  readonly start: number;
  readonly end: number;
  readonly atomic: boolean;
}

/** 끼운 글의 서식 · 링크. */
interface Style {
  readonly annotations?: Annotations;
  readonly link?: { url: string } | null;
}

/**
 * Notion 의 rich text 를 새 글로 고친다 — 앞뒤에서 같은 부분의 서식 · 링크 · 멘션 · 수식은 그대로 두고
 * 달라진 가운데만 바꾼다(F-08). 볼트는 rich text 속성을 평문으로만 적으므로, 평문을 그대로 보내면 한 글자만
 * 고쳐도 서식이 모두 지워진다.
 *
 * 멘션 · 수식에 걸친 편집은 그것을 글로 바꾼다. 끼운 글의 서식은 고친 자리를 따른다 — 한 글 조각 안을
 * 고쳤으면 그 조각의 서식과 링크를, 여러 조각에 걸쳤으면 그 첫 글 조각의 서식을, 조각 사이에 끼우기만
 * 했으면 앞 글 조각(맨 앞이면 뒤 글 조각)의 서식을 따른다.
 *
 * @returns 보낼 조각들. 배열 한도를 넘으면 null — 호출측이 평문으로 보낸다.
 */
export function patchRichText(
  items: readonly RichTextItem[],
  text: string,
): RichTextRequest[] | null {
  const pieces: Piece[] = [];
  let offset = 0;
  for (const item of items) {
    const length = item.plain_text.length;
    pieces.push({ item, start: offset, end: offset + length, atomic: item.type !== "text" });
    offset += length;
  }
  const old = items.map((item) => item.plain_text).join("");

  // 고칠 자리 [start, end) — 멘션 · 수식은 가르지 않는다.
  let start = commonPrefixLength(old, text);
  let end = old.length - commonSuffixLength(old.slice(start), text.slice(start));
  for (const piece of pieces) {
    if (!piece.atomic) continue;
    if (piece.start < start && start < piece.end) start = piece.start;
    if (piece.start < end && end < piece.end) end = piece.end;
  }
  const inserted = text.slice(start, text.length - (old.length - end));

  const head: RichTextRequest[] = [];
  const tail: RichTextRequest[] = [];
  for (const piece of pieces) {
    if (piece.end <= start && !(piece.start === start && start === end && piece.end > start)) {
      head.push(requestOf(piece.item));
    } else if (piece.start >= end) {
      tail.push(requestOf(piece.item));
    } else if (!piece.atomic) {
      // 고친 자리에 걸친 글 조각 — 앞뒤 남는 부분만 같은 서식으로 둔다.
      const content = piece.item.plain_text;
      if (piece.start < start)
        head.push(textRequest(content.slice(0, start - piece.start), piece.item));
      if (piece.end > end) tail.push(textRequest(content.slice(end - piece.start), piece.item));
    }
  }

  const chunks = richTextChunks(inserted);
  if (chunks === null) return null;
  const style = insertedStyle(pieces, start, end);
  const middle = chunks.map((content) =>
    styledText(content, style.annotations, style.link ?? null),
  );

  const merged = mergeAdjacentText([...head, ...middle, ...tail]);
  return merged.length > RICH_TEXT_ARRAY_MAX ? null : merged;
}

/** 고친 자리 [start, end) 에 끼울 글의 서식 — {@link patchRichText} 의 규칙. */
function insertedStyle(pieces: readonly Piece[], start: number, end: number): Style {
  const texts = pieces.filter((p) => !p.atomic && p.start < p.end);
  const inside = texts.find((p) =>
    start < end ? p.start <= start && end <= p.end : p.start < start && start < p.end,
  );
  if (inside) return { annotations: inside.item.annotations, link: linkOf(inside.item) };
  const first = start < end ? texts.find((p) => p.start < end && start < p.end) : undefined;
  const before = texts.find((p) => p.end === start);
  const after = texts.find((p) => p.start === end);
  return { annotations: (first ?? before ?? after)?.item.annotations };
}

/** 서로게이트 쌍을 가르지 않는 공통 앞부분 길이. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i > 0 && i < a.length && isLowSurrogate(a.charCodeAt(i))) i--;
  return i;
}

/** 서로게이트 쌍을 가르지 않는 공통 뒷부분 길이. */
function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  if (i > 0 && i < a.length && isLowSurrogate(a.charCodeAt(a.length - i))) i--;
  return i;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function linkOf(item: RichTextItem): { url: string } | null {
  return item.type === "text" && item.text?.link ? { url: item.text.link.url } : null;
}

/** 글 조각 요청 — 링크 · 기본이 아닌 서식만 적는다. */
function styledText(
  content: string,
  annotations: Annotations | undefined,
  link: { url: string } | null,
): TextRequest {
  return {
    text: { content, ...(link ? { link } : {}) },
    ...(annotations && !isDefaultStyle(annotations) ? { annotations } : {}),
  };
}

function textRequest(content: string, item: RichTextItem): TextRequest {
  return styledText(content, item.annotations, linkOf(item));
}

/** 받은 조각을 그대로 다시 보낼 모양으로. 다시 보낼 수 없는 멘션은 글(과 그 주소)로. */
function requestOf(item: RichTextItem): RichTextRequest {
  const annotations =
    item.annotations && !isDefaultStyle(item.annotations) ? { annotations: item.annotations } : {};
  if (item.type === "equation" && item.equation) {
    return { equation: { expression: item.equation.expression }, ...annotations };
  }
  if (item.type === "mention" && item.mention && WRITABLE_MENTIONS.has(item.mention.type)) {
    const kind = item.mention.type;
    const value = item.mention[kind] as { id?: unknown } | undefined;
    return { mention: { [kind]: kind === "date" ? value : { id: value?.id } }, ...annotations };
  }
  if (item.type === "text") return textRequest(item.plain_text, item);
  return styledText(item.plain_text, item.annotations, item.href ? { url: item.href } : null);
}

/** 서식 · 링크가 같은 이웃 글 조각을 하나로 — 한 조각 안을 고치면 다시 한 조각이 된다. */
function mergeAdjacentText(requests: RichTextRequest[]): RichTextRequest[] {
  const out: RichTextRequest[] = [];
  for (const request of requests) {
    if ("text" in request && request.text.content === "") continue;
    const last = out[out.length - 1];
    if (
      last &&
      "text" in last &&
      "text" in request &&
      sameStyle(last, request) &&
      last.text.content.length + request.text.content.length <= RICH_TEXT_CONTENT_MAX
    ) {
      out[out.length - 1] = {
        ...last,
        text: { ...last.text, content: last.text.content + request.text.content },
      };
    } else {
      out.push(request);
    }
  }
  return out;
}

function sameStyle(a: TextRequest, b: TextRequest): boolean {
  return (
    (a.text.link?.url ?? null) === (b.text.link?.url ?? null) &&
    JSON.stringify(normalizeAnnotations(a.annotations)) ===
      JSON.stringify(normalizeAnnotations(b.annotations))
  );
}

function isDefaultStyle(annotations: Annotations): boolean {
  return JSON.stringify(normalizeAnnotations(annotations)) === DEFAULT_STYLE;
}

function normalizeAnnotations(annotations: Annotations | undefined): Required<Annotations> {
  return {
    bold: annotations?.bold ?? false,
    italic: annotations?.italic ?? false,
    strikethrough: annotations?.strikethrough ?? false,
    underline: annotations?.underline ?? false,
    code: annotations?.code ?? false,
    color: annotations?.color ?? "default",
  };
}

const DEFAULT_STYLE = JSON.stringify(normalizeAnnotations(undefined));
