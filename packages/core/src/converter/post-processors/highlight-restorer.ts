import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND_RE } from "../../constants/markers.js";

/** compact 노랑배경 마커 — pull 경로(Notion md export)는 `yellow_bg` 를 쓴다. */
const COMPACT_YELLOW_RE = new RegExp(
  `%%${MARKER_BRAND_RE}:color:yellow(?:_background|_bg)%%([^\\n]*?)%%\\/color%%`,
  "g",
);

/** 공백형 노랑배경 마커 (block 경로 산출물). */
const SPACED_YELLOW_RE = new RegExp(
  `%% ${MARKER_BRAND_RE}:color:yellow(?:_background|_bg) %%([^\\n]*?)%% ${MARKER_BRAND_RE}:end %%`,
  "g",
);

/**
 * Notion 노랑 배경(yellow_bg)을 Obsidian 하이라이트 `==...==` 로 복원한다(F24).
 * push 쪽 대응(InlineAnnotationPreserver 의 `==` 승격)과 쌍을 이뤄
 * `==x==` ↔ yellow_bg 왕복을 무손실로 만든다. 여러 줄에 걸친 색상은
 * `==` 문법이 표현하지 못하므로 마커 형태를 유지한다(줄 단위만 매칭).
 */
export class HighlightRestorer implements Processor {
  readonly name = "HighlightRestorer";
  readonly order = 25;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const content = input.content
      .replace(COMPACT_YELLOW_RE, (_m, text: string) => (text ? `==${text}==` : ""))
      .replace(SPACED_YELLOW_RE, (_m, text: string) => (text ? `==${text}==` : ""));

    return { content, metadata: input.metadata };
  }
}
