import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { collapseBlankLines } from "../../utils/md-regions.js";

/**
 * 보내기 직전에 코드 밖의 이어진 빈 줄을 한 줄로 줄인다 — Notion 마크다운 가져오기는 남는 빈 줄마다 빈
 * 블록을 만든다(실측: 주석 한 줄을 지운 자리의 빈 줄 셋이 빈 블록 셋). 받으면 그 빈 블록이 `<br>` 줄이 된다.
 *
 * 노트의 빈 줄과, 앞 전처리가 지운 주석 · 지원하지 않는 블록이 남긴 빈 줄을 함께 줄인다. 그래서 내용을
 * 지우거나 끼우는 전처리 뒤, 보존 마커 수집(70) 앞에 돈다. 예전에는 지원하지 않는 블록 제거(5)가 줄였다 —
 * 주석 제거(11)보다 먼저라 주석 자리가 빈 블록이 됐고, 코드 속 빈 줄까지 줄였다(S-27).
 */
export class BlankLineCollapser implements Processor {
  readonly name = "BlankLineCollapser";
  readonly order = 65;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }
    return { content: collapseBlankLines(input.content), metadata: input.metadata };
  }
}
