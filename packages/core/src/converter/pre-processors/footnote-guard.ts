import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { mapOutsideCodeFences } from "../../utils/md-regions.js";

const FOOTNOTE_TOKEN_REGEX = /(?<!\\)\[\^([^\]\s]+)\]/g;

/**
 * 각주(`[^1]` 참조 + `[^1]: 내용` 정의)는 remark(각주 확장 없음)가 참조 링크로
 * 오파싱해 `[\[1\]](1)` 형태로 영구 파손된다(F25). push 전에 여는 대괄호를
 * 이스케이프(`\[^1]`)해 링크 파싱을 차단한다 — Notion 에는 `[^1]` 평문으로
 * 보이고(가시적 degrade), pull 시 EscapeNormalizer 가 원형으로 복원해
 * 왕복은 무손실이다.
 */
export class FootnoteGuard implements Processor {
  readonly name = "FootnoteGuard";
  readonly order = 12;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    const content = mapOutsideCodeFences(input.content, (segment) =>
      segment.replace(FOOTNOTE_TOKEN_REGEX, "\\[^$1]"),
    );

    return { content, metadata: input.metadata };
  }
}
