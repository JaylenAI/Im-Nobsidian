/**
 * 마크다운 본문에서 **건드리면 안 되는 구간**(코드 펜스·인라인 코드)을
 * 피해 치환을 적용하는 공용 가드 모음.
 *
 * 모든 `map*` 함수는 같은 계약을 따른다 — 콜백은 `(조각, 입력 기준 절대 offset)` 을 받고
 * 치환된 조각을 돌려준다. offset 을 넘기는 이유는 보존 마커 앵커(`computeAnchor`)처럼
 * **원문 위치**가 필요한 호출자가 있기 때문이다. offset 이 필요 없으면 무시하면 된다.
 */

/** 가드 콜백 — 조각과 입력 기준 절대 offset 을 받아 치환된 조각을 돌려준다. */
export type SegmentMapper = (segment: string, offset: number) => string;

/** 문단을 가르는 빈 줄 — 공백만 있는 줄도 빈 줄이다. */
const BLANK_LINE_RE = /\n[ \t]*\n/;

/**
 * 마커 재삽입용 앵커 — idx 직전의 같은 줄 접두(최대 32자)를, 줄 첫머리면 직전
 * 비어있지 않은 줄(최대 48자)을 돌려준다. push 시점 절대 offset 은 pull 산출물에서
 * 무의미하므로, 텍스트 앵커가 위치 복원의 1차 수단이 된다.
 */
export function computeAnchor(content: string, idx: number): string {
  const before = content.slice(Math.max(0, idx - 32), idx);
  const sameLine = before.split("\n").pop() ?? "";
  if (sameLine.trim().length >= 4) return sameLine;
  const prevLines = content.slice(0, idx).split("\n");
  for (let i = prevLines.length - 2; i >= 0; i--) {
    const line = prevLines[i]!.trim();
    if (line.length > 0) return line.slice(0, 48);
  }
  return "";
}

/** 코드 펜스를 여는 줄의 펜스 — 닫는 줄을 가리는 데 쓴다. */
export interface CodeFenceOpening {
  /** 펜스 문자 — 백틱 또는 물결. */
  readonly char: string;
  /** 펜스 길이 — 닫는 펜스는 이보다 짧을 수 없다. */
  readonly length: number;
  /** 들여쓰기 폭({@link indentWidth}). */
  readonly indent: number;
}

/** 여는 펜스 — 정보 문자열은 줄 끝 `\r`(CRLF 노트) 앞까지. */
const FENCE_OPEN_RE = /^([\t ]*)(`{3,}|~{3,})(.*)\r?$/;
/** 닫는 펜스 — 뒤에는 공백만. CRLF 노트의 줄 끝 `\r` 도 공백이다. */
const FENCE_CLOSE_RE = /^([\t ]*)(`{3,}|~{3,})[\t ]*\r?$/;

/** 수식 블록(`$$`)을 여닫는 줄 — 그 사이는 식이라 마크다운 구조로 읽지 않는다. */
export const MATH_FENCE_RE = /^[ \t]*\$\$\s*$/;

/** 각주 정의 줄(`[^이름]:`) — 열 0 에서만. */
export const FOOTNOTE_DEF_RE = /^\[\^[^\]]+\]:/;

/** 줄머리 들여쓰기의 폭 — 탭은 다음 4칸 경계까지 민다(CommonMark). */
export function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width = ch === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
}

/**
 * 코드 펜스를 여는 줄인가 — 들여쓰기 · 펜스 · 정보 문자열. 인용(`>`) 안의 펜스는 보지 않는다.
 * 백틱 펜스의 정보 문자열에 백틱이 있으면 펜스가 아니라 인라인 코드다(CommonMark).
 */
export function openCodeFence(line: string): CodeFenceOpening | null {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  const bar = m[2]!;
  if (bar[0] === "`" && m[3]!.includes("`")) return null;
  return { char: bar[0]!, length: bar.length, indent: indentWidth(m[1]!) };
}

/**
 * `open` 을 닫는 줄인가 — 같은 문자 · 여는 것 이상의 길이 · 뒤에 공백만 · 여는 쪽보다 3칸 넘게
 * 들여쓰지 않은 줄이다(CommonMark). 코드 속의 ```bash 같은 줄 · 여는 것보다 짧은 펜스 ·
 * 더 깊이 들여쓴 펜스는 코드다 — 이것들에서 닫으면 코드 뒷부분을 본문으로 다룬다(S-25).
 */
export function closesCodeFence(line: string, open: CodeFenceOpening): boolean {
  return closingFence(line, open) !== null;
}

/** {@link closesCodeFence} 의 판정 — 닫는 줄이면 펜스 앞 들여쓰기와 펜스 기호를 돌려준다. */
function closingFence(line: string, open: CodeFenceOpening): { lead: string; bar: string } | null {
  const m = FENCE_CLOSE_RE.exec(line);
  if (
    m === null ||
    m[2]![0] !== open.char ||
    m[2]!.length < open.length ||
    indentWidth(m[1]!) > open.indent + 3
  ) {
    return null;
  }
  return { lead: m[1]!, bar: m[2]! };
}

/**
 * Obsidian 노트의 코드 펜스 — push 가 언어를 Notion 이름으로 바꿔 보내고 pull 이 원래 표기로
 * 되살리는 단위(S-20)이자, 텍스트 치환이 비켜 가는 코드 구간({@link mapOutsideCodeFences}, S-26).
 *
 * 줄머리의 인용(`>`) · 들여쓰기 · 목록 표시를 떼고 판정한다 — 콜아웃 · 목록 안의 펜스가 흔하다.
 * push 는 이 판정으로 **줄을 고치므로** 확신이 없는 곳은 펜스로 보지 않는다(CommonMark):
 *  - 백틱 펜스의 정보 문자열에 백틱이 있으면 펜스가 아니라 인라인 코드다.
 *  - 닫는 펜스는 같은 인용 깊이에서 {@link closesCodeFence} 인 줄이다. 코드 속 들여쓴 ``` 줄이
 *    블록을 닫지 않는다.
 *  - 인용 깊이가 얕아지면 컨테이너가 끝난 것이다 — 그 펜스는 닫히지 않은 채 끝나고, 고치지 않는다.
 *    목록 표시로 연 펜스는 항목 글 자리보다 덜 들여쓴 줄(빈 줄 빼고)에서 항목과 함께 끝난다.
 */
export interface CodeFence {
  /** 여는 줄 번호(0부터). */
  readonly open: number;
  /** 닫는 줄 번호 — 닫히지 않았으면 null. */
  readonly close: number | null;
  /** 여는 줄에서 펜스 앞 — 인용 표시 · 들여쓰기 · 목록 표시. */
  readonly lead: string;
  /** 여는 펜스 기호(``` · ~~~~ …). */
  readonly bar: string;
  /** 정보 문자열 원문 — 펜스 바로 뒤부터 줄 끝까지. */
  readonly info: string;
  /** 닫는 줄에서 펜스 앞 — 닫히지 않았으면 null. */
  readonly closeLead: string | null;
  /** 닫는 펜스 기호 — 닫히지 않았으면 null. */
  readonly closeBar: string | null;
  /** 코드 줄 — 펜스의 인용 표시를 뗀 것. */
  readonly code: readonly string[];
}

/** 여는 펜스 — 인용 표시 · 들여쓰기 · 목록 표시 · 펜스 · 정보 문자열(줄 끝 `\r` 앞까지). */
const QUOTED_FENCE_OPEN_RE =
  /^((?:[\t ]*>)*)([\t ]*)((?:[-*+]|\d{1,9}[.)])[\t ]+)?(`{3,}|~{3,})(.*)\r?$/;
const QUOTE_MARK_RE = /^[\t ]*>/;
const LEADING_SPACE_RE = /^[\t ]*/;

/** 인용 표시를 `depth` 개 뗀다. 모자라면 null — 그 줄에서 컨테이너가 끝났다. */
function stripQuoteMarks(line: string, depth: number): { marks: string; rest: string } | null {
  let rest = line;
  for (let k = 0; k < depth; k++) {
    const mark = QUOTE_MARK_RE.exec(rest);
    if (!mark) return null;
    rest = rest.slice(mark[0].length);
  }
  return { marks: line.slice(0, line.length - rest.length), rest };
}

/** 문서의 코드 펜스를 위에서부터 차례로 찾는다. */
export function scanCodeFences(text: string): CodeFence[] {
  const lines = text.split("\n");
  const fences: CodeFence[] = [];

  for (let i = 0; i < lines.length; i++) {
    const open = QUOTED_FENCE_OPEN_RE.exec(lines[i]!);
    if (!open) continue;
    const [, quotes, pad, marker, bar, info] = open as unknown as [
      string,
      string,
      string,
      string | undefined,
      string,
      string,
    ];
    if (bar[0] === "`" && info.includes("`")) continue;

    const indent = pad + (marker ?? "");
    const opening: CodeFenceOpening = {
      char: bar[0]!,
      length: bar.length,
      indent: indentWidth(indent),
    };
    // 목록 항목의 글 자리 — 이보다 덜 들여쓴 줄에서 항목이 끝난다(CommonMark).
    const itemWidth = marker === undefined ? null : opening.indent;
    const depth = (quotes.match(/>/g) ?? []).length;
    const code: string[] = [];
    let close: number | null = null;
    let closeLead: string | null = null;
    let closeBar: string | null = null;
    let end = lines.length;

    for (let j = i + 1; j < lines.length; j++) {
      const stripped = stripQuoteMarks(lines[j]!, depth);
      if (
        !stripped ||
        (itemWidth !== null &&
          stripped.rest.trim() !== "" &&
          indentWidth(LEADING_SPACE_RE.exec(stripped.rest)![0]) < itemWidth)
      ) {
        end = j;
        break;
      }
      const shut = closingFence(stripped.rest, opening);
      if (shut) {
        close = j;
        closeLead = stripped.marks + shut.lead;
        closeBar = shut.bar;
        end = j + 1;
        break;
      }
      code.push(stripped.rest);
    }

    fences.push({
      open: i,
      close,
      lead: quotes + indent,
      bar,
      info,
      closeLead,
      closeBar,
      code,
    });
    // 닫히지 않았으면 컨테이너가 끝난 줄부터 다시 본다 — 그 줄이 새 펜스일 수 있다.
    i = end - 1;
  }

  return fences;
}

/**
 * 펜스 코드블록(``` / ~~~) 바깥 영역에만 변환 함수를 적용한다.
 *
 * 주석 제거·각주 이스케이프·이스케이프 정규화 같은 텍스트 치환이 코드블록
 * 내부 리터럴을 오염시키지 않도록 하는 공용 가드. 코드 구간은 {@link scanCodeFences} 로 찾는다 —
 * 콜아웃 · 인용 · 목록 안의 펜스도 코드다. 예전에는 줄머리 공백 뒤의 펜스만 보아, push 가 콜아웃
 * 속 코드의 HTML 주석을 지우고 pull 이 그 주석을 `>` 없이 되살려 콜아웃을 끊었다(S-26). 닫는 줄은
 * {@link closesCodeFence} 로 가린다 — 마크다운 예제를 담은 코드의 ```bash 줄에서 구간을 닫으면 그
 * 뒤 코드가 치환된다(S-25). 닫히지 않은 펜스는 그 컨테이너가 끝날 때까지 코드다.
 */
export function mapOutsideCodeFences(content: string, fn: SegmentMapper): string {
  const lines = content.split("\n");
  const inCode = codeLineMask(content);

  const out: string[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let pos = 0;

  const flush = () => {
    if (buffer.length > 0) {
      out.push(fn(buffer.join("\n"), bufferStart));
      buffer = [];
    }
  };

  for (const [i, line] of lines.entries()) {
    if (inCode[i]) {
      flush();
      out.push(line);
    } else {
      // 펜스가 끊기면 flush 되므로 버퍼는 항상 연속 구간 — 조각 내 offset 이 원문과 1:1.
      if (buffer.length === 0) bufferStart = pos;
      buffer.push(line);
    }
    pos += line.length + 1;
  }
  flush();
  return out.join("\n");
}

/** 줄마다 코드 펜스(여는 줄 · 코드 · 닫는 줄)인가 — {@link scanCodeFences} 의 구간. */
export function codeLineMask(content: string): boolean[] {
  const inCode = new Array<boolean>(content.split("\n").length).fill(false);
  for (const fence of scanCodeFences(content)) {
    const last = fence.close ?? fence.open + fence.code.length;
    for (let i = fence.open; i <= last; i++) inCode[i] = true;
  }
  return inCode;
}

/** 줄바꿈 셋 이상 — 빈 줄이 둘 이상 이어진 자리. */
const BLANK_RUN_RE = /\n{3,}/g;

/**
 * 코드 밖에서 이어진 빈 줄을 한 줄로 줄인다. 코드 속 빈 줄은 코드다 — 예전에는 문서 전체에서 줄여,
 * 함수 사이에 빈 줄 두 줄을 둔 파이썬 코드가 Notion 에서 한 줄이 됐다(S-27).
 */
export function collapseBlankLines(content: string): string {
  const inCode = codeLineMask(content);
  let line = 0;
  let scanned = 0;
  return content.replace(BLANK_RUN_RE, (run: string, offset: number) => {
    for (; scanned < offset; scanned++) if (content.charCodeAt(scanned) === 10) line++;
    // 줄바꿈 하나가 줄 하나를 끝낸다 — 첫 줄바꿈이 끝내는 줄(`line`) 뒤의 빈 줄들이 코드인가.
    for (let i = line + 1; i < line + run.length; i++) if (inCode[i]) return run;
    return "\n\n";
  });
}

/**
 * 인라인 코드(백틱 스팬) 바깥 영역에만 변환 함수를 적용한다.
 *
 * 백틱 개수가 같은 짝만 스팬으로 인정한다(CommonMark). 닫는 백틱이 없으면 코드가
 * 아니므로 평문으로 되돌린다 — 스팬으로 오인해 문서 나머지를 통째로 보호하면
 * 정작 필요한 치환이 조용히 누락된다.
 *
 * 같은 까닭으로 짝은 문단 안에서만 찾는다 — 인라인 코드는 빈 줄을 넘지 못한다(CommonMark).
 * 예전에는 두 문단에 하나씩 있는 홑 백틱을 짝으로 보고 그 사이를 통째로 코드로 여겨, 사이에
 * 있는 위키링크를 링크로 올리지 않았다.
 */
export function mapOutsideInlineCode(content: string, fn: SegmentMapper): string {
  let out = "";
  let plainStart = 0;

  for (let span = nextCodeSpan(content, 0); span; span = nextCodeSpan(content, span[1])) {
    out += fn(content.slice(plainStart, span[0]), plainStart);
    out += content.slice(span[0], span[1]);
    plainStart = span[1];
  }

  return out + fn(content.slice(plainStart), plainStart);
}

/**
 * `from` 부터 처음 «시작하는» 인라인 코드의 문자 구간(백틱 포함) — 짝짓는 규칙은
 * {@link mapOutsideInlineCode}. 다른 표기와 겹칠 때 먼저 시작한 쪽이 이기게 하려는 호출자가 쓴다
 * (CommonMark: 코드 스팬과 HTML 은 순위가 같다) — 코드를 먼저 떼면 주석 안의 백틱이 주석 밖 백틱과
 * 짝지어 주석을 가른다.
 */
export function nextCodeSpan(content: string, from: number): readonly [number, number] | null {
  let i = content.indexOf("`", from);
  while (i !== -1) {
    let run = 1;
    while (content[i + run] === "`") run += 1;
    const close = content.indexOf("`".repeat(run), i + run);
    if (close !== -1 && !BLANK_LINE_RE.test(content.slice(i + run, close))) {
      return [i, close + run] as const;
    }
    i = content.indexOf("`", i + run);
  }
  return null;
}

/**
 * 인라인 코드의 문자 구간 — {@link mapOutsideInlineCode} 가 비켜 가는 곳.
 *
 * 여는 태그와 닫는 태그 사이에 인라인 코드가 낀 서식(`<u>a \`b\` c</u>`)은 조각마다 치환하는
 * {@link mapOutsideCode} 로는 짝을 찾지 못한다. 치환은 글 전체에 걸고, 시작이 이 구간 안인 것만
 * 건너뛴다.
 */
export function inlineCodeRanges(content: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let pos = 0;
  mapOutsideInlineCode(content, (segment, offset) => {
    if (offset > pos) ranges.push([pos, offset] as const);
    pos = offset + segment.length;
    return segment;
  });
  return ranges;
}

/** 코드 펜스와 인라인 코드를 **둘 다** 피해 적용한다. */
export function mapOutsideCode(content: string, fn: SegmentMapper): string {
  return mapOutsideCodeFences(content, (segment, base) =>
    mapOutsideInlineCode(segment, (text, inner) => fn(text, base + inner)),
  );
}
