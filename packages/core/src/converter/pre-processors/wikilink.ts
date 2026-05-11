import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export class WikilinkResolver implements Processor {
  readonly name = "WikilinkResolver";
  readonly order = 20;

  process(input: ProcessorInput): ProcessorOutput {
    const resolved = input.content.replace(
      WIKILINK_REGEX,
      (_match, target: string, display?: string) => {
        const label = display ?? target;
        return `**${label}**`;
      },
    );

    return {
      content: resolved,
      metadata: input.metadata,
    };
  }
}
