/**
 * 인용/콜아웃 들여쓰기 클램프 SSOT — pull 이 구조적 들여쓰기를 "렌더 가능한 폭"으로
 * 눌러 두고, push 가 그 폭을 다시 탭 깊이로 되돌린다.
 *
 * 왜 필요한가: Notion 은 리스트·칼럼 안의 토글/콜아웃을 **탭 한 단계 들여쓴** 컨테이너
 * 태그로 내보낸다. 그대로 `> [!toggle]-` 로 바꾸면 줄머리가 탭(= 4칸)이 되는데, Obsidian 은
 * 들여쓰기 4칸 이상인 줄을 **들여쓰기 코드블록**으로 파싱한다. 그래서 콜아웃이 렌더되지
 * 않고 `>` 가 그대로 보이는 회색 상자로 죽는다(결함① — 실볼트 676건·65노트).
 *
 * "리스트 자식이면 상대 들여쓰기라 괜찮지 않나"는 성립하지 않는다. CommonMark(remark)는
 * `- 부모` 아래 4칸 인용을 유효한 blockquote 로 파싱하지만, 실볼트에서 깨진 콜아웃의
 * 부모를 전수 조사한 결과 **전부 리스트 자식**이었다(`Creai LLM.md` 24·251·563·679·761·
 * 843·928행 등). 즉 Obsidian 은 **절대 들여쓰기**로 판정한다. 안전한 폭은 3칸 이하뿐이다.
 *
 * 해법: 들여쓴 인용 런(run)의 선행 여백을 {@link CLAMPED_INDENT}(2칸)로 통일한다.
 * 2칸은 코드블록 임계(4칸) 아래이면서 리스트 자식 위치를 유지해 시각적 중첩도 남는다
 * (열 0 으로 내리면 렌더는 되지만 부모 리스트에서 떨어져 나온다).
 *
 * 깊이는 "2칸 = 한 단계"를 관례로 삼고 두 단계 이상일 때만 마커로 싣는다 —
 * 실볼트 콜아웃 머리줄 699개의 깊이 분포가 d1=691·d2=7·d3=1 이라 98.9% 가 마커 없이
 * 왕복한다({@link calloutIndentMarker} 주석 참조).
 */
import { MARKER_BRAND_RE, calloutIndentMarker } from "../constants/markers.js";
import { classifyContainerLines, indentContainerBody } from "./container-indent.js";

/** 클램프된 인용 들여쓰기 — 코드블록 임계 미만이면서 리스트 자식 위치를 유지하는 폭. */
export const CLAMPED_INDENT = "  ";

/** Obsidian(CommonMark)이 들여쓰기 코드블록으로 오파싱하기 시작하는 폭. 탭 = 4칸. */
const CODE_INDENT_WIDTH = 4;

/** 들여쓴 인용 줄. 여기서 잡히는 여백이 곧 컨테이너의 구조적 들여쓰기다. */
const INDENTED_QUOTE_RE = /^([\t ]+)>/;

/** 콜아웃 머리줄 — 깊이 마커를 실을 수 있는 유일한 자리. */
const CALLOUT_HEAD_RE = /^> \[!\w+\][-+]?/;

/** push 가 제목에서 떼어내는 깊이 마커. */
const CALLOUT_INDENT_MARKER_RE = new RegExp(`\\s*%%${MARKER_BRAND_RE}:callout-indent:(\\d+)%%`);

/** 탭을 4칸 탭스톱으로 펼친 시각적 폭 — Obsidian 의 코드블록 판정과 같은 기준. */
function visualWidth(ws: string): number {
  let width = 0;
  for (const ch of ws)
    width = ch === "\t" ? width + CODE_INDENT_WIDTH - (width % CODE_INDENT_WIDTH) : width + 1;
  return width;
}

// ─── Pull: 구조적 들여쓰기 → 클램프된 폭 ───

/**
 * 들여쓴 인용/콜아웃 런의 선행 여백을 {@link CLAMPED_INDENT} 로 클램프한다.
 *
 * pull 파이프라인의 **마지막**에 놓는다 — 앞선 변환기(`convertContainers`,
 * `ensureCalloutContinuity`, `separateAdjacentCallouts`)는 모두 탭 기준 들여쓰기를 전제로
 * 하므로, 클램프를 먼저 걸면 그쪽 경계 판정이 어긋난다.
 *
 * 펜스 코드블록 **안**은 건드리지 않는다. 코드 리터럴로 적어 둔 `    > …` 를 바꾸면
 * 사용자가 쓴 예제가 훼손된다.
 */
export function clampCalloutIndent(content: string): string {
  const lines = content.split("\n");
  const kinds = classifyContainerLines(lines);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const indent = kinds[i] === "prose" ? (INDENTED_QUOTE_RE.exec(lines[i]!)?.[1] ?? null) : null;
    if (indent === null || visualWidth(indent) < CODE_INDENT_WIDTH) {
      out.push(lines[i]!);
      continue;
    }

    // 런 = 같은 선행 여백으로 시작하는 연속 인용 줄. 컨테이너 변환(`reindentLines`)이
    // 한 컨테이너의 모든 줄에 같은 들여쓰기를 균일하게 입히므로 이 경계가 곧 컨테이너
    // 경계다. 여백이 다른 줄에서 끊어야 이웃 컨테이너를 제 것으로 삼키지 않는다.
    let end = i;
    while (
      end + 1 < lines.length &&
      kinds[end + 1] === "prose" &&
      lines[end + 1]!.startsWith(`${indent}>`)
    ) {
      end++;
    }

    const depth = Math.floor(visualWidth(indent) / CODE_INDENT_WIDTH);
    const head = lines[i]!.slice(indent.length);
    // 깊이 마커는 콜아웃 머리줄에만 싣는다. 평범한 인용 줄에 붙이면 본문 텍스트를
    // 오염시키고, push 에 그 마커를 떼어 낼 전용 변환기도 없다(실볼트 해당 5줄 —
    // 깊이가 1 로 degrade 되지만 렌더는 정상화된다).
    const marked =
      depth > 1 && CALLOUT_HEAD_RE.test(head) ? `${head} ${calloutIndentMarker(depth)}` : head;

    out.push(CLAMPED_INDENT + marked);
    for (let j = i + 1; j <= end; j++) out.push(CLAMPED_INDENT + lines[j]!.slice(indent.length));
    i = end;
  }

  return out.join("\n");
}

// ─── Push: 클램프된 폭 → 구조적 들여쓰기 ───

/**
 * 콜아웃 머리줄의 들여쓰기와 제목에서 원래 깊이를 읽어 낸다.
 *
 * 마커가 있으면 그 값이 정답이고, 없으면 "여백이 있다 = 한 단계"라는 pull 의 관례를
 * 그대로 되짚는다. 열 0 이면 깊이 0 — 컨테이너 태그도 열 0 에 남는다.
 */
export function readCalloutIndentDepth(
  indent: string,
  title: string,
): { depth: number; title: string } {
  const match = CALLOUT_INDENT_MARKER_RE.exec(title);
  if (match) {
    return { depth: Number(match[1]), title: title.replace(CALLOUT_INDENT_MARKER_RE, "") };
  }
  return { depth: indent === "" ? 0 : 1, title };
}

/**
 * 클램프된 깊이를 NFM 구조 들여쓰기(탭)로 되돌린다.
 *
 * `reindentLines` 가 아니라 {@link indentContainerBody} 를 쓰는 이유: 코드블록·테이블
 * **내부**는 NFM 이 열 0 에 두는 비대칭 구조라 탭을 붙이면 안 된다. 붙이면 pull 이 그
 * 탭을 제 것으로 알고 벗기지 않아 왕복마다 한 겹씩 쌓이는 래칫이 된다.
 */
export function applyCalloutIndent(block: string, depth: number): string {
  return depth > 0 ? indentContainerBody(block, "\t".repeat(depth)) : block;
}
