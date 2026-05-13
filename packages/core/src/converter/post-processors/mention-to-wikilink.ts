import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const NOTION_LINK_REGEX =
  /\[([^\]]+)\]\((?:https:\/\/www\.notion\.so\/|notion:\/\/)([a-f0-9-]+)\)/g;

export class MentionToWikilink implements Processor {
  readonly name = "MentionToWikilink";
  readonly order = 10;

  process(input: ProcessorInput): ProcessorOutput {
    const content = input.content.replace(
      NOTION_LINK_REGEX,
      (_match, display: string, _pageId: string) => {
        return `[[${display}]]`;
      },
    );

    return {
      content,
      metadata: input.metadata,
    };
  }
}
