import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const UNSUPPORTED_CALLOUT_REGEX = /> \[!im-nobsidian-unsupported\][^\n]*\n(?:>[^\n]*\n)*/g;

export class UnsupportedBlockStripper implements Processor {
  readonly name = "UnsupportedBlockStripper";
  readonly order = 5;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    // 지운 자리에 남는 빈 줄은 BlankLineCollapser 가 줄인다.
    return {
      content: input.content.replace(UNSUPPORTED_CALLOUT_REGEX, ""),
      metadata: input.metadata,
    };
  }
}
