import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const UNSUPPORTED_CALLOUT_REGEX = /> \[!im-nobsidian-unsupported\][^\n]*\n(?:>[^\n]*\n)*/g;

export class UnsupportedBlockStripper implements Processor {
  readonly name = "UnsupportedBlockStripper";
  readonly order = 5;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    const content = input.content.replace(UNSUPPORTED_CALLOUT_REGEX, "");

    return {
      content: content.replace(/\n{3,}/g, "\n\n"),
      metadata: input.metadata,
    };
  }
}
