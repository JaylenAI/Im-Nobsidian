/**
 * 렌더 감사 — "볼트에 쓰인 마크다운이 Obsidian 에서 깨져 보이는가"를 코드로 고정한다.
 *
 * {@link classifyBodyFidelity} 가 **내용이 남았는가**를 보고 {@link verifyPageCompleteness}
 * 가 **빠짐없이 왔는가**를 본다면, 여기는 **사람 눈에 어떻게 보이는가**를 본다. 셋은 서로의
 * 사각지대를 맡는다 — 실제로 이 트랙의 결함은 내용도 다 있고 개수도 맞는데 콜아웃이
 * 코드블록으로 오파싱되거나 표 구분행만 덩그러니 남는 형태였다.
 *
 * 원본 대조가 필요 없는 것만 담는다. 한 파일만 보고 판정할 수 있어야 동기화 하니스가
 * 볼트를 훑는 데 쓸 수 있다. 원본 NFM 과 견주는 지표(구조 드리프트·코드블록 경계)는
 * 회귀 코퍼스를 쥔 테스트 쪽에 남는다.
 *
 * 규칙 번호(①~⑧)는 트랙 초기 실측 조사에서 붙인 결함 분류를 그대로 잇는다.
 */

/** 한 줄만 보고 판정할 수 있는 렌더 결함. */
export interface RenderLineRule {
  readonly code: string;
  readonly label: string;
  readonly re: RegExp;
}

export const RENDER_LINE_RULES: readonly RenderLineRule[] = [
  {
    code: "①",
    label: "콜아웃 4칸+ 들여쓰기",
    // Obsidian 은 절대 들여쓰기 4칸부터 들여쓰기 코드블록으로 오파싱한다.
    // 콜아웃이 통째로 회색 코드 상자가 되어 서식이 전부 죽는다.
    re: /^(?: {4,}|\t)+>\s*\[!/,
  },
  {
    code: "②",
    label: "토글헤딩 속성 누수",
    // NFM 전용 속성이 본문에 그대로 노출된 상태 — 토글도 접히지 않는다.
    re: /\{toggle="true"\}/,
  },
  {
    code: "③",
    label: "NFM 컨테이너 태그 누수",
    re: /<\/?(?:details|summary|callout|columns|column)\b/,
  },
  {
    code: "④",
    label: "NFM 전용 태그 누수",
    // 이름이 붙어 `<unknown>` 폴백에 걸리지 않던 태그들.
    re: /<(?:table_of_contents|embed|unknown_mention|empty-block)\b/,
  },
  {
    code: "⑤",
    label: "코드펜스 4칸 들여쓰기(콜아웃 밖)",
    re: /^ {4,}```/,
  },
] as const;

/** 발견된 렌더 결함 하나. */
export interface RenderFinding {
  readonly code: string;
  readonly label: string;
  readonly line: number;
}

/**
 * 표 구분행 — 가로 공백만 허용한다. `\s` 를 쓰면 **줄바꿈까지 삼킨다**.
 *
 * 그러면 빈 표 행(`|  |  |  |`) 다음의 수평선(`---`)이 한 덩어리로 잡혀 구분행 하나가
 * 날조되고, 데이터 행이 하나 줄어든 것처럼 보인다.
 */
export const SEPARATOR_BODY = "[ \\t:|-]*-{3,}";
const SEPARATOR_RE = new RegExp(`^[\\t ]*>?[\\t ]*\\|${SEPARATOR_BODY}[ \\t:|-]*\\|`);
const FENCE_RE = /^[\t ]*(?:>[\t ]*)*```/;

/** 볼트에 실제로 쓰인 마크다운을 훑어 렌더 결함을 모은다. */
export function lintRenderedMarkdown(markdown: string): RenderFinding[] {
  const lines = markdown.split("\n");
  const findings: RenderFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of RENDER_LINE_RULES) {
      if (rule.re.test(line)) findings.push({ code: rule.code, label: rule.label, line: i + 1 });
    }

    // ⑦ 표 구분행 고아 — 바로 윗줄이 같은 접두의 표 행이 아니면 표가 열리지 않는다.
    //    구분행만 덩그러니 남아 `|---|---|` 가 본문에 노출된다.
    if (SEPARATOR_RE.test(line)) {
      const prefix = /^([\t ]*>?[\t ]*)/.exec(line)![1]!;
      const prev = lines[i - 1] ?? "";
      if (!prev.startsWith(prefix) || !prev.slice(prefix.length).trimStart().startsWith("|")) {
        findings.push({ code: "⑦", label: "표 구분행 고아(표 사망)", line: i + 1 });
      }
    }
  }

  // ⑧ 코드펜스 홀수 — 짝이 안 맞으면 그 아래 문서 전체가 코드블록으로 먹힌다.
  if (lines.filter((l) => FENCE_RE.test(l)).length % 2 !== 0) {
    findings.push({ code: "⑧", label: "코드펜스 홀수(문서 잔여분 삼킴)", line: 0 });
  }

  return findings;
}
