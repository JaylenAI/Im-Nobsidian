/**
 * 토글 헤딩(`### 제목 {toggle="true"}`) 왕복 변환.
 *
 * NFM 은 토글 헤딩을 **속성 붙은 제목 + 탭 한 단계 들여쓴 자식**으로 내보낸다:
 *
 * ```
 * ### SW 개발 보안 3대요소 {toggle="true"}
 * \t<details>
 * \t<summary>기밀성</summary>
 * \t\t인가되지 않은 접근을 차단하는 특성
 * \t</details>
 * ```
 *
 * 이 형태를 그대로 두면 두 결함이 동시에 터진다(실볼트 1,267노트 실측):
 *  1. `{toggle="true"}` 가 제목 뒤에 리터럴로 노출된다(256건).
 *  2. 자식의 구조적 탭이 후처리(`block-spacer`)에서 4-space 로 확장되고, 그 위에
 *     `convertContainers` 가 들여쓰기를 재적용해 `    > [!toggle]-` 가 된다. Obsidian 은
 *     4칸 들여쓴 줄을 **코드블록**으로 파싱하므로 콜아웃이 회색 상자에 `>` 가 보이는
 *     형태로 죽는다(524건).
 *
 * 해결: 제목의 속성을 보존 마커로 옮기고 자식을 한 단계 dedent 해 **열 0** 으로 내린다.
 * 깊이 신호를 들여쓰기가 아니라 **제목 경계 + 마커 쌍**이 지게 만드는 것이 요점이다.
 * 들여쓰기는 Obsidian 의 코드블록 규칙과 충돌하지만 제목 경계는 충돌하지 않는다.
 *
 * dedent/indent 는 {@link ./container-indent.js} SSOT 를 그대로 쓴다 — 토글/콜아웃/칼럼과
 * 같은 기준이어야 코드펜스·테이블의 비대칭 들여쓰기에서 왕복이 수렴한다.
 */
import { TOGGLE_HEADING_END, TOGGLE_HEADING_START } from "../constants/markers.js";
import {
  containerBlockEnds,
  dedentContainerBody,
  indentContainerBody,
  stripContainerIndent,
} from "./container-indent.js";

/**
 * NFM 원본의 토글 헤딩. 속성은 반드시 줄 끝에 온다.
 *
 * 선행 들여쓰기를 **캡처**하는 것이 핵심이다. NFM 은 블록 계층을 탭으로 표현하므로
 * 토글 헤딩이 늘 열 0 에 있지 않다 — 문단도 자식을 가질 수 있어
 * `<callout>` → 문단(`\t`) → 토글 헤딩(`\t\t`) 이 실제로 나온다. 열 0 에만 앵커하면
 * 그런 헤딩은 조용히 무동작이 되어 `{toggle="true"}` 가 본문에 노출되고, 자식이
 * 접히지 않은 채 흩어진다(실측: 2건·1노트).
 */
const NFM_TOGGLE_HEADING_RE = /^([\t ]*)(#{1,6})[ \t]+(.*?)[ \t]*\{toggle="true"\}[ \t]*$/;

/**
 * 볼트 산출물의 토글 헤딩(시작 마커가 붙은 제목).
 *
 * pull 이 헤딩의 들여쓰기를 보존하므로 push 도 같은 자리에서 받아야 한다. 특히 콜아웃
 * 안 토글 헤딩은 {@link ./enhanced-md-converter.js} 의 `convertObsidianCallouts`(순서 120)가
 * 구조 탭을 **다시 입힌 뒤** 이 복원기(순서 134)에 도달한다 — 열 0 앵커면 그 시점에
 * 못 잡아 마커가 Notion 으로 새고 토글 헤딩이 평범한 제목으로 죽는다.
 */
const MARKED_TOGGLE_HEADING_RE = new RegExp(
  `^([\\t ]*)(#{1,6})[ \\t]+(.*?)[ \\t]*${TOGGLE_HEADING_START}[ \\t]*$`,
);

/** 일반 제목 — push 폴백에서 본문 경계를 정할 때 쓴다. */
const ANY_HEADING_RE = /^(#{1,6})[ \t]/;

function headingLine(hashes: string, title: string, suffix: string): string {
  return [hashes, title.trim(), suffix].filter((part) => part !== "").join(" ");
}

// ─── Pull: NFM → Obsidian ───

/**
 * `### 제목 {toggle="true"}` + 탭 들여쓴 자식 → `### 제목 %%…toggle-heading%%` + 열 0 자식
 * + `%%…toggle-heading:end%%`.
 *
 * 끝 마커를 붙이는 이유는 {@link TOGGLE_HEADING_START} 주석 참조 — 자식을 열 0 으로
 * 내리는 순간 자식과 후속 형제가 구분되지 않기 때문이다.
 */
export function convertToggleHeadings(content: string): string {
  return convertLevel(content.split("\n")).join("\n");
}

function convertLevel(lines: readonly string[]): string[] {
  const out: string[] = [];
  // 컨테이너 경계는 문서 앞부터의 전방 스캔이라 레벨당 한 번만 계산하면 된다.
  const ends = containerBlockEnds(lines);

  for (let i = 0; i < lines.length; i++) {
    const match = NFM_TOGGLE_HEADING_RE.exec(lines[i]!);
    if (!match) {
      out.push(lines[i]!);
      continue;
    }

    const [, indent, hashes, title] = match as unknown as [string, string, string, string];

    // 자식 구간: 제목보다 **한 단계 더** 들여쓴 줄이 이어지는 동안(사이 빈 줄 허용).
    // 제목과 같은 깊이의 비어있지 않은 줄이 나오면 형제이므로 거기서 끊는다 — NFM 이
    // 주는 유일한 경계 신호다.
    //
    // 단, 코드블록·테이블은 **통째로** 삼킨다. NFM 은 펜스/`<table>` 태그만 들여쓰고 내부
    // 줄은 열 0 에 두는 비대칭 구조를 쓰므로(container-indent 주석 참조), 들여쓰기가 얕다는
    // 이유로 끊으면 코드 첫 줄에서 자식 구간이 잘려 나간다. 닫는 펜스도 마찬가지라 한 줄씩
    // 판정하면 닫는 줄만 구간 밖으로 밀려나고, 그 자리에 끝 마커가 코드 **안으로** 끼어든다.
    const childIndent = `${indent}\t`;
    let lastChild = i;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "") continue;
      if (!line.startsWith(childIndent)) break;
      lastChild = ends[j]!;
      j = lastChild;
    }

    if (lastChild === i) {
      // 자식 없는 토글 헤딩 — 속성만 마커로 바꾼다(끝 마커 불필요).
      out.push(indent + headingLine(hashes, title, TOGGLE_HEADING_START));
      continue;
    }

    // 자식을 제목과 같은 깊이로 끌어올린다 — 열 0 일 때와 같은 규칙을 상대적으로 적용한
    // 것이며, push 의 `indentContainerBody(body, indent + "\t")` 와 정확히 역함수다.
    const body = dedentContainerBody(lines.slice(i + 1, lastChild + 1).join("\n"));
    // 중첩 토글 헤딩은 dedent 로 열 0 에 올라왔으므로 재귀가 같은 규칙으로 처리한다.
    const inner = convertLevel(body.split("\n")).join("\n");
    out.push(indent + headingLine(hashes, title, TOGGLE_HEADING_START));
    out.push(...(indent === "" ? inner : indentContainerBody(inner, indent)).split("\n"));
    out.push(indent + TOGGLE_HEADING_END);
    i = lastChild;
  }

  return out;
}

// ─── Push: Obsidian → NFM ───

/**
 * `### 제목 %%…toggle-heading%%` + 열 0 본문 → `### 제목 {toggle="true"}` + 탭 들여쓴 자식.
 *
 * 본문 경계는 끝 마커로 정한다. 마커가 없는 구버전 볼트 문서(또는 사용자가 지운 경우)는
 * "다음 동급 이상 제목까지"로 폴백한다 — 사람이 기대하는 섹션 의미론이자, 토글 헤딩을
 * 통째로 잃는 것보다 낫다.
 */
export function restoreToggleHeadings(content: string): string {
  return restoreLevel(content.split("\n")).join("\n");
}

function restoreLevel(lines: readonly string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = MARKED_TOGGLE_HEADING_RE.exec(line);
    if (!match) {
      // 짝 없는 끝 마커는 Notion 으로 새기 전에 떨군다.
      if (line.trim() !== TOGGLE_HEADING_END) out.push(line);
      continue;
    }

    const [, indent, hashes, title] = match as unknown as [string, string, string, string];
    const bound = findBodyEnd(lines, i + 1, hashes.length);
    // 본문은 제목과 같은 깊이에 있다(pull 대칭). 열 0 으로 내려 재귀시킨 뒤 제목보다 한
    // 단계 깊게 되입히면 NFM 의 "제목 + 한 단계 들여쓴 자식" 구조가 그대로 복원된다.
    const raw = stripContainerIndent(lines.slice(i + 1, bound.bodyEnd).join("\n"), indent);
    const inner = restoreLevel(raw.split("\n"));
    const body = inner.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");

    out.push(indent + headingLine(hashes, title, '{toggle="true"}'));
    if (body.trim() !== "") out.push(...indentContainerBody(body, `${indent}\t`).split("\n"));
    i = bound.consumed;
  }

  return out;
}

/**
 * 본문의 끝(exclusive)과 루프가 이어받을 인덱스를 찾는다.
 * 중첩 토글 헤딩의 끝 마커를 제 것으로 오인하지 않도록 깊이를 센다.
 */
function findBodyEnd(
  lines: readonly string[],
  from: number,
  level: number,
): { bodyEnd: number; consumed: number } {
  let depth = 0;

  for (let j = from; j < lines.length; j++) {
    const line = lines[j]!;

    if (MARKED_TOGGLE_HEADING_RE.test(line)) {
      depth++;
      continue;
    }
    if (line.trim() === TOGGLE_HEADING_END) {
      if (depth > 0) {
        depth--;
        continue;
      }
      return { bodyEnd: j, consumed: j };
    }

    // 폴백 경계 — 끝 마커가 없는 문서에서만 도달한다.
    const heading = ANY_HEADING_RE.exec(line);
    if (heading && heading[1]!.length <= level) return { bodyEnd: j, consumed: j - 1 };
  }

  return { bodyEnd: lines.length, consumed: lines.length - 1 };
}
