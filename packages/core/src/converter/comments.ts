import { MARKER_BRAND, MARKER_TOKEN_RE } from "../constants/markers.js";
import {
  collapseBlankLines,
  mapOutsideCodeFences,
  nextCodeSpan,
  scanCodeFences,
  type CodeFence,
} from "../utils/md-regions.js";
import { alignLines, lineSimilarity, mapOffset } from "../utils/line-diff.js";
import { splitFrontmatter } from "../utils/frontmatter.js";

/**
 * Obsidian 주석(`%%…%%`)과 HTML 주석(`<!--…-->`) — 로컬에만 두는 글이다(F26). push 는 지우고
 * (`CommentStripper`), pull 은 받기 직전의 로컬 노트에서 그 자리에 되살린다(`CommentRestorer`, S-29).
 *
 * 지우는 모양은 Obsidian 이 그리는 모양을 따른다 — 주석만 있는 줄은 줄째 지운다. 콜아웃 · 문단 속 주석
 * 줄은 그리지 않으므로, `>` 만 남기면 Notion 에서 문단이 갈린다. 줄 속 주석은 주석과 그 옆 공백 하나를
 * 지운다. 되살리기는 지운 글을 그대로 끼운다 — 받은 글이 지운 뒤 글과 같으면 로컬 노트와 같아진다.
 */

/** 주석 하나 — 글 기준 `[start, end)`. */
export interface CommentSpan {
  readonly start: number;
  readonly end: number;
  /** 구분자 안의 글. */
  readonly text: string;
  readonly style: "obsidian" | "html";
}

/** 한 자리에서 지운 글 — 주석 하나 이상과 그 자리의 공백 · 줄. */
export interface CommentCut {
  /** 지운 글 그대로 — 되살릴 때 끼운다. */
  readonly text: string;
  /** 지운 자리 — 지운 뒤 글 기준. */
  readonly at: number;
  /**
   * 줄째 지웠으면 그 줄이 붙어 있던 이웃 — `after` 는 앞 줄 끝(글이 `\n` 으로 시작), `before` 는 뒤 줄
   * 머리(글이 `\n` 으로 끝 — 본문 전체가 주석이면 줄바꿈 없이)다. 줄 속에서 지웠으면 없다.
   */
  readonly attach?: "after" | "before";
  /**
   * 주석만 — 줄째 지웠으면 주석 줄들(사이 빈 줄 · 붙은 줄바꿈 없이), 줄 속이면 주석 덩어리(옆 공백 없이).
   * 받은 글의 이웃이 로컬과 달라 지운 글을 그대로 끼울 수 없을 때 주석 줄로 끼운다.
   */
  readonly block: string;
  readonly comments: readonly CommentSpan[];
}

const HTML_OPEN = "<!--";
const HTML_CLOSE = "-->";
const OBSIDIAN_DELIMITER = "%%";

/** 주석을 빼면 남는 줄머리 — 공백과 인용 표시뿐이면 주석만 있는 줄이다. */
const CONTAINER_PREFIX_RE = /^[ \t]*(?:>[ \t]*)*/;
/** 빈 줄 — 인용 안의 빈 줄(`>`)과 CRLF 노트의 `\r` 도. */
const BLANKISH_RE = /^[ \t]*(?:>[ \t]*)*\r?$/;
const WHITESPACE_RE = /^[ \t\r]*$/;
const INLINE_GAP_RE = /^[ \t]*$/;

/**
 * 글의 주석 — 코드(펜스 · 인라인)와 브랜드 마커 밖. 겹치면 먼저 시작한 쪽이 이긴다 — 인라인 코드 속
 * `<!--` 는 글자고, 먼저 연 주석 속 백틱은 주석이다. 예전에는 코드를 먼저 떼지 않아 인라인 코드 속
 * 주석 표기(`` `<!-- 이렇게 -->` ``)까지 지웠다(실볼트 Blog.md 3곳).
 *
 * `%%` 는 브랜드 마커를 넘어 짝짓지 않는다 — 본문의 홑 `%%`(`압축률 100%%`)가 마커의 여는 `%%` 와
 * 짝지어 그 사이를 삼키던 결함(D-COMMENT-PAIR). HTML 주석은 마커를 품을 수 있다 — Obsidian 은 그
 * 안을 통째로 그리지 않는다.
 */
export function findComments(content: string): CommentSpan[] {
  const spans: CommentSpan[] = [];
  mapOutsideCodeFences(content, (segment, offset) => {
    scanSegment(segment, offset, spans);
    return segment;
  });
  return spans;
}

/** 코드 펜스 밖 조각 하나를 훑는다 — 다음 후보는 위치가 지나갈 때만 다시 찾는다(긴 노트에서 선형). */
function scanSegment(text: string, base: number, spans: CommentSpan[]): void {
  const markerRe = new RegExp(MARKER_TOKEN_RE.source, "g");
  const nextMarker = (from: number): readonly [number, number] | null => {
    markerRe.lastIndex = from;
    const match = markerRe.exec(text);
    return match ? [match.index, match.index + match[0].length] : null;
  };

  let pos = 0;
  let code = nextCodeSpan(text, 0);
  let marker = nextMarker(0);
  let percent = text.indexOf(OBSIDIAN_DELIMITER);
  let html = text.indexOf(HTML_OPEN);

  for (;;) {
    if (code && code[0] < pos) code = nextCodeSpan(text, pos);
    if (marker && marker[0] < pos) marker = nextMarker(pos);
    if (percent !== -1 && percent < pos) percent = text.indexOf(OBSIDIAN_DELIMITER, pos);
    if (html !== -1 && html < pos) html = text.indexOf(HTML_OPEN, pos);

    const first = Math.min(
      code?.[0] ?? Infinity,
      marker?.[0] ?? Infinity,
      percent === -1 ? Infinity : percent,
      html === -1 ? Infinity : html,
    );
    if (first === Infinity) return;

    // 마커는 `%%` 로 시작한다 — 같은 자리면 마커다.
    if (marker && first === marker[0]) {
      pos = marker[1];
    } else if (code && first === code[0]) {
      pos = code[1];
    } else if (first === html) {
      const close = text.indexOf(HTML_CLOSE, html + HTML_OPEN.length);
      if (close === -1) {
        pos = html + HTML_OPEN.length;
        continue;
      }
      spans.push({
        start: base + html,
        end: base + close + HTML_CLOSE.length,
        text: text.slice(html + HTML_OPEN.length, close),
        style: "html",
      });
      pos = close + HTML_CLOSE.length;
    } else {
      const open = percent;
      const close = text.indexOf(OBSIDIAN_DELIMITER, open + OBSIDIAN_DELIMITER.length);
      // 닫는 `%%` 가 없거나 다음 마커 안이면 짝 없는 홑 `%%` 다.
      if (close === -1 || (marker && close + OBSIDIAN_DELIMITER.length > marker[0])) {
        pos = open + OBSIDIAN_DELIMITER.length;
        continue;
      }
      pos = close + OBSIDIAN_DELIMITER.length;
      const body = text.slice(open + OBSIDIAN_DELIMITER.length, close);
      // 개행이 섞여 MARKER_TOKEN_RE 에 안 걸린 깨진 마커까지 삼키지 않도록 남겨 둔 방어선.
      const trimmed = body.trimStart();
      if (trimmed.startsWith(`${MARKER_BRAND}:`) || trimmed.startsWith("/")) continue;
      spans.push({ start: base + open, end: base + pos, text: body, style: "obsidian" });
    }
  }
}

/**
 * 주석을 지운 글과 지운 자리들.
 *
 * - **주석만 있는 줄**(주석을 빼면 공백 · 인용 표시뿐)은 줄째 지운다. 이어진 그런 줄은 한 번에 지운다.
 *   - 앞 줄에 붙어 있었으면 앞 줄 끝에서(`after`), 아니면 뒤 줄에 붙어 있었으면 뒤 줄 머리에서
 *     (`before`) 지운다.
 *   - 앞뒤가 다 빈 줄이면 빈 줄 하나를 함께 지운다 — 같은 컨테이너의 것을. 그래야 빈 줄이 겹치지 않고,
 *     콜아웃 끝의 주석이 `>` 빈 줄을 남기지 않는다.
 * - **줄 속 주석**은 주석과 옆 공백 하나를 지운다(`앞 %%메모%% 뒤` → `앞 뒤`). 공백으로만 떨어진
 *   주석들은 한 번에 지운다.
 */
export function cutComments(content: string): { content: string; cuts: CommentCut[] } {
  const spans = findComments(content);
  if (spans.length === 0) return { content, cuts: [] };

  const lines = content.split("\n");
  const starts = lineStarts(lines);
  const lineEnd = (i: number) => starts[i]! + lines[i]!.length;
  const lineOf = (offset: number) => upperBound(starts, offset) - 1;

  const wholeLine = commentOnlyLines(content, lines, starts, spans, lineOf);
  const cuts: Array<{ start: number; end: number; attach?: "after" | "before"; block: string }> =
    [];

  // 줄째 지우기 — 이어진 주석 줄 [first, last]. 위가 빈 줄(또는 글머리)이면 빈 줄만 사이에 둔 다음 주석
  // 줄까지 함께 지운다 — 따로 지우면 둘이 그 사이 빈 줄을 서로 지우려 한다. 위 줄에 붙은 주석 줄은 따로
  // 지운다 — 함께 지우면 위아래 문단이 한 문단으로 붙는다.
  for (let first = 0; first < lines.length; first++) {
    if (!wholeLine[first]) continue;
    const detached = first === 0 || BLANKISH_RE.test(lines[first - 1]!);
    let last = first;
    for (let i = first + 1; i < lines.length; i++) {
      if (wholeLine[i]) last = i;
      else if (!detached || !BLANKISH_RE.test(lines[i]!)) break;
    }
    const block = lines.slice(first, last + 1).filter((_, i) => wholeLine[first + i]);
    cuts.push({ ...lineCut(lines, starts, lineEnd, first, last), block: block.join("\n") });
    first = last;
  }

  // 줄 속 주석 — 공백으로만 떨어진 것끼리 묶는다
  const inline = spans.filter((span) => !wholeLine[lineOf(span.start)]);
  for (let i = 0; i < inline.length; i++) {
    const from = inline[i]!.start;
    let to = inline[i]!.end;
    while (i + 1 < inline.length && INLINE_GAP_RE.test(content.slice(to, inline[i + 1]!.start))) {
      to = inline[++i]!.end;
    }
    const before = content[from - 1];
    const after = content[to];
    const spaceBefore = before === " " || before === "\t";
    const spaceAfter = after === " " || after === "\t";
    let start = from;
    let end = to;
    if (spaceAfter && (spaceBefore || before === undefined || before === "\n")) end += 1;
    else if (spaceBefore && (after === undefined || after === "\n" || after === "\r")) start -= 1;
    cuts.push({ start, end, block: content.slice(from, to) });
  }

  cuts.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  const result: CommentCut[] = [];
  for (const cut of cuts) {
    out += content.slice(last, cut.start);
    result.push({
      text: content.slice(cut.start, cut.end),
      at: out.length,
      ...(cut.attach ? { attach: cut.attach } : {}),
      block: cut.block,
      comments: spans.filter((span) => span.start >= cut.start && span.end <= cut.end),
    });
    last = cut.end;
  }
  return { content: out + content.slice(last), cuts: result };
}

/**
 * 주석만 있는 줄인가 — 주석을 빼면 줄머리의 공백 · 인용 표시와 공백만 남는다. 여러 줄 주석이 그런
 * 줄 밖(글이 있는 줄)에 걸치면 그 주석이 지나는 줄은 모두 줄 속 주석으로 돌린다 — 줄째 지우면 걸친 줄의
 * 글까지 지운다.
 */
function commentOnlyLines(
  content: string,
  lines: readonly string[],
  starts: readonly number[],
  spans: readonly CommentSpan[],
  lineOf: (offset: number) => number,
): boolean[] {
  const covered = new Uint8Array(content.length);
  for (const span of spans) covered.fill(1, span.start, span.end);

  const result = lines.map((line, i) => {
    const start = starts[i]!;
    let first = -1;
    let rest = "";
    for (let c = 0; c < line.length; c++) {
      if (covered[start + c]) {
        if (first === -1) first = c;
      } else if (first !== -1) {
        rest += line[c];
      }
    }
    // 여러 줄 주석 속 빈 줄 — 글자가 없어도 앞뒤 줄바꿈이 주석 안이면 주석만 있는 줄이다.
    if (first === -1)
      return line.length === 0 && start > 0 && !!covered[start - 1] && !!covered[start];
    const prefix = line.slice(0, first);
    return CONTAINER_PREFIX_RE.exec(prefix)![0] === prefix && WHITESPACE_RE.test(rest);
  });

  for (let changed = true; changed;) {
    changed = false;
    for (const span of spans) {
      const from = lineOf(span.start);
      const to = lineOf(span.end - 1);
      if (from === to) continue;
      let all = true;
      for (let i = from; i <= to; i++) all &&= result[i]!;
      if (all) continue;
      for (let i = from; i <= to; i++) {
        if (result[i]) {
          result[i] = false;
          changed = true;
        }
      }
    }
  }
  return result;
}

/** 이어진 주석 줄 `[first, last]` 를 지울 구간 — 이웃 줄에 붙은 쪽의 줄바꿈과, 앞뒤가 빈 줄이면 빈 줄 하나까지. */
function lineCut(
  lines: readonly string[],
  starts: readonly number[],
  lineEnd: (i: number) => number,
  first: number,
  last: number,
): { start: number; end: number; attach: "after" | "before" } {
  // 글이 `\n` 으로 끝나면 마지막 빈 조각은 줄이 아니다.
  const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const prev = first > 0 ? lines[first - 1]! : undefined;
  const next = last + 1 < lineCount ? lines[last + 1]! : undefined;
  const depth = quoteDepth(lines[first]!);

  // [a, b] 를 지운다 — 앞 줄 끝의 줄바꿈부터(after), 아니면 뒤 줄 머리까지(before). 한쪽에 줄이
  // 없으면 다른 쪽으로, 둘 다 없으면(본문 전체가 주석) 줄바꿈 없이.
  type Range = { start: number; end: number; attach: "after" | "before" };
  const after = (a: number, b: number): Range =>
    a > 0 ? { start: lineEnd(a - 1), end: lineEnd(b), attach: "after" } : before(a, b, false);
  const before = (a: number, b: number, fallback = true): Range =>
    b + 1 < lines.length
      ? { start: starts[a]!, end: starts[b + 1]!, attach: "before" }
      : fallback && a > 0
        ? after(a, b)
        : { start: starts[a]!, end: lineEnd(b), attach: "before" };

  if (filled(prev)) return after(first, last);
  if (filled(next)) return before(first, last);
  if (endsContainer(prev, depth, next)) {
    // 컨테이너 끝의 주석 — 그 컨테이너의 빈 줄을 함께 지운다.
    return after(first - 1, last);
  }
  if (next !== undefined) return before(first, last + 1);
  return before(first, last);
}

/** 앞뒤가 빈 줄인 깊이 `depth` 의 주석 줄이 컨테이너 끝에 있다 — 앞 빈 줄은 같은 깊이, 뒤는 다른 깊이거나 글 끝. */
function endsContainer(prev: string | undefined, depth: number, next: string | undefined): boolean {
  return (
    blank(prev) &&
    (next === undefined || (quoteDepth(prev!) === depth && quoteDepth(next) !== depth))
  );
}

function blank(line: string | undefined): boolean {
  return line !== undefined && BLANKISH_RE.test(line);
}

function filled(line: string | undefined): boolean {
  return line !== undefined && !BLANKISH_RE.test(line);
}

function quoteDepth(line: string): number {
  return (CONTAINER_PREFIX_RE.exec(line)![0].match(/>/g) ?? []).length;
}

function lineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  for (let i = 0, pos = 0; i < lines.length; pos += lines[i]!.length + 1, i++) starts.push(pos);
  return starts;
}

/** 정렬된 `values` 에서 `value` 보다 큰 첫 자리. */
function upperBound(values: readonly number[], value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 받은 글(`pulled`)에 로컬 노트(`local`)의 주석을 되살린다.
 *
 * 로컬 노트에서 push 와 같은 규칙으로 주석을 지운 글이 받은 글과 같으면 로컬 노트를 그대로 돌려준다.
 * 다르면(원격 편집 · 표기 정규화) 두 글을 줄 단위로 맞춰, 지운 글을 맞는 자리에 끼운다 — 원격에서 고친
 * 줄이면 고친 줄의 같은 글 뒤에, 지운 줄이면 그 자리에 주석 줄로. 주석은 로컬에만 있는 글이라 버리지 않는다.
 *
 * 되살린 글은 push 가 주석을 다시 지우면 받은 글과 같은 것을 보내야 한다 — 아니면 되살리기만으로 Notion 의
 * 글이 바뀐다(문단이 붙거나 갈리고, 코드 속에 끼면 주석이 코드 글자로 올라간다). 그래서 push 의 눈으로
 * 견주고, 어긋나면 더 안전한 자리로 물린다: 지운 글 그대로 → 이웃이 로컬과 다른 자리만 이웃에 맞춘 주석 줄
 * → 본문 끝 → 본문 머리.
 */
export function restoreComments(pulled: string, local: string): string {
  // 받은 글은 LF 다 — CRLF 노트도 받으면 LF 로 쓰인다.
  const note = pulled.includes("\r") ? local : local.replace(/\r\n/g, "\n");
  const body = noteBody(note);
  const { content: strippedBody, cuts } = cutComments(body.text);
  if (cuts.length === 0) return pulled;

  const stripped =
    note.slice(0, body.start) + strippedBody + note.slice(body.start + body.text.length);
  if (stripped === pulled) return note;

  const placement = placeCuts(stripped, body.start, cuts, pulled);
  const sent = sentView(pulled);
  const fits = (restored: string) => sentView(restored) === sent;

  const original = assemble(placement, new Set());
  if (fits(original)) return original;
  // 이웃이 로컬과 다른 자리를 모두 맞춰 본 뒤, 지운 글 그대로 둬도 보낼 글이 같은 자리는 하나씩 되돌린다 —
  // 한 자리가 어긋났다고(Notion 이 콜아웃 속 빈 `>` 줄을 내보내지 않는다) 고친 줄 속 주석까지 줄 밖으로
  // 빼지 않는다.
  const loose = placement.spots.filter((spot) => !spot.exact || insideCode(placement, spot));
  let fitted = new Set(loose);
  if (fits(assemble(placement, fitted))) {
    for (const spot of loose.slice(0, SPOT_TRIAL_LIMIT)) {
      const trial = new Set(fitted);
      trial.delete(spot);
      if (fits(assemble(placement, trial))) fitted = trial;
    }
    return assemble(placement, fitted);
  }
  const end = gather(placement, "end");
  if (fits(end)) return end;
  // 본문 머리의 주석 줄은 코드 · frontmatter 밖이다 — 어디에도 맞지 않아도 주석을 버리지 않고 여기 둔다.
  return gather(placement, "start");
}

/** 이웃에 맞춘 자리를 지운 글 그대로 되돌려 보는 횟수 상한 — 한 번마다 노트 전체를 push 의 눈으로 본다. */
const SPOT_TRIAL_LIMIT = 50;

/**
 * push 가 보내는 꼴 — frontmatter 와, 주석을 지우고 빈 줄을 줄인 본문(`CommentStripper` ·
 * `BlankLineCollapser`). 본문 끝의 공백 · 머리의 빈 줄은 Notion 블록에 남지 않아 견주지 않는다. 머리 줄의
 * 들여쓰기는 견준다 — push 는 본문을 다듬은 뒤에 주석을 지워, 본문 머리의 주석 뒤 줄의 들여쓰기를 그대로
 * 보낸다(네 칸이면 코드 블록이 된다).
 */
function sentView(note: string): string {
  const body = noteBody(note);
  // 깨진 YAML 은 push 가 frontmatter 째 본문 글로 보낸다 — 글자가 같아도 속성으로 보내는 글과 다르다.
  const head = body.broken ? BROKEN_FRONTMATTER : note.slice(0, body.start).trimEnd();
  const sent = collapseBlankLines(cutComments(body.text).content);
  return `${head}\n${sent.replace(LEADING_BLANK_LINES_RE, "").trimEnd()}`;
}

/** 글 머리의 빈 줄들 — 공백만 있는 줄 포함. */
const LEADING_BLANK_LINES_RE = /^(?:[ \t]*\n)+/;

/** {@link sentView} 에서 frontmatter 를 읽지 못한 노트를 가르는 머리 — 노트 글에 나올 수 없는 글자. */
const BROKEN_FRONTMATTER = "\u0000broken-frontmatter";

/** 받은 글의 줄과, 주석마다 둘 자리. */
interface Placement {
  /** 받은 글의 줄 — 끝 줄바꿈 뒤의 빈 조각은 뺀다. */
  readonly lines: readonly string[];
  /** 받은 글이 줄바꿈으로 끝난다. */
  readonly trailing: boolean;
  /** 본문의 줄 `[bodyFirst, bodyEnd)` — frontmatter 와 앞뒤 빈 줄 밖(push 가 다듬어 보내는 글). */
  readonly bodyFirst: number;
  readonly bodyEnd: number;
  readonly fences: readonly CodeFence[];
  readonly spots: readonly Spot[];
}

/** 받은 글에서 주석 하나를 둘 자리. */
interface Spot {
  readonly cut: CommentCut;
  /** 줄로 끼우면 이 줄 앞에, 줄 속에 끼우면 이 줄에. */
  readonly line: number;
  /** 줄 속에 끼울 글자 자리 — 없으면 줄로 끼운다. */
  readonly col?: number;
  /** 로컬 노트와 이웃이 같은 자리 — 지운 글을 그대로 끼우면 그 부분이 로컬 노트와 같다. */
  readonly exact: boolean;
  /** 주석이 있던 줄의 줄머리(인용 표시 · 들여쓰기) — 줄 속 주석을 줄로 끼울 때 붙인다. */
  readonly prefix: string;
}

function placeCuts(
  stripped: string,
  bodyStart: number,
  cuts: readonly CommentCut[],
  pulled: string,
): Placement {
  const s = splitLines(stripped);
  const p = splitLines(pulled);
  const { match, edited } = alignNoteLines(s.lines, p.lines);
  // 로컬과 같은 줄 — 고친 줄로 맞춘 줄은 아니다.
  const same = (line: number) => match[line]! >= 0 && !edited[line];

  // 맞지 않는 줄이 든 구간 — 앞뒤의 맞는 줄 사이. 그 안은 비율로 옮긴다.
  const gap = (line: number) => {
    let lo = line;
    while (lo >= 0 && match[lo] === -1) lo--;
    let hi = line;
    while (hi < s.lines.length && match[hi] === -1) hi++;
    return {
      sFrom: lo + 1,
      sTo: hi,
      pFrom: lo >= 0 ? match[lo]! + 1 : 0,
      pTo: hi < s.lines.length ? match[hi]! : p.lines.length,
    };
  };
  const boundary = (line: number, side: "after" | "before") => {
    if (match[line]! >= 0) return match[line]! + (side === "after" ? 1 : 0);
    const g = gap(line);
    const at = line + (side === "after" ? 1 : 0) - g.sFrom;
    return g.pFrom + Math.round((at * (g.pTo - g.pFrom)) / Math.max(g.sTo - g.sFrom, 1));
  };

  const spots = cuts.map((cut): Spot => {
    const offset = bodyStart + cut.at;
    const line = upperBound(s.starts, offset) - 1;
    const prefix = CONTAINER_PREFIX_RE.exec(s.lines[line]!)![0];
    const matched = match[line]!;
    if (offset > s.starts[line]! + s.lines[line]!.length) {
      // 본문이 주석뿐이었다 — 지운 자리는 지운 뒤 글의 끝 줄바꿈 뒤, frontmatter 뒤다.
      const exact = same(line) && matched + 1 === p.lines.length;
      return { cut, line: boundary(line, "after"), exact, prefix };
    }
    if (cut.attach === "after") {
      const exact =
        same(line) &&
        (line + 1 < s.lines.length
          ? same(line + 1) && match[line + 1] === matched + 1
          : matched + 1 === p.lines.length);
      return { cut, line: boundary(line, "after"), exact, prefix };
    }
    if (cut.attach === "before") {
      const exact =
        same(line) &&
        (line > 0 ? same(line - 1) && match[line - 1] === matched - 1 : matched === 0);
      return { cut, line: boundary(line, "before"), exact, prefix };
    }
    const col = offset - s.starts[line]!;
    if (same(line)) return { cut, line: matched, col, exact: true, prefix };
    if (matched >= 0) {
      // 원격에서 고친 줄 — 고친 줄의 같은 글 뒤에.
      const target = p.lines[matched]!;
      return {
        cut,
        line: matched,
        col: mapOffset(s.lines[line]!, target, col),
        exact: false,
        prefix,
      };
    }
    const g = gap(line);
    // 원격에서 지운 줄 — 주석만 그 자리의 줄로 남긴다.
    if (g.pTo === g.pFrom) return { cut, line: g.pFrom, exact: false, prefix };
    const ratio = (line - g.sFrom) / Math.max(g.sTo - g.sFrom, 1);
    const target = Math.min(g.pFrom + Math.floor(ratio * (g.pTo - g.pFrom)), g.pTo - 1);
    return {
      cut,
      line: target,
      col: mapOffset(s.lines[line]!, p.lines[target]!, col),
      exact: false,
      prefix,
    };
  });

  const body = noteBody(pulled);
  const lineAt = (offset: number) => {
    const i = upperBound(p.starts, offset) - 1;
    return offset > p.starts[i]! + p.lines[i]!.length ? i + 1 : i;
  };
  // 빈 본문의 자리는 frontmatter 뒤다 — 끝 줄바꿈이 없으면 그 자리가 닫는 `---` 줄의 끝이라, 줄로 셈하면
  // 닫는 줄 앞(frontmatter 안)이 된다.
  const bodyFirst = body.text ? lineAt(body.start) : body.start > 0 ? p.lines.length : 0;
  return {
    lines: p.lines,
    trailing: p.trailing,
    bodyFirst,
    bodyEnd: body.text ? lineAt(body.start + body.text.length - 1) + 1 : bodyFirst,
    fences: scanCodeFences(pulled),
    spots,
  };
}

/** 고친 줄로 볼 만큼 비슷한 정도({@link lineSimilarity}). */
const EDITED_LINE_SIMILARITY = 0.5;
/** 고친 줄을 찾는 구간의 크기 상한(옛 줄 수 × 새 줄 수) — 넘으면 그 구간은 비율로만 옮긴다. */
const EDITED_LINE_SEARCH_LIMIT = 400;

/**
 * 두 글의 줄 맞춤 — 옛 줄마다 맞는 새 줄의 번호(없으면 -1), 고친 줄이면 `edited`. 번호는 늘어나기만 한다.
 *
 * 1. 글이 있는 같은 줄끼리 맞춘다 — 빈 줄은 어디에나 있어, 함께 맞추면 글 줄 대신 빈 줄을 맞춰 주석이
 *    엉뚱한 문단으로 간다.
 * 2. 맞춘 줄 사이에서 비슷한 줄을 차례로 고친 줄로 맞춘다 — 원격에서 고친 문단의 주석이 그 문단에 남는다.
 * 3. 맞춘 줄 사이의 나머지(빈 줄)를 맞춘다.
 */
function alignNoteLines(
  before: readonly string[],
  after: readonly string[],
): { match: number[]; edited: boolean[] } {
  const match = new Array<number>(before.length).fill(-1);
  const edited = new Array<boolean>(before.length).fill(false);
  const filledAt = (lines: readonly string[]) =>
    lines.flatMap((line, i) => (filled(line) ? [i] : []));
  const beforeFilled = filledAt(before);
  const afterFilled = filledAt(after);
  alignLines(
    beforeFilled.map((i) => before[i]!),
    afterFilled.map((i) => after[i]!),
  ).forEach((j, k) => {
    if (j >= 0) match[beforeFilled[k]!] = afterFilled[j]!;
  });

  forEachGap(match, after.length, (sFrom, sTo, pFrom, pTo) => {
    if ((sTo - sFrom) * (pTo - pFrom) > EDITED_LINE_SEARCH_LIMIT) return;
    let next = pFrom;
    for (let i = sFrom; i < sTo; i++) {
      if (!filled(before[i])) continue;
      let best = -1;
      let bestScore = 0;
      for (let j = next; j < pTo; j++) {
        if (!filled(after[j])) continue;
        const score = lineSimilarity(before[i]!, after[j]!);
        if (score >= EDITED_LINE_SIMILARITY && score > bestScore) {
          best = j;
          bestScore = score;
        }
      }
      if (best === -1) continue;
      match[i] = best;
      edited[i] = true;
      next = best + 1;
    }
  });

  forEachGap(match, after.length, (sFrom, sTo, pFrom, pTo) => {
    alignLines(before.slice(sFrom, sTo), after.slice(pFrom, pTo)).forEach((j, k) => {
      if (j >= 0) match[sFrom + k] = pFrom + j;
    });
  });
  return { match, edited };
}

/** 맞춘 줄 사이의 구간마다 — 옛 줄 `[sFrom, sTo)` · 새 줄 `[pFrom, pTo)`. 한쪽이 비면 건너뛴다. */
function forEachGap(
  match: readonly number[],
  afterLength: number,
  fn: (sFrom: number, sTo: number, pFrom: number, pTo: number) => void,
): void {
  let sFrom = 0;
  let pFrom = 0;
  for (let i = 0; i <= match.length; i++) {
    if (i < match.length && match[i] === -1) continue;
    const pTo = i < match.length ? match[i]! : afterLength;
    if (i > sFrom && pTo > pFrom) fn(sFrom, i, pFrom, pTo);
    sFrom = i + 1;
    pFrom = pTo + 1;
  }
}

/**
 * 자리마다 주석을 끼운 글. 지운 글을 그대로 끼운다 — 이웃이 로컬과 다른 자리는 인용 깊이만 맞춘다.
 * `fitted` 의 자리는 주석 줄로 바꿔 받은 글의 이웃에 맞춘다({@link fitLines}).
 */
function assemble(p: Placement, fitted: ReadonlySet<Spot>): string {
  const linesAt = new Map<number, string[]>();
  const inlineAt = new Map<number, Array<{ col: number; text: string }>>();
  const loose: Array<{ at: number; lines: string[] }> = [];
  for (const spot of p.spots) {
    const { cut } = spot;
    const own = cut.attach ? cut.block : spot.prefix + cut.block;
    if (fitted.has(spot)) {
      loose.push({
        at: spot.col === undefined ? spot.line : spot.line + 1,
        lines: own.split("\n"),
      });
    } else if (spot.col !== undefined) {
      inlineAt.set(spot.line, [
        ...(inlineAt.get(spot.line) ?? []),
        { col: spot.col, text: cut.text },
      ]);
    } else {
      const lines = !cut.attach
        ? own.split("\n")
        : cut.attach === "after"
          ? cut.text.slice(1).split("\n")
          : (cut.text.endsWith("\n") ? cut.text.slice(0, -1) : cut.text).split("\n");
      addLines(linesAt, spot.line, spot.exact ? lines : requote(lines, neighbor(p, spot.line)));
    }
  }
  for (const group of groupLoose(p, loose)) {
    addLines(linesAt, group.at, fitLines(p, group.at, group.lines));
  }
  return joinLines(p, linesAt, inlineAt);
}

/** 모든 주석을 한 덩어리로 본문 끝(또는 머리)에 둔다 — 제자리 어디에도 둘 수 없을 때. */
function gather(p: Placement, where: "end" | "start"): string {
  const lines = p.spots.flatMap((spot) =>
    requote((spot.cut.attach ? spot.cut.block : spot.prefix + spot.cut.block).split("\n"), ""),
  );
  const empty = p.bodyFirst === p.bodyEnd;
  const at = where === "end" ? p.bodyEnd : p.bodyFirst;
  return joinLines(
    p,
    new Map([[at, where === "end" && !empty ? ["", ...lines] : lines]]),
    new Map(),
  );
}

/** 줄로 끼울 자리가 코드 속이다 — 주석이 코드 글자가 된다. 줄 속에 끼울 자리면 펜스 줄도. */
function insideCode(p: Placement, spot: Spot): boolean {
  return p.fences.some((fence) =>
    spot.col === undefined
      ? fence.open < spot.line && (fence.close === null || spot.line <= fence.close)
      : fence.open <= spot.line && (fence.close === null || spot.line <= fence.close),
  );
}

/**
 * 줄로 끼울 주석들의 자리 — 본문 안 · 코드 밖으로 옮기고, 빈 줄만 사이에 둔 자리는 하나로 모은다. 따로
 * 두면 push 가 둘을 한 덩어리로 지우며 사이의 빈 줄까지 지운다.
 */
function groupLoose(
  p: Placement,
  loose: ReadonlyArray<{ at: number; lines: string[] }>,
): Array<{ at: number; lines: string[] }> {
  const placed = loose
    .map((item) => ({
      at: outsideCode(p, Math.min(Math.max(item.at, p.bodyFirst), p.bodyEnd)),
      lines: item.lines,
    }))
    .sort((a, b) => a.at - b.at);
  const groups: Array<{ at: number; lines: string[] }> = [];
  for (const item of placed) {
    const last = groups[groups.length - 1];
    if (last && p.lines.slice(last.at, item.at).every((line) => BLANKISH_RE.test(line))) {
      last.lines.push(...item.lines);
    } else {
      groups.push({ at: item.at, lines: [...item.lines] });
    }
  }
  return groups;
}

/** 코드 속 자리면 그 코드 뒤로 — 닫히지 않은 코드면 본문 끝. */
function outsideCode(p: Placement, at: number): number {
  for (const fence of p.fences) {
    if (fence.open < at && (fence.close === null || at <= fence.close)) {
      return fence.close === null ? p.bodyEnd : fence.close + 1;
    }
  }
  return at;
}

/**
 * 받은 글의 `at` 앞에 둘 주석 줄 — push 가 지우면 받은 글이 그대로 남는 꼴({@link lineCut}). 이웃이 모두
 * 빈 줄이면 push 는 빈 줄 하나를 함께 지우므로, 지울 빈 줄을 같이 둔다. 인용 깊이는 붙는 이웃에 맞춘다.
 */
function fitLines(p: Placement, at: number, lines: readonly string[]): string[] {
  const prev = at > p.bodyFirst ? p.lines[at - 1] : undefined;
  const next = at < p.bodyEnd ? p.lines[at] : undefined;
  const quoted = requote(lines, neighbor(p, at));
  if (filled(prev) || filled(next) || (prev === undefined && next === undefined)) return quoted;
  const empty = QUOTE_MARKS_RE.exec(quoted[0]!)![0].trimEnd();
  return endsContainer(prev, quoteDepth(quoted[0]!), next)
    ? [empty, ...quoted]
    : [...quoted, empty];
}

/**
 * `at` 앞에 둘 줄이 들어갈 컨테이너를 정하는 줄 — 바로 앞 줄(본문 머리면 빈 줄). 뒤 줄을 따르면 콜아웃
 * 첫 줄 앞에 둔 주석이 그 콜아웃의 첫 줄이 되어 콜아웃 머리(`[!note]`)를 밀어낸다.
 */
function neighbor(p: Placement, at: number): string {
  return at > p.bodyFirst ? p.lines[at - 1]! : "";
}

/** 줄머리의 인용 표시 — `>` 마다 뒤 공백 하나까지. */
const QUOTE_MARKS_RE = /^(?:[ \t]*>[ \t]?)*/;

/**
 * 주석 줄의 인용 깊이를 이웃 줄에 맞춘다 — 깊이가 다른 주석 줄은 Obsidian 에서 그 인용 · 콜아웃을 끊거나
 * 뒤 문단을 인용으로 끌어들인다. 깊이가 같으면 그대로.
 */
function requote(lines: readonly string[], to: string): string[] {
  const first = lines.find(filled);
  if (first === undefined || quoteDepth(first) === quoteDepth(to)) return [...lines];
  const mark = QUOTE_MARKS_RE.exec(to)![0].trimEnd();
  return lines.map((line) => {
    const rest = line.slice(QUOTE_MARKS_RE.exec(line)![0].length);
    return mark && rest ? `${mark} ${rest}` : mark + rest;
  });
}

function addLines(linesAt: Map<number, string[]>, at: number, lines: readonly string[]): void {
  linesAt.set(at, [...(linesAt.get(at) ?? []), ...lines]);
}

/** 받은 글의 줄에 끼울 줄 · 글을 끼워 다시 잇는다. */
function joinLines(
  p: Placement,
  linesAt: ReadonlyMap<number, readonly string[]>,
  inlineAt: ReadonlyMap<number, ReadonlyArray<{ col: number; text: string }>>,
): string {
  const out: string[] = [];
  for (let j = 0; j <= p.lines.length; j++) {
    out.push(...(linesAt.get(j) ?? []));
    if (j === p.lines.length) break;
    const line = p.lines[j]!;
    const inserts = inlineAt.get(j);
    if (!inserts) {
      out.push(line);
      continue;
    }
    let text = "";
    let last = 0;
    for (const { col, text: insert } of [...inserts].sort((a, b) => a.col - b.col)) {
      const at = Math.min(col, line.length);
      text += line.slice(last, at) + insert;
      last = at;
    }
    out.push(text + line.slice(last));
  }
  return out.join("\n") + (p.trailing ? "\n" : "");
}

/** 줄로 나눈 글 — 줄바꿈으로 끝나면 마지막 빈 조각은 줄이 아니라 `trailing` 이다. */
function splitLines(text: string): { lines: string[]; starts: number[]; trailing: boolean } {
  const lines = text.split("\n");
  const trailing = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  return { lines, starts: lineStarts(lines), trailing };
}

/** push 가 주석을 지우는 본문 — frontmatter 뒤, 앞뒤 공백을 걷은 글(`FrontmatterExtractor`). */
function noteBody(note: string): { start: number; text: string; broken: boolean } {
  let content = note;
  let broken = false;
  try {
    content = splitFrontmatter(note).content;
  } catch {
    // 깨진 YAML — push 도 frontmatter 를 떼지 못하고 글 전체를 본문으로 보낸다.
    broken = true;
  }
  const lead = content.length - content.trimStart().length;
  return { start: note.length - content.length + lead, text: content.trim(), broken };
}
