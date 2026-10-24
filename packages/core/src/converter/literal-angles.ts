import { inlineCodeRanges, LIST_MARKER_SOURCE, mapOutsideCodeFences } from "../utils/md-regions.js";

/**
 * pull 쪽 — Notion 의 글 `<` · `>` 를 볼트에 쓸 모양으로 (이슈 #8).
 *
 * markdown API 는 코드 밖의 `<` · `>` 를 모두 `\<` · `\>` 로 준다(2026-10-25 실측 — 문단 · 굵은 글씨 · 제목 · 표 칸 ·
 * 인용 · 목록 · 할 일 · 콜아웃). 그대로 쓰면 노트의 `a -> b` 가 받을 때마다 `a -\> b` 로 바뀐다. Obsidian 화면은
 * 같지만 노트의 글이 달라져 git 이력 · 다른 도구에 남는다.
 *
 * 다음 둘은 이스케이프를 둔다 — 풀면 뜻이 바뀐다.
 *   - 줄 맨 앞(들여쓰기 · 인용 · 목록 표지 뒤)의 `\>` — 인용이 된다
 *   - 글자 · `/` · `!` · `?` 앞의 `\<` — HTML 태그 · 자동 링크가 된다(`a\<b` → `a<b` 는 `<b>` 의 시작)
 *
 * 코드 펜스 · 인라인 코드 안은 Notion 이 이스케이프하지 않으므로 손대지 않는다. 백슬래시가 짝수 개면
 * 글 백슬래시 뒤의 `<` · `>` 다.
 */
export function unescapeAngleBrackets(content: string): string {
  if (!content.includes("\\<") && !content.includes("\\>")) return content;
  return mapOutsideCodeFences(content, (segment) =>
    segment.split("\n").map(unescapeLine).join("\n"),
  );
}

/** 인용이나 목록 표지만 있는 줄머리 — 이 뒤의 `>` 는 인용을 연다. */
const BLOCK_PREFIX_RE = new RegExp(String.raw`^[ \t]*(?:(?:>|${LIST_MARKER_SOURCE})[ \t]*)*$`);
/** `<` 뒤에 오면 태그 · 자동 링크 · 주석을 여는 글자. */
const TAG_START_RE = /[A-Za-z/!?]/;

function unescapeLine(line: string): string {
  if (!line.includes("\\<") && !line.includes("\\>")) return line;
  const code = inlineCodeRanges(line);
  return line.replace(
    /(\\+)([<>])/g,
    (match: string, slashes: string, char: string, at: number) => {
      if (slashes.length % 2 === 0) return match;
      if (code.some(([start, end]) => at >= start && at < end)) return match;
      const escape = at + slashes.length - 1;
      if (char === ">" && BLOCK_PREFIX_RE.test(line.slice(0, escape))) return match;
      if (char === "<" && TAG_START_RE.test(line[at + match.length] ?? "")) return match;
      return `${slashes.slice(1)}${char}`;
    },
  );
}
