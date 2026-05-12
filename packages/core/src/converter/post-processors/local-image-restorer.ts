import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const LOCAL_IMAGE_MARKER_REGEX =
  />\s*📎\s*[^\n]*\n>\s*%%\s*im-nobsidian:local-image:([^\s]+)\s*%%/g;

export class LocalImageRestorer implements Processor {
  readonly name = "LocalImageRestorer";
  readonly order = 15;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const content = input.content.replace(LOCAL_IMAGE_MARKER_REGEX, (_match, target: string) => {
      return `![[${target}]]`;
    });

    return { content, metadata: input.metadata };
  }
}
