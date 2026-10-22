import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND_RE, compactMarker } from "../../constants/markers.js";
import { replaceOutsideCode } from "../container-indent.js";

/** `<u>밑줄</u>` (Obsidian·HTML 관용) — push 시 underline 마커로 승격. */
const UNDERLINE_REGEX = /<u>([\s\S]*?)<\/u>/g;

/** `==하이라이트==` — 같은 줄 내, `===`(3연속)와 구분. */
const HIGHLIGHT_REGEX = /(?<!=)==([^=\n]+?)==(?!=)/g;

/**
 * `<mark>형광</mark>` — HTML 의 형광이다. Highlightr 플러그인은 `<mark style="…">` 로 적는다. `==` 와 같이
 * 같은 줄 안만 본다 — pull 이 형광을 `==` 로 되돌리는 것도 한 줄이다(HighlightRestorer).
 */
const MARK_REGEX = /<mark(?:\s[^>]*)?>([^\n]+?)<\/mark>/g;

/**
 * 색상 span(`<span class="notion-red">` / `notion-yellow-bg`) — pull(notion-to-md) 경로가 만든
 * 레거시 표현. 1번 그룹=베이스 색, 2번 그룹=배경(`-bg`) 여부.
 */
const COLOR_SPAN_REGEX = /<span class="notion-(\w+)(-bg)?">([\s\S]*?)<\/span>/g;

/** 공백형 색상 보존마커 `%% im-nobsidian:color:X %%...%% im-nobsidian:end %%` (block 경로 산출물). */
const SPACED_COLOR_REGEX = new RegExp(
  `%% ${MARKER_BRAND_RE}:color:(\\w+(?:_background)?) %%([\\s\\S]*?)%% ${MARKER_BRAND_RE}:end %%`,
  "g",
);

/**
 * 인라인 annotation(underline·color) 무손실 보존기 — push 전처리(order 13).
 *
 * 과거에는 underline/color 표기를 **제거**(strip)했으나, 그러면 Notion 으로 push 할 때
 * 서식이 영구 소실됐다(I3 손실점). Notion 의 Enhanced Markdown 은 underline/color 를
 * `<span underline="true">` / `<span color="X">` 로 **무손실 표현**하므로, 여기서는 제거 대신
 * 프로젝트 정본인 **compact 보존마커**(`%%im-nobsidian:underline%%…%%/underline%%`,
 * `%%im-nobsidian:color:C%%…%%/color%%`)로 **승격**만 한다. 실제 Notion span 복원은
 * push 직전 단일 SSOT 인 {@link obsidianToNotionEnhanced} 가 담당한다.
 *
 * 입력 표기는 pull 경로별로 다르다.
 * - Markdown API 경로: 이미 compact 마커 → 무변경 통과(여기 정규식에 걸리지 않음).
 * - notion-to-md(block) 경로: `<u>` + 공백형 색상 마커 → compact 마커로 정규화.
 * - 사용자가 직접 작성한 `<u>` / 레거시 `<span class="notion-*">` → compact 마커로 승격.
 *
 * compact 마커는 공백이 없어 PreserveMarkerCollector(공백형만 수집)·기타 전처리기를
 * 무손상 통과한다(기존 underline/color 왕복이 이를 실증).
 */
export class InlineAnnotationPreserver implements Processor {
  readonly name = "InlineAnnotationPreserver";
  // FrontmatterExtractor(10) · CommentStripper(11) 뒤 — 마커는 `%%` 로 쓰여, 주석 속 `==강조==` 를 먼저
  // 마커로 바꾸면 `%%` 가 마커를 넘어 짝짓지 않아 주석이 통째로 Notion 에 올라갔다. YAML 값 속 `==` ·
  // `<u>` 도 마커 글자로 바뀌어 속성에 실렸다(S-31).
  readonly order = 13;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    let content = input.content;

    // 공백형 색상 마커 → compact 색상 마커 (색상값은 그대로 보존)
    content = content.replace(
      SPACED_COLOR_REGEX,
      (_m, color: string, text: string) => `${compactMarker(`color:${color}`)}${text}%%/color%%`,
    );

    // 아래 셋은 코드 안에서는 사용자가 적은 글자다. 예전에는 펜스 안의 `<u>` 까지 바꿔 Notion 의
    // 코드가 `<span underline="true">` 로 바뀌었고, 인라인 코드의 `a==b==c` 가 노랑 배경이 됐다.

    // <u>…</u> → underline 마커
    content = replaceOutsideCode(
      content,
      UNDERLINE_REGEX,
      (_m, text) => `${compactMarker("underline")}${text}%%/underline%%`,
    );

    // <span class="notion-X[-bg]"> → compact 색상 마커 (-bg → _background)
    content = replaceOutsideCode(content, COLOR_SPAN_REGEX, (_m, base, bg, text) => {
      const color = bg ? `${base}_background` : base;
      return `${compactMarker(`color:${color}`)}${text}%%/color%%`;
    });

    // ==하이라이트== → 노랑 배경 (F24). Obsidian 하이라이트의 유일한 자연 대응이
    // Notion yellow 배경이다. 색상명은 pull 경로(Notion md export)가 쓰는
    // `yellow_bg` 로 맞춰 HighlightRestorer 와 왕복 대칭을 이룬다.
    // <mark> 도 같다 — 그대로 보내면 Notion 이 태그를 글자로 적는다(F-06, 2026-10-04 실측).
    const highlight = (_m: string, text: string) =>
      `${compactMarker("color:yellow_bg")}${text}%%/color%%`;
    content = replaceOutsideCode(content, HIGHLIGHT_REGEX, highlight);
    content = replaceOutsideCode(content, MARK_REGEX, highlight);

    return { content, metadata: input.metadata };
  }
}
