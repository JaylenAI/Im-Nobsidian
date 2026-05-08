import matter from "gray-matter";
import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

export class FrontmatterExtractor implements Processor {
  readonly name = "FrontmatterExtractor";
  readonly order = 10;

  process(input: ProcessorInput): ProcessorOutput {
    const { data, content } = matter(input.content);

    return {
      content: content.trim(),
      metadata: {
        ...input.metadata,
        properties: data,
      },
    };
  }
}
