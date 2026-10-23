import { inlineCodeRanges, mapOutsideCode, mapOutsideCodeFences } from "../utils/md-regions.js";
import { mathCloseAt } from "./literal-dollar.js";

/**
 * 글 백슬래시 · 글 백틱을 Notion markdown API 와 볼트 사이에서 그대로 옮긴다.
 *
 * Notion 의 규칙(2026-10-23 실측, `pages.create({ markdown })` → `retrieveMarkdown`):
 *
 * - 문장부호가 아닌 글자 앞의 `\` 를 escape 로 읽고 **지운다** — `C:\Users\me` → `C:Usersme`,
 *   `a \ b` → `a  b`. CommonMark 과 Obsidian 은 이 `\` 를 글자로 그린다. 그래서 push 는 `\\` 로 보낸다.
 * - 글 `\` 는 `\\` 로, 글 `` ` `` 는 `` \` `` 로 돌려준다. 볼트에서 사람이 쓴 모양은 맨 `\` · 맨 `` ` `` 라,
 *   그대로 받으면 새로 받은 볼트만 표기가 달랐다(그리는 것은 같다).
 * - 줄 끝의 `\` 는 지우지 않고 글로 둔다(`끝\` → `끝\\`).
 *
 * 코드(펜스 · 인라인)와 수식(`$…$` · `$$` 블록) 안은 건드리지 않는다 — 그 안의 `\` 는 escape 가 아니다.
 * 링크 주소(`](…)`)와 태그(`<…>`)도 건드리지 않는다 — 주소 · 속성 값이다.
 */

/** CommonMark 이 escape 할 수 있는 글자 — ASCII 문장부호. 이 앞의 `\` 만 escape 다. */
const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;

/** 블록 수식의 경계 줄 — 줄머리(인용 · 들여쓰기) 뒤에 `$$` 만 있다. */
const MATH_FENCE_LINE_RE = /^(?:[ \t]*>)*[ \t]*\$\$[ \t]*$/;

/** 건드리지 않을 줄 안의 자리 — 링크 주소 · 태그. */
const OPAQUE_RE = /\]\([^)\n]*\)|<[^<>\n]*>/g;

/**
 * push — 지워질 글 `\`(문장부호 · 줄 끝 앞이 아닌 것)를 `\\` 로. 이미 escape 쌍(`\\` · `\*`)은 그대로다.
 */
export function sendLiteralBackslashes(markdown: string): string {
  if (!markdown.includes("\\")) return markdown;
  return mapOutsideMathAndCode(markdown, (text) => {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const next = text[i + 1];
      if (next === undefined || next === "\n") {
        out += ch;
      } else if (ASCII_PUNCT_RE.test(next)) {
        out += ch + next;
        i++;
      } else {
        out += "\\\\";
      }
    }
    return out;
  });
}

/** escape 쌍(`\x`). */
const ESCAPED_CHAR_RE = /\\[\s\S]/g;
/** escape 쌍은 그대로 넘기고 맨 대괄호만 잡는다. */
const BRACKET_OR_ESCAPE_RE = /\\[\s\S]|[[\]]/g;

/**
 * push — 링크 글자 안의 `[` · `]` 를 `\[` · `\]` 로.
 *
 * CommonMark 은 링크 글자에 짝 맞은 대괄호를 허용한다(`[[1주] - 제목](url)`). Notion 은 그 링크를 읽지 못하고 글로 둔 뒤
 * 주소에만 자동 링크를 건다 — 받으면 `[[1주] - 제목]([url](url))` 가 됐다(2026-10-23 실데이터 E2E · 탐침). escape 한
 * `[\[1주\] - 제목](url)` 은 링크로 읽는다. 받기는 `\[` · `\]` 를 푼다(`unescapeBrackets`) — 노트가 그대로 돌아온다.
 *
 * 건드리지 않는 것: 글자가 통째로 대괄호인 `[[이름]](…)`(Obsidian 위키링크 뒤의 괄호다) · 안에 링크 · 이미지가 든 글자
 * (`[![배지](…)](…)`) · 각주(`[^1]`) · 코드.
 */
export function escapeLinkTextBrackets(markdown: string): string {
  if (!markdown.includes("](")) return markdown;
  return mapOutsideCode(markdown, (segment) =>
    segment.split("\n").map(escapeLineLinkText).join("\n"),
  );
}

function escapeLineLinkText(line: string): string {
  if (!line.includes("](")) return line;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      out += line.slice(i, i + 2);
      i++;
      continue;
    }
    if (ch === "[") {
      const close = closingBracket(line, i);
      if (close !== -1 && line[close + 1] === "(") {
        const text = line.slice(i + 1, close);
        if (hasBareBrackets(text) && !keepsBrackets(text)) {
          out += `[${text.replace(BRACKET_OR_ESCAPE_RE, (m) => (m.length === 1 ? `\\${m}` : m))}]`;
          i = close;
          continue;
        }
      }
    }
    out += ch;
  }
  return out;
}

/** `open` 의 `[` 와 짝인 `]` 의 자리 — escape 된 글자는 세지 않는다. 없으면 -1. */
function closingBracket(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") i++;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

/** escape 되지 않은 `[` · `]` 가 있나. */
function hasBareBrackets(text: string): boolean {
  return /[[\]]/.test(text.replace(ESCAPED_CHAR_RE, ""));
}

function keepsBrackets(text: string): boolean {
  if (text.includes("](") || text.includes("[^")) return true;
  return text.startsWith("[") && closingBracket(text, 0) === text.length - 1;
}

/**
 * pull — Notion 이 글 `\` 로 돌려준 `\\` 중 push 가 `\\` 로 보낸 모양(뒤가 문장부호 · 줄 끝이 아닌 것)만 `\` 로.
 * `\\*` · `\\[` 는 둔다 — 풀면 뒤 글자가 escape 된다.
 */
export function receiveLiteralBackslashes(markdown: string): string {
  if (!markdown.includes("\\\\")) return markdown;
  return mapOutsideMathAndCode(markdown, (text) => {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const next = text[i + 1];
      if (next === "\\") {
        const after = text[i + 2];
        out += after !== undefined && after !== "\n" && !ASCII_PUNCT_RE.test(after) ? "\\" : "\\\\";
        i++;
      } else if (next !== undefined) {
        out += ch + next;
        i++;
      } else {
        out += ch;
      }
    }
    return out;
  });
}

/**
 * pull — Notion 의 글 백틱(`` \` ``)을 맨 `` ` `` 로. 그 줄에서 푼 백틱이 코드의 경계가 될 수 있으면(짝이 생기면)
 * 그 줄은 그대로 둔다 — 없던 코드가 생긴다. 코드 펜스 줄은 건드리지 않는다.
 */
export function receiveLoneBackticks(markdown: string): string {
  if (!markdown.includes("\\`")) return markdown;
  return mapOutsideCodeFences(markdown, (segment) =>
    segment
      .split("\n")
      .map((line) => (line.includes("\\`") ? unescapeBackticksIfSafe(line) : line))
      .join("\n"),
  );
}

function unescapeBackticksIfSafe(line: string): string {
  const codes = inlineCodeRanges(line);
  const inCode = (i: number) => codes.some(([s, e]) => i >= s && i < e);
  // 푼 줄과, 푼 백틱이 그 줄에서 놓일 자리
  let out = "";
  const freed: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && !inCode(i) && i + 1 < line.length) {
      const next = line[i + 1]!;
      if (next === "`") {
        freed.push(out.length);
        out += "`";
      } else {
        out += ch + next;
      }
      i++;
      continue;
    }
    out += ch;
  }
  if (freed.length === 0) return line;
  const after = inlineCodeRanges(out);
  const pairs = freed.some((p) => after.some(([s, e]) => p >= s && p < e));
  return pairs ? line : out;
}

/**
 * 코드 · 수식 · 링크 주소 · 태그 밖의 글에만 `fn` 을 부른다. 블록 수식(`$$` 줄 사이)은 줄째 건너뛴다.
 */
function mapOutsideMathAndCode(markdown: string, fn: (text: string) => string): string {
  return mapOutsideCode(markdown, (segment) => {
    let inBlockMath = false;
    return segment
      .split("\n")
      .map((line) => {
        if (MATH_FENCE_LINE_RE.test(line)) {
          inBlockMath = !inBlockMath;
          return line;
        }
        if (inBlockMath) return line;
        return mapOutsideRanges(line, [...inlineMathRanges(line), ...opaqueRanges(line)], fn);
      })
      .join("\n");
  });
}

/** 줄 안의 인라인 수식 `$…$` 자리(양 끝 `$` 포함). escape 된 `\$` 는 여는 `$` 가 아니다. */
function inlineMathRanges(line: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "$" || escaped(line, i)) continue;
    const close = mathCloseAt(line, i);
    if (close === null) continue;
    ranges.push([i, close + 1]);
    i = close;
  }
  return ranges;
}

function opaqueRanges(line: string): Array<readonly [number, number]> {
  return [...line.matchAll(OPAQUE_RE)].map((m) => [m.index, m.index + m[0].length] as const);
}

/** `i` 의 글자 앞에 홀수 개의 `\` 가 있는가. */
function escaped(line: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

/** 겹칠 수 있는 자리들을 뺀 나머지 조각마다 `fn`. */
function mapOutsideRanges(
  line: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  fn: (text: string) => string,
): string {
  if (ranges.length === 0) return fn(line);
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [s, e] of sorted) {
    if (e <= pos) continue;
    const start = Math.max(s, pos);
    out += fn(line.slice(pos, start)) + line.slice(start, e);
    pos = e;
  }
  return out + fn(line.slice(pos));
}
