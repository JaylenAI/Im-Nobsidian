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

  const kinds = classifyContainerLines(lines);

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
      if (kinds[i] === "fence") return l.replace(/^[\t ]+/, "");
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
 * 코드블록·테이블 경계를 추적해 각 줄을 분류한다 —
 * {@link dedentContainerBody}(pull)와 {@link indentContainerBody}(push)의 공통 기준.
 */
export function classifyContainerLines(lines: readonly string[]): ContainerLineKind[] {
  const kinds: ContainerLineKind[] = [];
  let inCode = false;
  let fenceChar = "";
  let fenceLen = 0;
  let inTable = false;
  for (const line of lines) {
    const fence = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (inCode) {
      if (
        fence &&
        fence[1]![0] === fenceChar &&
        fence[1]!.length >= fenceLen &&
        fence[2]!.trim() === ""
      ) {
        inCode = false;
        kinds.push("fence");
      } else {
        kinds.push("code");
      }
    } else if (inTable) {
      const closes = /<\/table>/.test(line);
      kinds.push(closes ? "fence" : "code");
      if (closes) inTable = false;
    } else if (fence) {
      inCode = true;
      fenceChar = fence[1]![0]!;
      fenceLen = fence[1]!.length;
      kinds.push("fence");
    } else if (/^[\t ]*<table[^>]*>/.test(line)) {
      // <table> 태그만 깊게 들여쓰고 내부 행은 열 0 인 비대칭 구조. 한 줄에서 닫히지
      // 않으면 테이블 모드로 진입해 행을 보존, 닫는 </table> 도 경계로 열 0 정렬한다.
      if (!/<\/table>/.test(line)) inTable = true;
      kinds.push("fence");
    } else {
      kinds.push("prose");
    }
  }
  return kinds;
}
