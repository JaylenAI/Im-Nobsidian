import matter from "gray-matter";
import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const WIKILINK_IN_YAML = /\[\[([^\]]+)\]\]/g;

export class FrontmatterExtractor implements Processor {
  readonly name = "FrontmatterExtractor";
  readonly order = 10;

  process(input: ProcessorInput): ProcessorOutput {
    const sanitized = input.content.replace(FRONTMATTER_REGEX, (match, yaml: string) => {
      const fixed = yaml.replace(WIKILINK_IN_YAML, "$1");
      return match.replace(yaml, fixed);
    });

    const { data, content } = matter(sanitized);

    return {
      content: content.trim(),
      metadata: {
        ...input.metadata,
        properties: data,
      },
    };
  }
}
