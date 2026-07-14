import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND } from "../../constants/markers.js";

/**
 * 블록 간격 정규화(D1) — Notion markdown export 는 블록 사이 빈 줄이 없는 압축형이라
 * 그대로 저장하면 (1) 인접 문단이 CommonMark lazy continuation 으로 한 문단으로 병합되고
 * (2) 인접 콜아웃이 하나의 콜아웃으로 합쳐진다. 재push 시 실제 병합이 일어나는
 * ping-pong 손상이므로 표준 마크다운 간격(블록 사이 빈 줄 1개)으로 되살린다.
 *
 * 묶음 유지(내부 빈 줄 없음): 리스트 연속(중첩·들여쓴 하위 내용 포함), 인용 연속
 * (단 `> [!type]` 콜아웃 시작은 새 블록), 표 행 연속, 각주 정의(`[^n]:`) 연속,
 * 펜스(``` ~~~ $$) 내부, 브랜드 보존 마커 줄(직전 블록에 부착 — 앵커 인접성 유지).
 *
 * 들여쓰기 정규화(D4): export 는 리스트 중첩에 탭을 쓴다. Obsidian/작성 관행의
 * 4-space 로 통일한다(펜스 내부 제외).
 *
 * 압축형 감지: 1차 신호는 `metadata.notionExportCompact` — orchestrator 가 **원시**
 * export(enhanced 변환 전)에서 `isCompactExport` 로 판정해 전달한다. 원시 export 는
 * 펜스 밖 빈 줄이 0 개지만(실측: v2 torture 89줄·f14 239줄), 노션의 명시적 빈 문단
 * 블록 `<empty-block/>` 이 enhanced 변환(removeEmptyBlocks)에서 빈 줄로 바뀌므로
 * 파이프라인 도착 시점의 내용만으로는 압축형을 오판한다(f14 실측: 빈 줄 6개로 스킵).
 * 플래그 미지정(오프라인 왕복, 테스트, blocks-API 폴백) 시에만 내용 기반 휴리스틱
 * — 펜스 밖 빈 줄이 하나라도 있으면 저작형으로 보고 무동작 — 으로 폴백한다.
 * 저작형 문서의 hard-wrap 문단·마커 주변 간격을 재그룹핑으로 파손하지 않기 위함.
 *
 * 한계: Notion 문단 내부 soft break(shift+enter)로 생긴 다중 행은 문단 경계와
 * 구분 불가능해 별개 문단으로 분리된다.
 *
 * pull 전용, order 110 — PreserveMarkerInjector(100)가 앵커 기준으로 삽입을 끝낸
 * 뒤에 간격만 손대야 앵커 오프셋 계산과 충돌하지 않는다.
 */
export class BlockSpacer implements Processor {
  readonly name = "BlockSpacer";
  readonly order = 110;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }
    return {
      content: respace(input.content, input.metadata.notionExportCompact),
      metadata: input.metadata,
    };
  }
}

type BlockKind = "list" | "quote" | "table" | "footnote" | "fence" | "math" | "other";

const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])\s/;
const QUOTE_RE = /^[ \t]*>/;
const CALLOUT_START_RE = /^[ \t]*>\s*\[![^\]]*\]/;
const TABLE_ROW_RE = /^[ \t]*\|/;
const FOOTNOTE_DEF_RE = /^\[\^[^\]]+\]:/;
const FENCE_RE = /^[ \t]*(```+|~~~+)/;
const MATH_FENCE_RE = /^[ \t]*\$\$\s*$/;
const BRAND_MARKER_LINE_RE = new RegExp(`^[ \\t]*%%\\s*${MARKER_BRAND}:`);

/** 리스트 항목 아래 들여쓴 연속 내용(자식 문단 등)인지 — 리스트 블록에 묶는다. */
const INDENTED_CONTINUATION_RE = /^(?:\t| {2,})\S/;

export function respace(content: string, sourceCompact?: boolean): string {
  // 원시 export 가 간격 있는 문서였다면(blocks-API 폴백 등) 무동작
  if (sourceCompact === false) return content;

  const lines = content.split("\n");

  // 선두 프론트매터는 원형 보존
  const head: string[] = [];
  let start = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        for (let j = 0; j <= i; j++) head.push(lines[j]!);
        start = i + 1;
        break;
      }
    }
  }

  // 압축형 감지 휴리스틱(플래그 미지정 시 폴백) — 간격이 이미 있는 문서는 손대지 않는다.
  // sourceCompact === true 면 orchestrator 가 원시 export 로 이미 판정했으므로 건너뛴다
  // (enhanced 변환의 <empty-block/>→빈 줄 치환이 휴리스틱을 오판시키는 것을 차단, D1).
  if (sourceCompact === undefined && hasBlankOutsideFences(lines, start)) return content;

  // 블록 그룹핑
  const blocks: { kind: BlockKind; lines: string[] }[] = [];
  let fence: "code" | "math" | null = null;
  let fenceToken = "";
  // 압축 export 의 빈 줄은 <empty-block/>(명시적 빈 문단) 유래 — 사용자가 의도한
  // 블록 경계다. 다음 줄이 같은 종류라도 직전 블록에 붙이지 않는다(리스트/인용 재병합 방지).
  let boundary = false;

  const push = (kind: BlockKind, line: string) => {
    blocks.push({ kind, lines: [line] });
  };
  const appendToLast = (line: string) => {
    blocks[blocks.length - 1]!.lines.push(line);
  };
  const last = () => blocks[blocks.length - 1];

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;

    if (fence !== null) {
      appendToLast(raw);
      const closed =
        fence === "code"
          ? FENCE_RE.test(raw) && raw.trim().startsWith(fenceToken)
          : MATH_FENCE_RE.test(raw);
      if (closed) fence = null;
      continue;
    }

    if (raw.trim() === "") {
      boundary = true; // 경계 신호만 남기고 간격은 재계산한다
      continue;
    }
    const atBoundary = boundary;
    boundary = false;

    const fenceMatch = raw.match(FENCE_RE);
    if (fenceMatch) {
      push("fence", raw);
      fence = "code";
      fenceToken = fenceMatch[1]![0]!.repeat(3);
      continue;
    }
    if (MATH_FENCE_RE.test(raw)) {
      push("math", raw);
      fence = "math";
      continue;
    }

    // 리스트 들여쓰기 탭 → 4-space (펜스 밖 리스트/연속 줄만)
    const line =
      LIST_ITEM_RE.test(raw) || INDENTED_CONTINUATION_RE.test(raw)
        ? raw.replace(/^\t+/, (t) => "    ".repeat(t.length))
        : raw;

    if (BRAND_MARKER_LINE_RE.test(line) && blocks.length > 0) {
      appendToLast(line); // 보존 마커는 앵커(직전 블록)에 부착 — 경계보다 앵커 인접성 우선
      continue;
    }
    if (LIST_ITEM_RE.test(line)) {
      if (last()?.kind === "list" && !atBoundary) appendToLast(line);
      else push("list", line);
      continue;
    }
    if (last()?.kind === "list" && INDENTED_CONTINUATION_RE.test(line)) {
      // 경계 무시하고 리스트에 부착 — 분리하면 4-space 들여쓴 줄이 코드 블록으로 오파싱된다
      appendToLast(line);
      continue;
    }
    if (QUOTE_RE.test(line)) {
      if (last()?.kind === "quote" && !CALLOUT_START_RE.test(line) && !atBoundary) {
        appendToLast(line);
      } else {
        push("quote", line);
      }
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      if (last()?.kind === "table" && !atBoundary) appendToLast(line);
      else push("table", line);
      continue;
    }
    if (FOOTNOTE_DEF_RE.test(line)) {
      if (last()?.kind === "footnote" && !atBoundary) appendToLast(line);
      else push("footnote", line);
      continue;
    }
    push("other", line);
  }

  const body = blocks.map((b) => b.lines.join("\n")).join("\n\n");
  const tail = content.endsWith("\n") ? "\n" : "";
  if (head.length === 0) return body + tail;
  return `${head.join("\n")}\n\n${body}${tail}`;
}

/**
 * 원시 Notion markdown export 의 압축형 판정 — orchestrator 가 `notionEnhancedToObsidian`
 * **호출 전**(즉 `<empty-block/>` 이 아직 토큰인 시점)에 사용해 `metadata.notionExportCompact`
 * 로 전달한다. 압축 export 는 펜스 밖 빈 줄이 0 개다(빈 문단은 `<empty-block/>` 토큰이라
 * 빈 줄로 계수되지 않음). 프론트매터는 export 에 존재하지 않으므로 고려하지 않는다.
 */
export function isCompactExport(rawMarkdown: string): boolean {
  return !hasBlankOutsideFences(rawMarkdown.split("\n"), 0);
}

/** 프론트매터 뒤~말미 빈 줄 앞 구간에서 펜스 밖 빈 줄 존재 여부(압축형 판정). */
function hasBlankOutsideFences(lines: string[], start: number): boolean {
  let end = lines.length - 1;
  while (end >= start && lines[end]!.trim() === "") end--;

  let fence: "code" | "math" | null = null;
  let fenceToken = "";
  for (let i = start; i <= end; i++) {
    const raw = lines[i]!;
    if (fence !== null) {
      const closed =
        fence === "code"
          ? FENCE_RE.test(raw) && raw.trim().startsWith(fenceToken)
          : MATH_FENCE_RE.test(raw);
      if (closed) fence = null;
      continue;
    }
    const fenceMatch = raw.match(FENCE_RE);
    if (fenceMatch) {
      fence = "code";
      fenceToken = fenceMatch[1]![0]!.repeat(3);
      continue;
    }
    if (MATH_FENCE_RE.test(raw)) {
      fence = "math";
      continue;
    }
    if (raw.trim() === "") return true;
  }
  return false;
}
