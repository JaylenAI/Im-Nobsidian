/**
 * NFM 한 줄의 글을 Notion rich text 로 — 블록 방식 push 전용 (C14, ADR-035).
 *
 * Markdown API 로 보내면 Notion 이 글을 읽는다. 블록 방식은 같은 글을 우리가 읽어 rich text 로 보내야 해서,
 * Notion 이 Markdown API 로 받은 글을 읽는 규칙을 그대로 옮겼다(2026-10-12 실측, 탐침 페이지의 블록 트리):
 *
 * - 강조 · 기울임 · 취소선 · 인라인 코드 · 링크 · `\` escape 는 CommonMark 와 같다 — martian(remark)이 읽는다.
 *   `~` 하나는 취소선이 아니다. `[^1]` · `![그림](주소)` · `[이름]: 주소` 는 글이다(그림은 `!` 뒤 링크).
 * - `<span color underline>` 은 색 · 밑줄이다. 겹치지 않는다 — 안쪽 span 은 속성을 더하고, 첫 `</span>` 이
 *   모두 닫는다. 남는 `</span>` 은 글이다. 닫지 않은 span 은 줄 끝까지다.
 * - `<mention-page|database|user|date>` 는 멘션이다. 페이지 멘션의 이름은 버린다(Notion 이 제목을 쓴다).
 * - `<br>` 은 줄바꿈 — 인라인 코드 안에서도. 그 밖의 `<…>` 와 `&amp;` 같은 엔티티는 글자 그대로다.
 *   `<https://…>` 는 `<` + 링크 + `>` 다.
 * - `$…$` 는 Notion 의 `$` 규칙({@link mathCloseAt})으로 가른 인라인 수식, `` $`…`$ `` 는 백틱 안이 식이다.
 *   `$$…$$` 도 인라인 수식이다.
 * - 줄 앞 공백은 버리고 줄 끝 공백은 남긴다.
 *
 * martian 에 넘기기 전에 위 태그 · 수식을 자리표시로 바꾸고, 돌아온 rich text 에서 자리표시를 멘션 · 수식 ·
 * 줄바꿈 · 색으로 푼다. 자리표시의 앞뒤는 문장 부호라(⁅ ⁆) 태그(`<` `>`) · 수식(`$`)처럼 강조 기호의
 * 여닫음을 가른다.
 */
import { markdownToRichText } from "@tryfabric/martian";
import type { ApiColor } from "@notionhq/client";
import { RICH_TEXT_CONTENT_MAX } from "../constants/notion-limits.js";
import { isNotionId, normalizeNotionId, notionIdOfUrl } from "../utils/id.js";
import { mathCloseAt } from "./literal-dollar.js";
import { nfmAttrValue, parseNfmAttrs, type NfmAttrs } from "./nfm-attrs.js";

export interface NfmAnnotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: ApiColor;
}

/** 블록 방식 push 가 보내는 rich text 한 조각. */
export type NfmRichText =
  | {
      type: "text";
      text: { content: string; link?: { url: string } };
      annotations: NfmAnnotations;
    }
  | { type: "mention"; mention: NfmMention; annotations: NfmAnnotations }
  | { type: "equation"; equation: { expression: string }; annotations: NfmAnnotations };

export type NfmMention =
  | { type: "page"; page: { id: string } }
  | { type: "database"; database: { id: string } }
  | { type: "user"; user: { id: string } }
  | { type: "date"; date: { start: string; end?: string; time_zone?: string } };

/** Notion 이 받는 색 — 주인은 SDK 타입이다. 모르는 색은 기본색으로 보낸다. */
const API_COLORS: Record<ApiColor, true> = {
  default: true,
  gray: true,
  brown: true,
  orange: true,
  yellow: true,
  green: true,
  blue: true,
  purple: true,
  pink: true,
  red: true,
  default_background: true,
  gray_background: true,
  brown_background: true,
  orange_background: true,
  yellow_background: true,
  green_background: true,
  blue_background: true,
  purple_background: true,
  pink_background: true,
  red_background: true,
};

/** NFM 색 이름(`yellow_bg`) → Notion 색(`yellow_background`). 모르는 색이면 null. */
export function apiColor(name: string | undefined): ApiColor | null {
  if (!name) return null;
  const color = name.replace(/_bg$/, "_background");
  return color in API_COLORS ? (color as ApiColor) : null;
}

// ─── 자리표시 ───

type Token =
  | { kind: "span"; attrs: NfmAttrs }
  | { kind: "span-end" }
  | { kind: "break" }
  | { kind: "mention"; mention: NfmMention }
  | { kind: "equation"; expression: string }
  /** 글자 그대로 — 자리표시에 쓰는 글자가 원래 글에 있을 때 · 이름만 남기는 멘션. */
  | { kind: "text"; text: string };

const OPEN = "⁅";
const CLOSE = "⁆";
/** 자리표시의 번호 글자 — 사용 영역 평면 15(U+F0000~). 글에 있으면 그 글자도 자리표시로 옮긴다. */
const TOKEN_BASE = 0xf0000;
const TOKEN_RE = /⁅([\u{F0000}-\u{FFFFD}])⁆/u;
const RESERVED_RE = /[⁅⁆\u{F0000}-\u{FFFFD}]/u;

const SPAN_OPEN_RE = /^<span((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*>/;
const SPAN_CLOSE_RE = /^<\/span>/;
const BREAK_RE = /^<br\s*\/?>/;
const MENTION_RE =
  /^<mention-([a-z-]+)((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*(?:\/>|>([^<]*)<\/mention-\1>)/;
const ANGLE_AUTOLINK_RE = /^<(https?:\/\/[^\s<>]+)>/;
const UNKNOWN_MENTION_RE = /^<unknown_mention((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*\/>/;
const BARE_URL_RE = /^(?:https?:\/\/|www\.)[^\s<]+/;
const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;
const SPACE_RE = /\s/;

/** NFM 글 한 줄을 rich text 로. 빈 글이면 빈 배열. */
export function nfmInlineToRichText(line: string): NfmRichText[] {
  const text = line.replace(/^[ \t]+/, "");
  const trailing = /[ \t]*$/.exec(text)![0];
  const body = text.slice(0, text.length - trailing.length);
  const tokens: Token[] = [];
  const source = escapeLeadingBlockSyntax(substitute(body, tokens));
  const items = source === "" ? [] : resolve(parseMarkdown(source), tokens);
  if (trailing !== "") items.push(textItem(trailing, plainAnnotations()));
  return mergeAndSplit(items);
}

function token(tokens: Token[], value: Token): string {
  tokens.push(value);
  return `${OPEN}${String.fromCodePoint(TOKEN_BASE + tokens.length - 1)}${CLOSE}`;
}

/** 태그 · 수식을 자리표시로 바꾸고, martian 이 달리 읽을 글자를 escape 한다. */
function substitute(text: string, tokens: Token[]): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const rest = text.slice(i);

    if (ch === "\\") {
      const next = text[i + 1];
      if (next !== undefined && ASCII_PUNCT_RE.test(next)) {
        out += ch + next;
        i += 2;
      } else {
        out += "\\\\";
        i += 1;
      }
      continue;
    }

    const url = bareUrlAt(text, i);
    if (url !== null) {
      // 주소 속 글자는 escape 하지 않는다 — `\&` 가 주소에 그대로 들어간다.
      out += url;
      i += url.length;
      continue;
    }

    if (ch === "`") {
      const span = codeSpanAt(text, i);
      if (span !== null) {
        out += span.fence + codeContent(span.content, tokens) + span.fence;
        i = span.end;
        continue;
      }
      const run = /^`+/.exec(rest)![0];
      out += run;
      i += run.length;
      continue;
    }

    if (ch === "$") {
      const math = mathAt(text, i);
      if (math !== null) {
        // 빈 수식은 블록 API 가 거부한다(실측 2026-10-12) — Notion 의 가져오기는 만들지만 글자로 둔다.
        out += token(
          tokens,
          math.expression === ""
            ? { kind: "text", text: text.slice(i, math.end) }
            : { kind: "equation", expression: math.expression },
        );
        i = math.end;
        continue;
      }
      out += "$";
      i += 1;
      continue;
    }

    if (ch === "<") {
      const tag = tagAt(rest, tokens);
      if (tag !== null) {
        out += tag.out;
        i += tag.length;
        continue;
      }
      out += "\\<";
      i += 1;
      continue;
    }

    if (ch === "&") {
      out += "\\&";
      i += 1;
      continue;
    }

    if (ch === "~") {
      const run = /^~+/.exec(rest)![0];
      out += run.length === 1 ? "\\~" : run;
      i += run.length;
      continue;
    }

    if (ch === "[" && text[i + 1] === "^") {
      out += "\\[";
      i += 1;
      continue;
    }

    if (ch === "!" && text[i + 1] === "[") {
      out += "\\!";
      i += 1;
      continue;
    }

    const cp = text.codePointAt(i)!;
    const char = String.fromCodePoint(cp);
    if (RESERVED_RE.test(char)) {
      out += token(tokens, { kind: "text", text: char });
    } else {
      out += char;
    }
    i += char.length;
  }
  return out;
}

/** 맨 주소(GFM autolink) — 낱말 경계에서 시작해 공백 · `<` 앞까지. 아니면 null. */
function bareUrlAt(text: string, at: number): string | null {
  const before = text[at - 1];
  if (before !== undefined && !/[\s*_~(]/.test(before)) return null;
  return BARE_URL_RE.exec(text.slice(at))?.[0] ?? null;
}

/** 인라인 코드 — 같은 길이의 백틱 줄로 닫힌다(CommonMark). 닫히지 않으면 null. */
function codeSpanAt(
  text: string,
  at: number,
): { fence: string; content: string; end: number } | null {
  const fence = /^`+/.exec(text.slice(at))![0];
  let k = at + fence.length;
  while (k < text.length) {
    const next = text.indexOf("`", k);
    if (next === -1) return null;
    const run = /^`+/.exec(text.slice(next))![0];
    if (run.length === fence.length) {
      return { fence, content: text.slice(at + fence.length, next), end: next + run.length };
    }
    k = next + run.length;
  }
  return null;
}

/** 인라인 코드 안 — `<br>` 만 줄바꿈이고 나머지는 글자 그대로다(실측). */
function codeContent(content: string, tokens: Token[]): string {
  let out = "";
  for (let i = 0; i < content.length;) {
    const br = BREAK_RE.exec(content.slice(i));
    if (br) {
      out += token(tokens, { kind: "break" });
      i += br[0].length;
      continue;
    }
    const char = String.fromCodePoint(content.codePointAt(i)!);
    out += RESERVED_RE.test(char) ? token(tokens, { kind: "text", text: char }) : char;
    i += char.length;
  }
  return out;
}

/** `at` 의 `$` 가 여는 인라인 수식. 수식이 아니면 null. */
function mathAt(text: string, at: number): { expression: string; end: number } | null {
  if (text[at + 1] === "`") {
    const close = text.indexOf("`$", at + 2);
    if (close !== -1) return { expression: text.slice(at + 2, close), end: close + 2 };
  }
  if (text[at + 1] === "$") {
    const after = text[at + 2];
    if (after !== undefined && !SPACE_RE.test(after)) {
      const close = text.indexOf("$$", at + 3);
      if (close !== -1 && !SPACE_RE.test(text[close - 1]!)) {
        return { expression: text.slice(at + 2, close), end: close + 2 };
      }
    }
  }
  const close = mathCloseAt(text, at);
  return close === null ? null : { expression: text.slice(at + 1, close), end: close + 1 };
}

/** `<` 로 시작하는 NFM 인라인 태그. 아니면 null — 호출측이 `<` 를 글자로 둔다. */
function tagAt(rest: string, tokens: Token[]): { out: string; length: number } | null {
  const span = SPAN_OPEN_RE.exec(rest);
  if (span)
    return {
      out: token(tokens, { kind: "span", attrs: parseNfmAttrs(span[1]!) }),
      length: span[0].length,
    };
  const close = SPAN_CLOSE_RE.exec(rest);
  if (close) return { out: token(tokens, { kind: "span-end" }), length: close[0].length };
  const br = BREAK_RE.exec(rest);
  if (br) return { out: token(tokens, { kind: "break" }), length: br[0].length };
  const mention = MENTION_RE.exec(rest);
  if (mention) {
    const value = mentionOf(mention[1]!, parseNfmAttrs(mention[2]!));
    const label = mention[3] ?? "";
    const out =
      value !== null
        ? token(tokens, { kind: "mention", mention: value })
        : label === ""
          ? ""
          : token(tokens, { kind: "text", text: label });
    return { out, length: mention[0].length };
  }
  const unknown = UNKNOWN_MENTION_RE.exec(rest);
  if (unknown)
    return { out: unknownMention(parseNfmAttrs(unknown[1]!)), length: unknown[0].length };
  const link = ANGLE_AUTOLINK_RE.exec(rest);
  if (link) {
    // Notion 은 꺾쇠를 글로 남기고 주소만 링크로 만든다(실측).
    const url = link[1]!;
    return { out: `\\<[${url}](${url})\\>`, length: link[0].length };
  }
  return null;
}

/**
 * 다시 만들 수 없는 멘션(링크 미리보기 · 템플릿 …) — 주소가 웹 주소면 그 주소로 가는 링크로 남긴다. 이름은
 * `alt`, 없으면 주소. 웹 주소가 아니면 버린다.
 */
function unknownMention(attrs: NfmAttrs): string {
  const url = nfmAttrValue(attrs, "url") ?? "";
  if (!/^https?:\/\//.test(url) || /[\s<>]/.test(url)) return "";
  const label = (nfmAttrValue(attrs, "alt") || url).replace(/[!-/:-@[-`{-~]/g, "\\$&");
  return `[${label}](<${url}>)`;
}

/** 멘션 태그의 Notion 멘션. 다시 만들 수 없는 것(데이터 소스 · 에이전트 · 모르는 모양)은 null. */
function mentionOf(kind: string, attrs: NfmAttrs): NfmMention | null {
  const url = nfmAttrValue(attrs, "url") ?? "";
  switch (kind) {
    case "page":
    case "database": {
      const id = notionIdOfUrl(url);
      if (id === null) return null;
      return kind === "page"
        ? { type: "page", page: { id } }
        : { type: "database", database: { id } };
    }
    case "user": {
      const id = url.startsWith("user://") ? url.slice("user://".length) : "";
      return isNotionId(id) ? { type: "user", user: { id: normalizeNotionId(id) } } : null;
    }
    case "date":
      return dateMentionOf(attrs);
    default:
      return null;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** 날짜 멘션 — 시각이 있으면 시간대 이름과 함께 보낸다(Notion 이 그 시간대의 오프셋으로 적는다). */
function dateMentionOf(attrs: NfmAttrs): NfmMention | null {
  const side = (dateKey: string, timeKey: string): string | null | undefined => {
    const date = nfmAttrValue(attrs, dateKey);
    if (date === undefined) return undefined;
    if (!DATE_RE.test(date)) return null;
    const time = nfmAttrValue(attrs, timeKey);
    if (time === undefined) return date;
    return TIME_RE.test(time) ? `${date}T${time}:00` : null;
  };
  const start = side("start", "startTime");
  const end = side("end", "endTime");
  if (!start || end === null) return null;
  const timeZone = nfmAttrValue(attrs, "timeZone");
  return {
    type: "date",
    date: {
      start,
      ...(end ? { end } : {}),
      ...(start.includes("T") && timeZone ? { time_zone: timeZone } : {}),
    },
  };
}

/**
 * 줄 머리의 블록 문법을 escape 한다 — martian 은 글을 문서로 읽어, `- a` 를 목록으로 읽고 버린다. Notion 은
 * 블록의 글을 글로만 읽는다.
 */
function escapeLeadingBlockSyntax(source: string): string {
  if (/^#{1,6}(?:[ \t]|$)/.test(source)) return `\\${source}`;
  if (/^(?:[-*_][ \t]*){3,}$/.test(source)) return `\\${source}`;
  if (/^[-+*](?:[ \t]|$)/.test(source)) return `\\${source}`;
  if (/^>/.test(source)) return `\\${source}`;
  if (/^(?:`{3,}[^`]*|~{3,}.*)$/.test(source)) return `\\${source}`;
  if (/^\[(?:\\.|[^\\\]])+\]:/.test(source)) return `\\${source}`;
  const ordered = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(source);
  if (ordered) return `${ordered[1]}\\${source.slice(ordered[1]!.length)}`;
  return source;
}

interface MartianText {
  type: string;
  annotations: Partial<NfmAnnotations>;
  text?: { content: string; link?: { url: string } };
}

function parseMarkdown(source: string): MartianText[] {
  return markdownToRichText(source, { notionLimits: { truncate: false } }) as MartianText[];
}

function plainAnnotations(): NfmAnnotations {
  return {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  };
}

function textItem(content: string, annotations: NfmAnnotations, link?: string): NfmRichText {
  return {
    type: "text",
    text: link ? { content, link: { url: link } } : { content },
    annotations,
  };
}

/** martian 의 rich text 에서 자리표시를 푼다 — span 은 앞에서부터 차례로 색 · 밑줄을 켜고 끈다. */
function resolve(items: readonly MartianText[], tokens: readonly Token[]): NfmRichText[] {
  const out: NfmRichText[] = [];
  let span: { color?: ApiColor; underline?: boolean } | null = null;
  const annotate = (base: Partial<NfmAnnotations>): NfmAnnotations => {
    const a = { ...plainAnnotations(), ...base };
    if (span?.color) a.color = span.color;
    if (span?.underline) a.underline = true;
    return a;
  };

  for (const item of items) {
    if (item.type !== "text" || item.text === undefined) continue;
    const link = item.text.link?.url;
    let rest = item.text.content;
    while (rest !== "") {
      const m = TOKEN_RE.exec(rest);
      const head = m ? rest.slice(0, m.index) : rest;
      if (head !== "") out.push(textItem(head, annotate(item.annotations), link));
      if (!m) break;
      rest = rest.slice(m.index + m[0].length);
      const t = tokens[m[1]!.codePointAt(0)! - TOKEN_BASE]!;
      switch (t.kind) {
        case "span": {
          const color = apiColor(nfmAttrValue(t.attrs, "color"));
          const underline = nfmAttrValue(t.attrs, "underline") === "true";
          span = {
            ...(span ?? {}),
            ...(color ? { color } : {}),
            ...(underline ? { underline } : {}),
          };
          break;
        }
        case "span-end":
          if (span === null) out.push(textItem("</span>", annotate(item.annotations), link));
          span = null;
          break;
        case "break":
          out.push(textItem("\n", annotate(item.annotations), link));
          break;
        case "text":
          out.push(textItem(t.text, annotate(item.annotations), link));
          break;
        case "mention":
          out.push({
            type: "mention",
            mention: t.mention,
            annotations: annotate(item.annotations),
          });
          break;
        case "equation":
          out.push({
            type: "equation",
            equation: { expression: t.expression },
            annotations: annotate(item.annotations),
          });
          break;
      }
    }
  }
  return out;
}

/** 서식 · 링크가 같은 이웃 글은 붙이고, 한 조각의 한도를 넘는 글은 나눈다. */
function mergeAndSplit(items: readonly NfmRichText[]): NfmRichText[] {
  const merged: NfmRichText[] = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (
      last?.type === "text" &&
      item.type === "text" &&
      last.text.link?.url === item.text.link?.url &&
      JSON.stringify(last.annotations) === JSON.stringify(item.annotations)
    ) {
      merged[merged.length - 1] = {
        ...last,
        text: { ...last.text, content: last.text.content + item.text.content },
      };
    } else {
      merged.push(item);
    }
  }
  return merged.flatMap((item) => {
    if (item.type !== "text" || item.text.content.length <= RICH_TEXT_CONTENT_MAX) return [item];
    const parts: NfmRichText[] = [];
    let chunk = "";
    for (const char of item.text.content) {
      if (chunk.length + char.length > RICH_TEXT_CONTENT_MAX) {
        parts.push({ ...item, text: { ...item.text, content: chunk } });
        chunk = "";
      }
      chunk += char;
    }
    if (chunk) parts.push({ ...item, text: { ...item.text, content: chunk } });
    return parts;
  });
}
