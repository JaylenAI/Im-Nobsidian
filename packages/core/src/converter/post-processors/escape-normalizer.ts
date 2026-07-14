import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { mapOutsideCodeFences } from "../../utils/md-regions.js";

/**
 * Notion → md 산출물의 과잉 이스케이프를 정규화한다(F27·F30 계열).
 *
 * - `\:` → `:` — 콜론은 마크다운에서 이스케이프가 불필요하고(CommonMark 상
 *   `\:` 는 `:` 와 동일 의미), 이 이스케이프가 보존 마커
 *   (`%% im-nobsidian\:local-image\:... %%`)와 표 셀(`\:---\:`)을 깨뜨린다.
 * - `\[^1\]`/`\[^` → `[^1]`/`[^` — FootnoteGuard 가 push 때 이스케이프한
 *   각주 토큰을 원형으로 되돌린다(F25 왕복 복원).
 *
 * 다른 복원기(LocalImageRestorer 등)의 정규식이 원형 마커를 전제하므로
 * 가장 먼저(order 3) 실행한다.
 */
export class EscapeNormalizer implements Processor {
  readonly name = "EscapeNormalizer";
  readonly order = 3;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const content = mapOutsideCodeFences(input.content, (segment) =>
      segment
        .replace(/\\\[\^([^\]\\\n]+)\\\]/g, "[^$1]")
        .replace(/\\\[\^/g, "[^")
        .replace(/\\:/g, ":"),
    );

    return { content, metadata: input.metadata };
  }
}
