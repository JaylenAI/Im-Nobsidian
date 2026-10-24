/**
 * 인용 안에서 앞 블록에 이어 붙는 글 줄을 띄운다 — 목록 항목 · 안쪽 인용 바로 뒤의 글.
 *
 * Notion 은 콜아웃 · 토글 안의 블록을 빈 줄 없이 내보낸다. 목록 항목이나 안쪽 인용 바로 뒤의 글
 * 줄은 Notion 에서 따로 선 블록이다 — 블록 안의 줄바꿈은 `<br>` 로 온다(2026-10-04 실측). 그런데
 * Obsidian 은 이 줄을 앞 문단에 이어지는 줄(CommonMark lazy continuation)로 읽어 목록 항목 · 안쪽
 * 인용 안에 그린다(Obsidian 1.13.7 실측: 읽기 보기 · Live Preview 모두). 그래서 pull 은 그 사이에
 * 빈 인용 줄을 끼운다. push 는 그대로 보낸다 — Notion 은 콜아웃 · 토글 안의 빈 줄을 버린다(실측).
 *
 * 콜아웃 · 토글이 아닌 인용은 띄우지 않는다. Notion 은 인용의 `>` 한 줄을 인용 블록 하나로 읽어,
 * 빈 인용 줄은 빈 인용 블록이 된다(2026-10-04 실측). Notion 인용의 여러 줄 글은 `<br>` 로, 자식은 인용
 * 밖에 들여써서 오므로 인용 줄 사이에는 이어 붙을 목록 · 안쪽 인용이 없다.
 *
 * 표 · 빈 블록(`<br>`) 앞은 각 변환(`table.ts` · `empty-block.ts`)이 띄운다. 제목 · 구분선 · 인용 ·
 * 코드처럼 문단을 끊는 줄은 앞 문단에 이어 붙지 않는다.
 *
 * 맨 바깥 목록의 중첩 항목 바로 뒤 글(그 항목보다 얕은 자식)도 같은 이유로 앞 항목에 이어 보인다(C3).
 * 목록은 BlockSpacer 가 빈 줄을 걷으므로 BlockSpacer 가 {@link continuesListParagraph} 로 가려 빈 줄을
 * 남긴다. 빈 줄 말고는 Obsidian 이 이어 붙이기를 끊지 않는다 — 주석(`%%`) · HTML 주석 줄도 이어 붙는다
 * (Obsidian 1.13.7 실측 2026-10-21). 대가로 그 목록은 느슨한 목록(항목마다 문단 간격)이 된다 — 글이 엉뚱한
 * 항목 안에 보이는 것보다 낫다. push 는 그대로 보낸다 — Notion 은 빈 줄을 버린다.
 */
import { classifyContainerLines, splitContainerPrefix } from "./container-indent.js";
import { indentWidth, LIST_MARKER_SOURCE } from "../utils/md-regions.js";

/** 인용 접두 — 줄머리의 여백과 `>` 가 이어진 부분, 마지막 `>` 까지. */
const QUOTE_PREFIX_RE = /^[\t >]*>/;
const LIST_ITEM_RE = new RegExp(String.raw`^${LIST_MARKER_SOURCE}(?:[\t ]|$)`);
/**
 * 앞 문단에 이어 붙지 않는 줄 — 제목 · 인용 · 콜아웃 머리 · 구분선은 문단을 끊고, 표 · 빈 블록은 각
 * 변환이 띄우고, 보존 마커는 앞 블록에 붙어 있어야 한다.
 */
const NOT_LAZY_RE = /^(?:#{1,6}(?:[\t ]|$)|>|\[!|(?:[-*_][\t ]*){3,}$|\||<br\s*\/?>[\t ]*$|%%)/;
/** 문단이 아닌 줄 — 뒤 줄이 이어 붙을 문단이 없다. */
const NOT_PARAGRAPH_RE = /^(?:#{1,6}(?:[\t ]|$)|(?:[-*_][\t ]*){3,}$|\||<br\s*\/?>[\t ]*$|\$\$|%%)/;

/** 글이 있는 목록 항목 — 표시 뒤에 문단이 열린다. */
const LIST_PARAGRAPH_RE = new RegExp(String.raw`^${LIST_MARKER_SOURCE}[\t ]+\S`);
/** 코드 펜스 줄 — 목록 자식 코드의 닫는 펜스 뒤에는 이어 붙을 문단이 없다. */
const FENCE_LINE_RE = /^(?:`{3,}|~{3,})/;

/**
 * 목록 안에서 앞 줄의 문단에 이어 붙는 글 줄인가 — 더 깊은 항목(또는 그 항목의 자식 글) 바로 뒤에 그보다
 * 얕게 들여쓴 글 줄(C3). Notion 에서는 얕은 쪽 항목의 자식 블록인데, Obsidian 은 앞 문단에 이어 깊은 항목
 * 안에 그린다. 두 줄 모두 인용 밖이어야 한다.
 */
export function continuesListParagraph(previous: string, line: string): boolean {
  const prev = splitQuoted(previous);
  const current = splitQuoted(line);
  if (prev.quote !== "" || current.quote !== "") return false;
  if (current.body === "" || LIST_ITEM_RE.test(current.body) || NOT_LAZY_RE.test(current.body)) {
    return false;
  }
  if (prev.body === "" || NOT_PARAGRAPH_RE.test(prev.body) || FENCE_LINE_RE.test(prev.body)) {
    return false;
  }
  const width = indentWidth(current.indent);
  if (LIST_ITEM_RE.test(prev.body)) {
    return LIST_PARAGRAPH_RE.test(prev.body) && width <= indentWidth(prev.indent);
  }
  return width < indentWidth(prev.indent);
}

interface QuotedLine {
  /** 인용 접두 — 인용 밖이면 "". */
  readonly quote: string;
  /** 인용 접두 뒤의 들여쓰기. */
  readonly indent: string;
  readonly body: string;
}

function splitQuoted(line: string): QuotedLine {
  const quote = QUOTE_PREFIX_RE.exec(line)?.[0] ?? "";
  const rest = quote === "" ? line : line.slice(quote.length).replace(/^ /, "");
  const body = rest.trimStart();
  return { quote, indent: rest.slice(0, rest.length - body.length), body };
}

const depth = (quote: string) => quote.split(">").length - 1;

/** 앞 줄의 문단에 이어 붙는 줄인지 — 같은 인용의 목록 안 글 뒤, 또는 더 깊은 인용의 글 뒤. */
function continuesLazily(previous: QuotedLine, line: QuotedLine): boolean {
  if (line.quote === "" || line.body === "" || LIST_ITEM_RE.test(line.body)) return false;
  if (NOT_LAZY_RE.test(line.body)) return false;
  if (previous.body === "" || NOT_PARAGRAPH_RE.test(previous.body)) return false;
  if (previous.quote === line.quote) {
    const inList = LIST_ITEM_RE.test(previous.body) || previous.indent !== "";
    return inList && line.indent === "";
  }
  return depth(previous.quote) > depth(line.quote) && previous.quote.startsWith(line.quote);
}

/**
 * 그 인용이 콜아웃 · 토글인지 — 같은 인용(또는 그 안쪽)으로 이어진 줄을 거슬러 올라가, 맨 첫 줄이
 * 그 깊이의 콜아웃 머리(`[!…]`)면 그렇다.
 */
function inCallout(lines: readonly string[], at: number, quote: string): boolean {
  let start = at;
  while (start > 0 && splitQuoted(lines[start - 1]!).quote.startsWith(quote)) start--;
  const first = splitQuoted(lines[start]!);
  return first.quote === quote && first.body.startsWith("[!");
}

/** pull: 콜아웃 · 토글 안에서 앞 블록 문단에 이어 붙는 글 줄 앞에 빈 인용 줄을 끼운다. */
export function separateLazyContinuations(content: string): string {
  const lines = content.split("\n");
  const kinds = classifyContainerLines(lines.map((line) => splitContainerPrefix(line).body));
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (i > 0 && kinds[i] === "prose" && kinds[i - 1] === "prose") {
      const current = splitQuoted(line);
      if (
        continuesLazily(splitQuoted(lines[i - 1]!), current) &&
        inCallout(lines, i, current.quote)
      ) {
        out.push(current.quote);
      }
    }
    out.push(line);
  });
  return out.join("\n");
}
