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
  classifyContainerLines,
  dedentContainerBody,
  indentContainerBody,
} from "./container-indent.js";

/** NFM 원본의 토글 헤딩. 속성은 반드시 줄 끝에 온다. */
const NFM_TOGGLE_HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*\{toggle="true"\}[ \t]*$/;

/** 볼트 산출물의 토글 헤딩(시작 마커가 붙은 제목). */
const MARKED_TOGGLE_HEADING_RE = new RegExp(
  `^(#{1,6})[ \\t]+(.*?)[ \\t]*${TOGGLE_HEADING_START}[ \\t]*$`,
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
  // 줄 성격은 문서 앞부터의 전방 스캔이라 레벨당 한 번만 계산하면 된다.
  const kinds = classifyContainerLines(lines);

  for (let i = 0; i < lines.length; i++) {
    const match = NFM_TOGGLE_HEADING_RE.exec(lines[i]!);
    if (!match) {
      out.push(lines[i]!);
      continue;
    }

    // 자식 구간: 탭으로 들여쓴 줄이 이어지는 동안(사이 빈 줄 허용). 열 0 의 비어있지 않은
    // 줄이 나오면 형제이므로 거기서 끊는다 — NFM 이 주는 유일한 경계 신호다.
    //
    // 단, 코드블록·테이블 **내부**는 예외다. NFM 은 펜스/`<table>` 태그만 들여쓰고 내부
    // 줄은 열 0 에 두는 비대칭 구조를 쓰므로(container-indent 주석 참조), 열 0 이라는
    // 이유로 끊으면 코드 첫 줄에서 자식 구간이 잘려 나간다.
    let lastChild = i;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "") continue;
      if (kinds[j] !== "code" && !line.startsWith("\t")) break;
      lastChild = j;
    }

    const [, hashes, title] = match as unknown as [string, string, string];
    if (lastChild === i) {
      // 자식 없는 토글 헤딩 — 속성만 마커로 바꾼다(끝 마커 불필요).
      out.push(headingLine(hashes, title, TOGGLE_HEADING_START));
      continue;
    }

    const body = dedentContainerBody(lines.slice(i + 1, lastChild + 1).join("\n"));
    out.push(headingLine(hashes, title, TOGGLE_HEADING_START));
    // 중첩 토글 헤딩은 dedent 로 열 0 에 올라왔으므로 재귀가 같은 규칙으로 처리한다.
    out.push(...convertLevel(body.split("\n")));
    out.push(TOGGLE_HEADING_END);
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

    const [, hashes, title] = match as unknown as [string, string, string];
    const level = hashes.length;
    const bound = findBodyEnd(lines, i + 1, level);
    const inner = restoreLevel(lines.slice(i + 1, bound.bodyEnd));
    const body = inner.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");

    out.push(headingLine(hashes, title, '{toggle="true"}'));
    if (body.trim() !== "") out.push(...indentContainerBody(body, "\t").split("\n"));
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
