import matter from "gray-matter";
import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

export class FrontmatterGenerator implements Processor {
  readonly name = "FrontmatterGenerator";
  readonly order = 90;

  process(input: ProcessorInput): ProcessorOutput {
    const properties = input.metadata.properties as Record<string, unknown> | undefined;

    if (!properties || Object.keys(properties).length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const content = matter.stringify(input.content, properties);

    return {
      content,
      metadata: input.metadata,
    };
  }
}
