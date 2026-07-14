import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND_RE } from "../../constants/markers.js";

const LOCAL_IMAGE_MARKER_REGEX = new RegExp(
  `>\\s*📎\\s*[^\\n]*\\n>\\s*%%\\s*${MARKER_BRAND_RE}:local-(?:image|file):([^\\s]+)\\s*%%`,
  "g",
);

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
