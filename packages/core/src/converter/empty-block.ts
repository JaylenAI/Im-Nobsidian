/**
 * Notion 빈 블록(`<empty-block/>`) ↔ 볼트 `<br>` 줄.
 *
 * 예전 pull 은 빈 블록을 빈 줄로 바꿨다. 빈 줄은 마크다운에서 블록 경계일 뿐이라 Obsidian 에
 * 간격이 보이지 않고, push 때 Notion 이 빈 줄을 버려 빈 블록이 사라졌다. 목록 자식 빈 블록은
 * pull 에서부터 사라졌다(2026-10-04 실측).
 *
 * `<br>` 만 있는 줄은 Obsidian 읽기 보기 · Live Preview 둘 다 빈 줄 높이의 간격을 그린다 — 콜아웃
 * 안(`> <br>`)과 목록 자식에서도 같다(Obsidian 1.13.7 실측). 주석 마커(`%%…%%`)는 간격이 생기지
 * 않고 Live Preview 에 회색 글로 보여서 쓰지 않았다.
 *
 * `<br>` 줄은 앞뒤를 빈 줄로 띄워 둔다. 문단 뒤가 아닌 자리(제목 · 목록 뒤)의 `<br>` 줄은 HTML
 * 블록을 열고, HTML 블록은 빈 줄까지 이어져 뒤 줄의 서식 · 목록을 글자 그대로 보인다(Obsidian
 * 1.13.7 실측: 콜아웃 안 `## 제목` 바로 뒤). 맨 바깥은 BlockSpacer 가 블록마다 띄우고, 인용 안은
 * 여기서 빈 인용 줄(`>`)을 끼운다. 목록 자식은 띄우지 않는다 — 빈 줄이 목록 전체를 느슨한 목록으로
 * 바꾼다. 항목 문단 뒤의 `<br>` 은 그 문단의 줄바꿈이 된다.
 *
 * 코드 안의 글은 사용자가 적은 글자라 건드리지 않는다.
 */
import {
  CONTAINER_PREFIX_SOURCE,
  classifyContainerLines,
  splitContainerPrefix,
} from "./container-indent.js";

const EMPTY_BLOCK_LINE_RE = new RegExp(`^(${CONTAINER_PREFIX_SOURCE})<empty-block\\/>[\\t ]*$`);
const BREAK_LINE_RE = new RegExp(`^(${CONTAINER_PREFIX_SOURCE})<br\\s*\\/?>[\\t ]*$`);
const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])\s/;

/** 줄을 코드 밖에서만 바꾼다 — 판정은 컨테이너 접두를 뗀 몸통으로 한다. 한 줄이 여러 줄이 될 수 있다. */
function mapProseLines(
  content: string,
  map: (line: string, i: number, lines: readonly string[], out: readonly string[]) => string[],
): string {
  const lines = content.split("\n");
  const kinds = classifyContainerLines(lines.map((line) => splitContainerPrefix(line).body));
  const out: string[] = [];
  lines.forEach((line, i) =>
    out.push(...(kinds[i] === "prose" ? map(line, i, lines, out) : [line])),
  );
  return out.join("\n");
}

/** 접두를 인용 부분과 그 뒤 들여쓰기로 — `> \t` → [`> `, `\t`]. */
function splitQuote(prefix: string): readonly [string, string] {
  const at = prefix.lastIndexOf(">");
  if (at === -1) return ["", prefix];
  const quoteEnd = prefix[at + 1] === " " ? at + 2 : at + 1;
  return [prefix.slice(0, quoteEnd), prefix.slice(quoteEnd)];
}

/** 들여쓰기 깊이 — NFM 은 탭 하나, 볼트는 4칸이 한 단계다(BlockSpacer D4). */
function indentDepth(indent: string): number {
  const tabs = indent.split("\t").length - 1;
  return tabs + Math.floor((indent.length - tabs) / 4);
}

/**
 * 줄이 같은 인용 안에서 몇 탭 들여쓰였는지 — 인용 밖의 줄이면 `undefined`.
 * 안쪽 콜아웃 줄(`\t> …`)은 `>` 앞의 들여쓰기로 센다.
 */
function depthWithin(prefix: string, quote: string): number | undefined {
  const outer = quote.trimEnd();
  if (!prefix.startsWith(outer)) return undefined;
  const rest = outer === "" ? prefix : prefix.slice(outer.length).replace(/^ /, "");
  return indentDepth(/^[\t ]*/.exec(rest)![0]);
}

/**
 * 들여쓴 빈 블록이 목록 항목의 자식인지 — 위로 올라가 처음 만나는 더 얕은 줄이 목록 항목이면 그렇다.
 *
 * 목록 항목 아래 들여쓴 `<br>` 은 그 항목의 내용이 된다. 문단 아래에서 들여쓰면 Obsidian 이
 * 들여쓴 코드블록으로 읽어 `<br>` 글자가 보이므로, 그때는 들여쓰기를 뗀다.
 */
function isListChild(lines: readonly string[], at: number, quote: string, depth: number): boolean {
  for (let j = at - 1; j >= 0; j--) {
    const { prefix, body } = splitContainerPrefix(lines[j]!);
    if (body.trim() === "") continue;
    const lineDepth = depthWithin(prefix, quote);
    if (lineDepth === undefined) return false;
    if (lineDepth < depth) return LIST_ITEM_RE.test(body);
  }
  return false;
}

/** 같은 인용(또는 그 안쪽)의 글이 있는 줄인지 — 빈 인용 줄 · 인용 밖 줄은 아니다. */
function hasTextWithin(line: string | undefined, quote: string): boolean {
  return (
    line !== undefined && line.startsWith(quote) && splitContainerPrefix(line).body.trim() !== ""
  );
}

/**
 * pull: `<empty-block/>` 줄을 `<br>` 줄로. 인용 접두는 남긴다 — 지우면 거기서 콜아웃이 닫힌다
 * (실측: `건강검진.md` 등 3노트 9개 `<columns>` 소실). 접두는 인용 앞의 여백까지 받는다 — 목록 · 칼럼
 * 안 콜아웃의 `\t> <empty-block/>` 이 토큰 그대로 볼트에 새던 자리다(실측: `Creai LLM.md`).
 */
export function emptyBlocksToBreaks(content: string): string {
  return mapProseLines(content, (line, i, lines, out) => {
    const m = EMPTY_BLOCK_LINE_RE.exec(line);
    if (!m) return [line];
    const [quote, indent] = splitQuote(m[1]!);
    const depth = indentDepth(indent);
    const lead = quote === "" || quote.endsWith(" ") ? quote : `${quote} `;
    if (depth > 0 && isListChild(lines, i, quote, depth)) return [`${lead}${indent}<br>`];
    if (quote === "") return ["<br>"];
    const blank = quote.trimEnd();
    return [
      ...(hasTextWithin(out.at(-1), blank) ? [blank] : []),
      `${lead}<br>`,
      ...(hasTextWithin(lines[i + 1], blank) ? [blank] : []),
    ];
  });
}

/** push: `<br>` 만 있는 줄을 `<empty-block/>` 로 — {@link emptyBlocksToBreaks} 의 반대. */
export function breaksToEmptyBlocks(content: string): string {
  return mapProseLines(content, (line) => {
    const m = BREAK_LINE_RE.exec(line);
    return [m ? `${m[1]!}<empty-block/>` : line];
  });
}
