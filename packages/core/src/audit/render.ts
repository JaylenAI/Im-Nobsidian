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
 * 규칙 번호(①~⑧)는 트랙 초기 실측 조사에서 붙인 결함 분류를 그대로 잇는다. ⑱ · ⑲ 는 그 뒤에 더했다.
 */
import {
  closesCodeFence,
  FOOTNOTE_DEF_RE,
  indentWidth,
  MATH_FENCE_RE,
  openCodeFence,
} from "../utils/md-regions.js";

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
    // 이름이 붙어 `<unknown>` 폴백에 걸리지 않던 태그들. 멘션은 위키링크나 짝 마커가 되어야
    // 한다 — 태그가 남으면 읽기 보기에서 빈칸이 되고 편집 화면에서 줄이 끊긴다(F-01).
    // 색 · 밑줄 span 은 `<u>` 나 마커가 되어야 한다 — 속성이 둘인 span 이 그대로 남았다(F-07).
    re: /<(?:(?:table_of_contents|embed|unknown_mention|empty-block|mention-[a-z-]+)\b|span\s+(?:color|underline)=)/,
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

/** 4칸 넘게 들여쓴 코드펜스 — 목록 밖이면 들여쓰기 코드블록이 되어 펜스가 글자로 보인다. */
const DEEP_FENCE_RE = /^ {4,}```/;
/** 목록 항목 줄 — 줄머리 · 표시(글머리표 · 번호). 할 일(`- [ ]`)의 상자는 내용이다. */
const LIST_ITEM_RE = /^([\t ]*)([-*+]|\d{1,9}[.)])(?:[\t ]|$)/;
/** 이 폭부터 들여쓴 코드블록이다 — 품은 목록 항목의 내용 폭에서 센다(CommonMark). */
const CODE_INDENT = 4;
/** 각주 정의의 이어지는 문단은 이만큼 들여쓴다 — 그 안은 각주다. */
const FOOTNOTE_CONTENT_WIDTH = 4;
/** ATX 제목 줄 — 들여쓴 코드블록은 문단을 끊지 못하지만 제목 바로 뒤에서는 열린다. */
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[\t ]|$)/;
/** 인용 · 콜아웃 줄 — 들여쓴 콜아웃은 ① 이 맡는다. */
const QUOTE_LEAD_RE = /^[\t ]*>/;

/** 펜스 코드블록 하나 — 코드 줄은 `open` 다음 줄부터 `end` 앞 줄까지다. */
interface FencedBlock {
  readonly open: number;
  /** 닫는 펜스 줄. 닫히지 않았으면 문서 줄 수 — 문서 끝까지 코드다. */
  readonly end: number;
}

const leadWidth = (line: string): number => indentWidth(/^[\t ]*/.exec(line)![0]);

/** 목록 항목 줄이면 그 항목의 내용 폭, 아니면 -1. */
function itemContentWidth(line: string): number {
  const item = LIST_ITEM_RE.exec(line);
  return item ? indentWidth(item[1]!) + item[2]!.length + 1 : -1;
}

/** 펜스 코드블록을 위에서부터 짝짓는다 — 목록 구조는 보지 않고, 인용 안의 펜스는 펜스로 치지 않는다. */
function fencedBlocks(lines: readonly string[]): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = openCodeFence(lines[i]!);
    if (!opening) continue;
    let end = i + 1;
    while (end < lines.length && !closesCodeFence(lines[end]!, opening)) end++;
    blocks.push({ open: i, end });
    i = end;
  }
  return blocks;
}

/**
 * 들여쓴 펜스가 목록 항목의 자식이면 그 항목의 내용 폭, 아니면 -1.
 *
 * 품은 항목은 들여쓰기가 더 얕은 가장 가까운 앞 줄(빈 줄 · 코드 안 줄 제외)이다. 펜스가 항목
 * 내용 폭에서 3칸 안쪽에 있어야 그 항목의 펜스 코드블록이다 — 더 얕으면 목록이 끝나고, 4칸
 * 넘게 깊으면 항목 안의 들여쓰기 코드블록이 되어 펜스가 글자로 보인다(CommonMark).
 */
function listChildContentWidth(
  lines: readonly string[],
  inCode: readonly boolean[],
  i: number,
): number {
  const width = leadWidth(lines[i]!);
  for (let j = i - 1; j >= 0; j--) {
    const line = lines[j]!;
    if (line.trim() === "" || inCode[j] || leadWidth(line) >= width) continue;
    const content = itemContentWidth(line);
    if (content === -1) return -1;
    return width >= content && width - content <= 3 ? content : -1;
  }
  return -1;
}

/**
 * 줄을 품은 가장 안쪽 목록 항목 · 각주 정의의 내용 폭 — 없으면 0(문서 바닥).
 *
 * 들여쓰기가 더 얕은 앞 줄을 거슬러 오른다(빈 줄 · 건너뛸 줄 제외). 그 줄이 항목이고 줄이 내용
 * 폭 안이면 그 항목이 품는다. 항목의 자식 문단처럼 항목이 아닌 얕은 줄이면, 그 줄을 품은 항목을
 * 이어 찾는다.
 */
function containerContentWidth(
  lines: readonly string[],
  skip: readonly boolean[],
  i: number,
): number {
  let width = leadWidth(lines[i]!);
  for (let j = i - 1; j >= 0 && width > 0; j--) {
    const line = lines[j]!;
    if (line.trim() === "" || skip[j]) continue;
    const lead = leadWidth(line);
    if (lead >= width) continue;
    const content = FOOTNOTE_DEF_RE.test(line) ? FOOTNOTE_CONTENT_WIDTH : itemContentWidth(line);
    if (content !== -1 && width >= content) return content;
    width = lead;
  }
  return 0;
}

/**
 * 들여쓴 코드블록을 여는 줄인가 — 빈 줄 · 제목 바로 뒤에서 품은 항목 내용보다 {@link CODE_INDENT}
 * 넘게 깊은 줄. 펜스 줄은 ⑤ · ⑱ 이, 들여쓴 콜아웃은 ① 이 맡는다.
 */
function opensIndentedCode(lines: readonly string[], skip: readonly boolean[], i: number): boolean {
  const line = lines[i]!;
  if (skip[i] || line.trim() === "" || openCodeFence(line) || QUOTE_LEAD_RE.test(line)) {
    return false;
  }
  const prev = i > 0 && !skip[i - 1] ? lines[i - 1]! : "";
  if (prev.trim() !== "" && !ATX_HEADING_RE.test(prev)) return false;
  return leadWidth(line) - containerContentWidth(lines, skip, i) >= CODE_INDENT;
}

/** 코드 · 수식 · 선두 프론트매터 줄 — 마크다운 구조로 읽지 않는다. */
function structureFreeLines(lines: readonly string[], blocks: readonly FencedBlock[]): boolean[] {
  const skip = lines.map(() => false);
  for (const b of blocks) for (let j = b.open; j <= b.end && j < lines.length; j++) skip[j] = true;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    for (let j = 0; j <= close; j++) skip[j] = true;
  }
  let math = false;
  for (let j = 0; j < lines.length; j++) {
    if (skip[j]) continue;
    const fence = MATH_FENCE_RE.test(lines[j]!);
    if (math || fence) skip[j] = true;
    if (fence) math = !math;
  }
  return skip;
}

/** 볼트에 실제로 쓰인 마크다운을 훑어 렌더 결함을 모은다. */
export function lintRenderedMarkdown(markdown: string): RenderFinding[] {
  const lines = markdown.split("\n");
  const findings: RenderFinding[] = [];
  const blocks = fencedBlocks(lines);
  const inCode = lines.map(() => false);
  for (const b of blocks) for (let j = b.open + 1; j < b.end; j++) inCode[j] = true;
  const structureFree = structureFreeLines(lines, blocks);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 코드 안의 태그 · 들여쓰기는 사용자가 적은 예제 글자다 — `<details>` · `<span color>` HTML 예제.
    for (const rule of inCode[i] ? [] : RENDER_LINE_RULES) {
      if (rule.re.test(line)) findings.push({ code: rule.code, label: rule.label, line: i + 1 });
    }

    // ⑤ 4칸 들여쓴 펜스 — 목록 항목의 자식이면 정상이다(4칸 목록 들여쓰기, S-24). 목록 · 콜아웃
    //    밖이면 들여쓰기 코드블록이 되어 펜스와 코드가 글자로 보인다.
    if (!inCode[i] && DEEP_FENCE_RE.test(line) && listChildContentWidth(lines, inCode, i) === -1) {
      findings.push({ code: "⑤", label: "코드펜스 4칸 들여쓰기(목록·콜아웃 밖)", line: i + 1 });
    }

    // ⑲ 들여쓴 코드블록 — Notion 의 코드는 늘 펜스로 온다. 빈 줄 뒤 4칸 넘게 들여쓴 줄은 구조
    //    들여쓰기가 남은 것이다 — 문단 · 인용의 자식이 회색 코드 상자로 보였다(2026-10-04 실측).
    if (opensIndentedCode(lines, structureFree, i)) {
      findings.push({ code: "⑲", label: "들여쓴 코드블록(구조 들여쓰기 잔존)", line: i + 1 });
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

  // ⑱ 목록 안 코드가 목록 밖으로 샌다 — 코드 줄이 항목 내용보다 얕으면 Obsidian 은 그 줄에서
  //    목록과 코드블록을 끝낸다. 목록 안에는 빈 코드블록이, 밖에는 코드가 문단으로 보인다(S-24).
  for (const b of blocks) {
    const content = listChildContentWidth(lines, inCode, b.open);
    if (content === -1) continue;
    for (let j = b.open + 1; j < b.end; j++) {
      if (lines[j]!.trim() === "" || leadWidth(lines[j]!) >= content) continue;
      findings.push({ code: "⑱", label: "목록 안 코드가 목록 밖으로 샘", line: b.open + 1 });
      break;
    }
  }

  return findings;
}
