import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { splitFrontmatter } from "../../utils/frontmatter.js";

export class FrontmatterExtractor implements Processor {
  readonly name = "FrontmatterExtractor";
  readonly order = 10;

  process(input: ProcessorInput): ProcessorOutput {
    const { data, content } = splitFrontmatter(input.content);

    return {
      content: content.trim(),
      metadata: {
        ...input.metadata,
        properties: data,
      },
    };
  }
}
