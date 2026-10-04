import { isNotionLanguage } from "./code-language.js";

/**
 * 코드 속 펜스 줄(S-22) — pull 쪽. Notion 코드 블록의 코드에 ``` 로 시작하는 줄이 있을 때.
 *
 * Notion 은 그런 코드를 펜스를 넓히지 않고 ``` 로 내보낸다(2026-10-04 실측). 맨 위 코드는 여는 줄 ·
 * 코드 · 닫는 줄이 모두 열 0 이라, CommonMark 로 읽으면 코드 속 첫 ``` 줄에서 블록이 닫힌다 — 코드
 * 뒷부분은 본문이 되고, 진짜 닫는 줄이 새 코드 블록을 열어 노트 끝까지 삼킨다. 컨테이너 안 코드는
 * 경계 펜스만 탭으로 들여써 가를 수 있지만, 그 들여쓰기는 변환 중에 떨어진다(토글 제목의 자식).
 *
 * 그래서 원시 export 에서, 들여쓰기가 남아 있을 때 코드 범위를 먼저 정하고 경계 펜스를 코드 속 어떤
 * 펜스보다 길게 넓힌다 — 그 뒤의 변환과 Obsidian 은 CommonMark 대로 읽어도 범위가 맞다.
 *
 * 범위는 Notion 이 내보내는 규칙으로 정한다.
 *  - 여는 줄은 탭 들여쓰기 · ``` · Notion 언어 이름이다(```javascript · ```plain text). 코드 속
 *    ```js 같은 줄은 여는 줄이 아니다.
 *  - 닫는 줄은 여는 줄과 들여쓰기가 같은 맨 ``` 이다.
 *  - 코드 줄은 컨테이너 깊이와 상관없이 열 0 에서 시작한다 — 컨테이너 안 코드는 경계 펜스와 같은
 *    들여쓰기의 맨 ``` 줄이 닫는 줄뿐이라 가장 가까운 것이 닫는 줄이다.
 *  - 코드 밖에 맨 ``` 줄은 없다 — 있으면 앞 블록을 너무 일찍 닫은 것이다.
 * 맨 위 코드는 규칙만으로 가를 수 없을 때가 있다 — 코드에 여는 줄 · 닫는 줄과 같은 모양의 줄이
 * 있으면 어디서 닫아도 규칙에 맞을 수 있다. 그런 블록이 있으면({@link needsCodeBlockTexts}) 호출측이
 * 블록 API 로 코드 블록의 글을 읽어 넘기고, 코드가 그 글과 같은 범위를 고른다. 없으면 규칙에 맞는
 * 가장 가까운 닫는 줄이다. 규칙에 맞게 읽을 수 없으면 손대지 않는다 — 예전처럼 둔다.
 */

/** Notion 이 여는 코드 펜스 — 탭 들여쓰기 · ``` · 언어 이름. */
const OPEN_RE = /^(\t*)```([^`]+)$/;
/** Notion 이 닫는 코드 펜스 — 탭 들여쓰기 · 맨 ```. */
const CLOSE_RE = /^(\t*)```$/;
/** CommonMark 가 펜스로 읽을 수 있는 코드 줄의 백틱. */
const BACKTICK_FENCE_RE = /^[\t ]*(`{3,})/;
/** 맨 위 블록의 들여쓰기 — 코드 줄과 같은 열이라 경계 펜스와 코드 줄을 모양으로 가를 수 없다. */
const TOP_LEVEL = "";

/** 여는 줄 · 닫는 줄로 읽힐 수 있는 줄. */
interface FenceMark {
  readonly line: number;
  readonly indent: string;
  readonly opens: boolean;
}

/** 코드 블록 하나의 여는 줄 · 닫는 줄 번호. */
interface CodeRange {
  readonly open: number;
  readonly close: number;
  readonly indent: string;
}

/**
 * 받은 본문에, 코드 블록의 글을 블록으로 읽어야 범위를 가를 수 있는 코드가 있는가 — 규칙에 맞는
 * 가장 가까운 닫는 줄로 정한 맨 위 코드 안에 여는 줄 · 닫는 줄 모양이 있으면 그렇다.
 */
export function needsCodeBlockTexts(nfm: string): boolean {
  if (!nfm.includes("```")) return false;
  const lines = nfm.split("\n");
  const marks = fenceMarks(lines);
  const ranges = codeRanges(lines, marks);
  if (ranges === null) return false;
  return ranges.some(
    (range) =>
      range.indent === TOP_LEVEL &&
      marks.some((m) => m.line > range.open && m.line < range.close && m.indent === TOP_LEVEL),
  );
}

/**
 * 코드에 ``` 로 시작하는 줄이 있는 코드 블록의 경계 펜스를, 코드 속 어떤 펜스보다 길게 넓힌다.
 *
 * @param codeTexts 페이지 코드 블록의 글(블록 API) — {@link needsCodeBlockTexts} 일 때 넘긴다.
 */
export function widenNestedCodeFences(nfm: string, codeTexts?: ReadonlySet<string>): string {
  if (!nfm.includes("```")) return nfm;
  const lines = nfm.split("\n");
  const ranges = codeRanges(lines, fenceMarks(lines), codeTexts);
  if (ranges === null) return nfm;

  let changed = false;
  for (const { open, close } of ranges) {
    const bar = fenceBarAbove(lines.slice(open + 1, close));
    if (bar === null) continue;
    lines[open] = lines[open]!.replace("```", bar);
    lines[close] = lines[close]!.replace("```", bar);
    changed = true;
  }
  return changed ? lines.join("\n") : nfm;
}

/**
 * 코드를 감쌀 백틱 펜스 — 코드 속 가장 긴 백틱 펜스보다 한 칸 길게. 코드에 ``` 로 시작하는 줄이
 * 없으면 null(``` 로 충분하다). CommonMark 는 긴 펜스를 그보다 짧은 펜스로 닫지 않는다.
 */
export function fenceBarAbove(code: readonly string[]): string | null {
  let longest = 0;
  for (const line of code) {
    longest = Math.max(longest, BACKTICK_FENCE_RE.exec(line)?.[1]!.length ?? 0);
  }
  return longest >= 3 ? "`".repeat(longest + 1) : null;
}

function fenceMarks(lines: readonly string[]): FenceMark[] {
  const marks: FenceMark[] = [];
  lines.forEach((line, i) => {
    const open = OPEN_RE.exec(line);
    if (open && isNotionLanguage(open[2]!)) {
      marks.push({ line: i, indent: open[1]!, opens: true });
      return;
    }
    const close = CLOSE_RE.exec(line);
    if (close) marks.push({ line: i, indent: close[1]!, opens: false });
  });
  return marks;
}

/**
 * 문서 끝까지 규칙에 맞게 읽히는 코드 범위들. 블록마다 코드가 `codeTexts` 의 글과 같은 닫는 줄을
 * 먼저, 없으면 가장 가까운 닫는 줄을 고른다. 규칙에 맞게 읽을 수 없으면 null.
 */
function codeRanges(
  lines: readonly string[],
  marks: readonly FenceMark[],
  codeTexts?: ReadonlySet<string>,
): CodeRange[] | null {
  const n = marks.length;
  const texts = codeTexts && { all: codeTexts, longest: longestText(codeTexts) };
  // fits[k] — k 번째 표시부터 문서 끝까지 규칙에 맞게 읽히는가. 닫는 줄을 고르려면 그 뒤가 맞는지
  // 알아야 하므로 뒤에서부터 채운다.
  const fits: boolean[] = new Array<boolean>(n + 1).fill(false);
  const closer: number[] = new Array<number>(n).fill(-1);
  fits[n] = true;
  for (let k = n - 1; k >= 0; k--) {
    if (!marks[k]!.opens) continue;
    closer[k] = chooseCloser(lines, marks, k, fits, texts);
    fits[k] = closer[k] !== -1;
  }
  if (!fits[0]) return null;

  const ranges: CodeRange[] = [];
  for (let k = 0; k < n; k = closer[k]! + 1) {
    const { line: open, indent } = marks[k]!;
    ranges.push({ open, close: marks[closer[k]!]!.line, indent });
  }
  return ranges;
}

/** 블록 API 로 읽은 코드 블록의 글과, 그 가운데 가장 긴 글의 길이. */
interface CodeTexts {
  readonly all: ReadonlySet<string>;
  readonly longest: number;
}

function longestText(texts: ReadonlySet<string>): number {
  let longest = 0;
  for (const text of texts) longest = Math.max(longest, text.length);
  return longest;
}

/** `k` 번째 표시(여는 줄)의 닫는 줄 — 표시 번호. 없으면 -1. */
function chooseCloser(
  lines: readonly string[],
  marks: readonly FenceMark[],
  k: number,
  fits: readonly boolean[],
  texts: CodeTexts | undefined,
): number {
  const { line: open, indent } = marks[k]!;
  let nearest = -1;
  for (let m = k + 1; m < marks.length; m++) {
    const mark = marks[m]!;
    if (mark.opens || mark.indent !== indent) continue;
    // 컨테이너 안 코드는 가장 가까운 것이 닫는 줄이다 — 그 뒤가 규칙에 어긋나면 건너뛰지 않고
    // 읽기를 그만둔다. 건너뛰면 뒤 블록을 삼킨다.
    if (indent !== TOP_LEVEL) return fits[m + 1] ? m : -1;
    if (!fits[m + 1]) continue;
    if (!texts) return m;
    if (nearest === -1) nearest = m;
    const code = lines.slice(open + 1, mark.line).join("\n");
    if (texts.all.has(code)) return m;
    // 코드는 닫는 줄이 멀수록 길어진다 — 어떤 글보다 길어졌으면 더 볼 것이 없다.
    if (code.length > texts.longest) break;
  }
  return nearest;
}
