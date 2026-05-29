import matter from "gray-matter";
import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { PROPERTIES_TAG } from "../../constants/markers.js";

export class PropertiesTableInjector implements Processor {
  readonly name = "PropertiesTableInjector";
  readonly order = 15;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    if (input.context.parentMode === "database") {
      return { content: input.content, metadata: input.metadata };
    }

    const properties = input.metadata.properties as Record<string, unknown> | undefined;
    if (!properties || Object.keys(properties).length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const filteredProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      filteredProps[key] = value;
    }

    if (Object.keys(filteredProps).length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const yamlStr = matter.stringify("", filteredProps).trim();
    const yamlBody = yamlStr.slice(4, -3).trim();
    const codeBlock = "```yaml\n" + PROPERTIES_TAG + "\n" + yamlBody + "\n```";

    const content = codeBlock + "\n\n---\n\n" + input.content;

    return { content, metadata: input.metadata };
  }
}
