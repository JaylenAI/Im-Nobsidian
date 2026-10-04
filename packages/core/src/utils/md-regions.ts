import { MARKER_TOKEN_RE } from "../constants/markers.js";

/**
 * 마크다운 본문에서 **건드리면 안 되는 구간**(코드 펜스·인라인 코드·보존 마커)을
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
  const m = FENCE_CLOSE_RE.exec(line);
  return (
    m !== null &&
    m[2]![0] === open.char &&
    m[2]!.length >= open.length &&
    indentWidth(m[1]!) <= open.indent + 3
  );
}

/**
 * Obsidian 노트의 코드 펜스 — push 가 언어를 Notion 이름으로 바꿔 보내고 pull 이 원래 표기로
 * 되살리는 단위(S-20).
 *
 * 줄머리의 인용(`>`) · 들여쓰기 · 목록 표시를 떼고 판정한다 — 콜아웃 · 목록 안의 펜스가 흔하다.
 * push 는 이 판정으로 **줄을 고치므로** 확신이 없는 곳은 펜스로 보지 않는다(CommonMark):
 *  - 백틱 펜스의 정보 문자열에 백틱이 있으면 펜스가 아니라 인라인 코드다.
 *  - 닫는 펜스는 같은 문자 · 여는 것 이상 길이 · 뒤에 공백만 · 같은 인용 깊이 · 여는 쪽보다
 *    3칸 넘게 들여쓰지 않은 줄이다. 코드 속 들여쓴 ``` 줄이 블록을 닫지 않는다.
 *  - 인용 깊이가 얕아지면 컨테이너가 끝난 것이다 — 그 펜스는 닫히지 않은 채 끝나고, 고치지 않는다.
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

/** 여는 펜스 — 인용 표시 · 들여쓰기(+목록 표시) · 펜스 · 정보 문자열. */
const QUOTED_FENCE_OPEN_RE =
  /^((?:[\t ]*>)*)([\t ]*(?:(?:[-*+]|\d{1,9}[.)])[\t ]+)?)(`{3,}|~{3,})(.*)$/;
/** 인용 표시를 뗀 뒤의 닫는 펜스 — 들여쓰기 · 펜스 · 뒤 공백. */
const CLOSE_BODY_RE = /^([\t ]*)(`{3,}|~{3,})[\t ]*$/;
const QUOTE_MARK_RE = /^[\t ]*>/;

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
    const [, quotes, indent, bar, info] = open as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (bar[0] === "`" && info.includes("`")) continue;

    const depth = (quotes.match(/>/g) ?? []).length;
    const code: string[] = [];
    let close: number | null = null;
    let closeLead: string | null = null;
    let closeBar: string | null = null;
    let end = lines.length;

    for (let j = i + 1; j < lines.length; j++) {
      const stripped = stripQuoteMarks(lines[j]!, depth);
      if (!stripped) {
        end = j;
        break;
      }
      const shut = CLOSE_BODY_RE.exec(stripped.rest);
      if (
        shut &&
        shut[2]![0] === bar[0] &&
        shut[2]!.length >= bar.length &&
        shut[1]!.length <= indent.length + 3
      ) {
        close = j;
        closeLead = stripped.marks + shut[1]!;
        closeBar = shut[2]!;
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
 * 내부 리터럴을 오염시키지 않도록 하는 공용 가드. 닫는 줄은 {@link closesCodeFence} 로
 * 가린다 — 마크다운 예제를 담은 코드의 ```bash 줄에서 구간을 닫으면 그 뒤 코드가 치환된다.
 */
export function mapOutsideCodeFences(content: string, fn: SegmentMapper): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let pos = 0;
  let fence: CodeFenceOpening | null = null;

  const flush = () => {
    if (buffer.length > 0) {
      out.push(fn(buffer.join("\n"), bufferStart));
      buffer = [];
    }
  };

  for (const line of lines) {
    const opening: CodeFenceOpening | null = fence === null ? openCodeFence(line) : null;
    if (opening) {
      flush();
      fence = opening;
      out.push(line);
    } else if (fence !== null) {
      out.push(line);
      if (closesCodeFence(line, fence)) fence = null;
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
  let i = 0;

  while (i < content.length) {
    if (content[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 1;
    while (content[i + run] === "`") run += 1;
    const close = content.indexOf("`".repeat(run), i + run);
    if (close === -1 || BLANK_LINE_RE.test(content.slice(i + run, close))) {
      i += run;
      continue;
    }
    out += fn(content.slice(plainStart, i), plainStart);
    out += content.slice(i, close + run);
    i = close + run;
    plainStart = i;
  }

  return out + fn(content.slice(plainStart), plainStart);
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

/**
 * 브랜드 보존 마커 토큰 바깥 영역에만 변환 함수를 적용한다.
 *
 * `%%` 를 위치로만 짝짓는 스캐너는 마커의 구분자를 자기 구분자로 오인해 본문을
 * 삼킨다(D-COMMENT-PAIR, {@link MARKER_TOKEN_RE} 주석에 실측 사례). 마커 토큰을 먼저
 * 떼어 내고 남은 평문 조각에만 적용하면 그 오인이 구조적으로 불가능해진다.
 */
export function mapOutsideMarkers(content: string, fn: SegmentMapper): string {
  const re = new RegExp(MARKER_TOKEN_RE.source, "g");
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    out += fn(content.slice(last, match.index), last);
    out += match[0];
    last = match.index + match[0].length;
  }

  return out + fn(content.slice(last), last);
}
