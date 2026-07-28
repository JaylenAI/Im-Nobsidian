/**
 * 컨테이너 구조 들여쓰기 SSOT — pull 의 dedent 와 push 의 indent 가 서로의 역함수임을
 * 한곳에서 보장한다. 토글/콜아웃/칼럼(enhanced-md-converter)과 토글 헤딩
 * (toggle-heading)이 같은 기준을 공유해야 왕복이 수렴한다.
 */

/**
 * 컨테이너 본문 한 줄의 성격. 들여쓰기를 **붙일 때도 뗄 때도** 같은 기준으로 갈라야
 * push/pull 이 서로의 역함수가 된다({@link indentContainerBody} 주석 참조).
 */
export type ContainerLineKind = "fence" | "code" | "prose";

/**
 * 컨테이너 접두 — 구조 들여쓰기와 인용 마커(`>`)가 겹쳐 붙은 줄머리의 정규식 원문.
 *
 * 컨테이너 안 내용을 다루는 변환기는 **반드시 이 접두를 떼고** 판정해야 한다. 열 0 에만
 * 앵커한 판정은 콜아웃/칼럼 안에서 조용히 무동작이 되고, 그 결과가 표 사망(결함⑧)·
 * 토글 소실(결함①) 같은 형태로 나타났다. 판정 후에는 같은 접두를 **모든 산출 줄**에
 * 다시 입혀야 컨테이너가 중간에 끊기지 않는다.
 */
export const CONTAINER_PREFIX_SOURCE = "[\\t ]*(?:>[\\t ]*)*";

const CONTAINER_PREFIX_RE = new RegExp(`^${CONTAINER_PREFIX_SOURCE}`);

/**
 * NFM 여는 태그의 정규식 원문 — **태그명이 정확히 끝나는 것**까지 확인한다.
 *
 * `<table[^>]*>` 처럼 이름 뒤를 열어 두면 `<table_of_contents color="gray"/>` 가 여는
 * 표로 잡힌다. 그러면 매치가 목차 태그에서 시작해 저 아래 첫 `</table>` 까지 삼켜,
 * 그 사이 본문이 통째로 표로 치환되며 사라진다(실측: 한 노트에서 128행 소실). NFM 은
 * `table`/`table_of_contents`, `synced_block`/`synced_block_reference`,
 * `column`/`columns` 처럼 접두가 겹치는 이름을 쓰므로 경계 확인이 선택이 아니다.
 *
 * @param name 정확히 일치해야 하는 태그명
 * @param attrs `"capture"` 면 속성부를 그룹으로 남긴다 — 값은 선행 공백을 포함한
 *   `' icon="💡"'` 또는 속성이 없을 때 `''`.
 */
export function nfmOpenTagSource(name: string, attrs: "capture" | "ignore" = "ignore"): string {
  return `<${name}${attrs === "capture" ? "(\\s[^>]*|)" : "(?:\\s[^>]*)?"}>`;
}

/** 줄을 컨테이너 접두와 실제 내용으로 가른다. */
export function splitContainerPrefix(line: string): { prefix: string; body: string } {
  const prefix = CONTAINER_PREFIX_RE.exec(line)?.[0] ?? "";
  return { prefix, body: line.slice(prefix.length) };
}

/**
 * 컨테이너(토글/콜아웃) 본문을 blockquote(`> `)로 감싸기 전에 적용하는 dedent.
 *
 * Notion Markdown API 는 `<details>`/callout 의 직계 자식을 중첩 깊이만큼 탭으로
 * 들여쓴다. 특히 **코드블록은 펜스 줄만 탭으로 들여쓰고 내부 코드 텍스트는 열 0 에
 * 그대로 둔다(비대칭 들여쓰기)** — 실제 Notion 출력에서 확인된 구조다:
 *
 * ```
 * <details>
 * <summary>제목</summary>
 * \t```javascript      ← 펜스만 탭 들여쓰기
 * 코드 본문 (열 0)      ← 내부 텍스트는 들여쓰기 없음
 * \t```
 * </details>
 * ```
 *
 * 이 들여쓰기를 둔 채 `> ` 를 붙이면 펜스가 `> \t``` ` 가 되어 CommonMark 펜스 규칙
 * (들여쓰기 ≤3칸, 탭=4칸)을 위반한다. 그러면 코드블록이 열리거나 닫히지 않아 렌더링이
 * 깨지고, 닫는 펜스가 무시되면 이후 본문 전체를 코드로 삼키는 cascade 가 된다(결함①).
 *
 * 공통 선행 들여쓰기만 제거하는 단순 dedent 는 이 비대칭 구조를 고치지 못한다(코드
 * 본문이 열 0 이라 공통 최소값이 0 → 무변경). **테이블도 동일한 비대칭**을 보인다:
 * `<table>` 태그만 깊게 들여쓰고 내부 `<tr>/<td>` 행은 열 0 에 둔다. 이 열 0 행이 공통
 * 최소값을 0 으로 끌어내려, 같은 본문의 형제 줄(리스트·문단)까지 구조적 탭을 못 벗는
 * prefix/탭 폭주가 된다(결함②). 따라서 코드블록·테이블 블록을 인식해 다르게 처리한다:
 *  - **경계 줄(코드펜스 / <table>·</table>)**: 선행 들여쓰기를 모두 제거해 열 0 으로 정렬.
 *  - **블록 내부(코드 본문 / 테이블 행)**: 의미·열정렬을 위해 원문 그대로 보존.
 *  - **그 외(산문)**: 공통 선행 들여쓰기만 제거(중첩 리스트 등 상대 들여쓰기는 보존).
 *    공통 최소값은 **산문 줄만**으로 계산하므로 열 0 의 코드·테이블 행에 오염되지 않는다.
 * 앞뒤 빈 줄은 정리하고, 공백만 있는 줄은 비운다.
 */
export function dedentContainerBody(text: string): string {
  const lines = text.split("\n");
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

  const blocks = scanContainerBlocks(lines);
  const kinds = kindsOf(lines, blocks);
  const widened = widenAmbiguousFences(lines, blocks);

  // 2패스: 산문 줄의 공통 선행 들여쓰기 계산(상대 들여쓰기 보존 — textwrap.dedent 의미론).
  let min = Infinity;
  lines.forEach((l, i) => {
    if (kinds[i] !== "prose" || l.trim() === "") return;
    min = Math.min(min, /^[\t ]*/.exec(l)![0].length);
  });
  if (!Number.isFinite(min)) min = 0;

  // 3패스: 경계(fence)→열0 정렬, 내부(code)→원문 보존, 산문(prose)→공통 들여쓰기 제거.
  return lines
    .map((l, i) => {
      if (l.trim() === "") return "";
      if (kinds[i] === "code") return l;
      if (kinds[i] === "fence") {
        // 구조 들여쓰기만 걷어내 접두(`>`)와 언어 정보는 남기고, 폭만 갈아 끼운다.
        const flat = l.replace(/^[\t ]+/, "");
        const bar = widened.get(i);
        return bar === undefined ? flat : flat.replace(/`{3,}|~{3,}/, bar);
      }
      return l.slice(min);
    })
    .join("\n");
}

/**
 * {@link dedentContainerBody} 의 **역함수** — 컨테이너 본문에 구조적 들여쓰기 한 단계를 입힌다.
 *
 * 핵심은 dedent 가 원문 그대로 보존하는 줄(코드블록 내부·테이블 행)에는 **탭을 붙이지
 * 않는 것**이다. 붙이면 pull 이 그 탭을 제 것으로 알고 벗기지 않아, 왕복마다 코드 본문에
 * 탭이 한 겹씩 쌓인다(콜아웃 안 코드펜스가 `> \t\t\tprint(…)` 로 무한히 자라는 래칫 —
 * 실볼트·프로브 3파일 실측). Notion Markdown API 자체도 코드/테이블 내부는 열 0 에 두는
 * 비대칭 구조를 쓰므로, 붙이지 않는 쪽이 정준형과도 일치한다.
 */
export function indentContainerBody(text: string, indent = "\t"): string {
  const lines = text.split("\n");
  const kinds = classifyContainerLines(lines);
  return lines
    .map((line, i) => (line === "" || kinds[i] === "code" ? line : indent + line))
    .join("\n");
}

/**
 * **폭을 이미 아는** 접두 한 겹만 벗긴다 — {@link indentContainerBody} 의 정확한 역함수.
 *
 * 공통 최소값을 계산하는 {@link dedentContainerBody} 와 달리, 붙인 폭을 아는 자리에서
 * 쓴다. 최소값 계산은 본문 전체가 한 단계 더 들여쓴 리스트일 때 **사용자가 쓴 상대
 * 들여쓰기까지** 벗겨 버리므로, 아는 폭이 있으면 이쪽이 안전하다. 코드블록 내부처럼
 * 애초에 접두가 붙지 않은 줄(비대칭 들여쓰기)은 그대로 둔다.
 */
export function stripContainerIndent(text: string, indent: string): string {
  if (indent === "") return text;
  return text
    .split("\n")
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join("\n");
}

/** 표를 여는 줄 — 이름 경계를 확인해 `<table_of_contents/>` 를 배제한다. */
const TABLE_OPEN_LINE_RE = new RegExp(`^[\\t ]*${nfmOpenTagSource("table")}`);

/** 코드펜스 한 줄의 구성요소 — 여는 펜스와 닫는 펜스를 같은 기준으로 견주기 위한 값. */
interface FenceLine {
  readonly indent: string;
  readonly char: string;
  readonly len: number;
  readonly info: string;
}

const FENCE_LINE_RE = /^([\t ]*)(`{3,}|~{3,})(.*)$/;

function matchFence(line: string): FenceLine | null {
  const m = FENCE_LINE_RE.exec(line);
  return m ? { indent: m[1]!, char: m[2]![0]!, len: m[2]!.length, info: m[3]! } : null;
}

/** 코드블록·표 한 덩어리의 경계. 끝까지 닫히지 않으면 `close` 가 `null`. */
interface ContainerBlock {
  readonly type: "code" | "table";
  readonly open: number;
  readonly close: number | null;
  /** `type === "code"` 일 때 여는 펜스의 구성요소. */
  readonly fence?: FenceLine;
}

/**
 * 여는 펜스의 짝을 찾는다 — **들여쓰기까지 같아야** 진짜 경계다.
 *
 * NFM 은 경계 펜스만 탭으로 들여쓰고 내용은 열 0 에 둔다(비대칭 들여쓰기). 그래서 문자·
 * 길이만 보고 닫으면, 코드 **내용**에 들어 있는 열 0 의 ``` 줄(프롬프트 템플릿·마크다운
 * 튜토리얼에 흔하다)이 블록을 조기에 닫아 이후 펜스가 통째로 한 칸씩 밀린다. 들여쓰기가
 * 어긋난 짝은 NFM 이 들여쓰기를 흘린 경우를 대비한 폴백으로만 쓴다.
 */
function findFenceClose(lines: readonly string[], start: number, open: FenceLine): number | null {
  let loose: number | null = null;
  for (let j = start + 1; j < lines.length; j++) {
    const f = matchFence(lines[j]!);
    if (!f || f.char !== open.char || f.len < open.len || f.info.trim() !== "") continue;
    if (f.indent === open.indent) return j;
    loose ??= j;
  }
  return loose;
}

/**
 * 컨테이너 본문을 코드블록·표 덩어리로 훑는다 — 줄 분류와 펜스 확장의 공통 기준.
 *
 * <table> 태그만 깊게 들여쓰고 내부 행은 열 0 인 비대칭 구조도 같은 방식으로 다룬다.
 */
function scanContainerBlocks(lines: readonly string[]): ContainerBlock[] {
  const blocks: ContainerBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = matchFence(lines[i]!);
    if (fence) {
      const close = findFenceClose(lines, i, fence);
      blocks.push({ type: "code", open: i, close, fence });
      i = close ?? lines.length;
      continue;
    }
    if (!TABLE_OPEN_LINE_RE.test(lines[i]!)) continue;
    if (/<\/table>/.test(lines[i]!)) {
      blocks.push({ type: "table", open: i, close: i });
      continue;
    }
    let close: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (!/<\/table>/.test(lines[j]!)) continue;
      close = j;
      break;
    }
    blocks.push({ type: "table", open: i, close });
    i = close ?? lines.length;
  }
  return blocks;
}

function kindsOf(lines: readonly string[], blocks: readonly ContainerBlock[]): ContainerLineKind[] {
  const kinds: ContainerLineKind[] = lines.map(() => "prose");
  for (const b of blocks) {
    kinds[b.open] = "fence";
    const end = b.close ?? lines.length;
    for (let j = b.open + 1; j < end; j++) kinds[j] = "code";
    if (b.close !== null && b.close !== b.open) kinds[b.close] = "fence";
  }
  return kinds;
}

/**
 * 경계 펜스를 **내용의 어떤 펜스보다도 긴** 펜스로 바꾼다.
 *
 * 경계 펜스는 열 0 으로 정렬해야 `> ` 를 붙여도 CommonMark 펜스 규칙(들여쓰기 ≤3칸)을
 * 지킨다. 그런데 그렇게 맞추는 순간 내용 안의 열 0 ``` 줄과 들여쓰기가 같아져, 옵시디언이
 * 경계와 내용을 가릴 근거를 잃는다. 펜스가 순서대로 짝지어지며 경계가 한 칸씩 밀리고,
 * 뒤따르는 본문이 통째로 코드블록에 삼켜진다(실측: 한 노트에서 코드블록 5→39개,
 * 8,200행 삼킴 — 사용자 화면에 `>` 가 날것으로 보이던 증상). CommonMark 는 **긴 펜스는
 * 그보다 짧은 펜스로 닫히지 않는다**고 규정하므로, 내용의 최장 펜스보다 한 칸 긴 펜스를
 * 쓰면 들여쓰기를 잃고도 경계가 복원된다.
 */
function widenAmbiguousFences(
  lines: readonly string[],
  blocks: readonly ContainerBlock[],
): Map<number, string> {
  const widened = new Map<number, string>();
  for (const b of blocks) {
    if (b.type !== "code" || !b.fence) continue;
    const end = b.close ?? lines.length;
    let longest = 0;
    for (let j = b.open + 1; j < end; j++) {
      const f = matchFence(lines[j]!);
      if (f?.char === b.fence.char) longest = Math.max(longest, f.len);
    }
    if (longest < b.fence.len) continue;
    const bar = b.fence.char.repeat(longest + 1);
    widened.set(b.open, bar);
    if (b.close !== null) widened.set(b.close, bar);
  }
  return widened;
}

/**
 * 코드블록 **내부**의 문자 구간 — 코드에 적힌 마크업을 구조로 오인하지 않기 위한 경계.
 *
 * 코드블록 내용 자체가 `<table>`·`<details>` 같은 마크업인 문서가 흔하다(스킨 예제,
 * 마크다운 튜토리얼). 전역 정규식으로 그 마크업을 변환하면 사용자가 적어 둔 예제 코드가
 * 통째로 표로 치환돼 사라진다 — 실측: 한 노트에서 `<table` 29→4, `<tr` 158→1.
 *
 * 문서 전체를 받으므로 콜아웃 본문은 이미 `> ` 가 붙어 있다. **판정만** 접두를 벗긴
 * 몸통으로 하고 구간은 원문 offset 으로 센다 — 접두를 경계의 일부로 삼으면
 * {@link indentContainerBody} 쪽 중첩 판정까지 흔들린다.
 */
export function codeInteriorRanges(text: string): Array<readonly [number, number]> {
  const lines = text.split("\n");
  const kinds = classifyContainerLines(lines.map((l) => splitContainerPrefix(l).body));
  const ranges: Array<readonly [number, number]> = [];
  let offset = 0;
  let start: number | null = null;
  lines.forEach((line, i) => {
    if (kinds[i] === "code" && start === null) start = offset;
    else if (kinds[i] !== "code" && start !== null) {
      ranges.push([start, offset] as const);
      start = null;
    }
    offset += line.length + 1;
  });
  if (start !== null) ranges.push([start, offset] as const);
  return ranges;
}

/** {@link codeInteriorRanges} 판정 — 전역 치환 콜백의 `offset` 을 그대로 넘긴다. */
export function isInsideRanges(
  ranges: readonly (readonly [number, number])[],
  offset: number,
): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * 코드블록·테이블 경계를 추적해 각 줄을 분류한다 —
 * {@link dedentContainerBody}(pull)와 {@link indentContainerBody}(push)의 공통 기준.
 */
export function classifyContainerLines(lines: readonly string[]): ContainerLineKind[] {
  return kindsOf(lines, scanContainerBlocks(lines));
}

/**
 * 각 줄이 속한 컨테이너 블록의 **마지막 줄** — 컨테이너 밖이면 자기 자신.
 *
 * 들여쓰기로 구간을 끊는 스캐너가 컨테이너를 **통째로** 건너뛰기 위한 값이다. NFM 은 경계
 * 태그만 들여쓰고 내부 줄은 열 0 에 두므로(비대칭 들여쓰기), 줄 단위 들여쓰기 판정은 코드
 * 첫 줄이나 **닫는 펜스**에서 구간을 잘못 끊는다. 닫는 줄이 구간 밖으로 밀려나면 그 자리에
 * 뒤따라 붙는 마커·본문이 사용자의 코드 **안으로** 들어간다.
 */
export function containerBlockEnds(lines: readonly string[]): number[] {
  const ends = lines.map((_, i) => i);
  for (const b of scanContainerBlocks(lines)) {
    const end = b.close ?? lines.length - 1;
    for (let j = b.open; j <= end; j++) ends[j] = end;
  }
  return ends;
}
