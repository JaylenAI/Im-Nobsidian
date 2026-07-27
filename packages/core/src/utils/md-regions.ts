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

/**
 * 펜스 코드블록(``` / ~~~) 바깥 영역에만 변환 함수를 적용한다.
 *
 * 주석 제거·각주 이스케이프·이스케이프 정규화 같은 텍스트 치환이 코드블록
 * 내부 리터럴을 오염시키지 않도록 하는 공용 가드.
 */
export function mapOutsideCodeFences(content: string, fn: SegmentMapper): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let pos = 0;
  let fence: string | null = null;

  const flush = () => {
    if (buffer.length > 0) {
      out.push(fn(buffer.join("\n"), bufferStart));
      buffer = [];
    }
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fence === null && fenceMatch) {
      flush();
      fence = fenceMatch[1]![0]!.repeat(3);
      out.push(line);
    } else if (fence !== null) {
      out.push(line);
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) {
        fence = null;
      }
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
    if (close === -1) {
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
