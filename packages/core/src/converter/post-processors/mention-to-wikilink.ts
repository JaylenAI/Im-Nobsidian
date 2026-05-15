import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const NOTION_LINK_REGEX =
  /\[([^\]]+)\]\((?:https:\/\/(?:www\.)?notion\.so\/|notion:\/\/)([a-f0-9-]+)\)/g;

const WIKILINK_PRESERVE_REGEX = /\[([^\]]+)\]\(im-nobsidian:\/\/wikilink\/([^)]+)\)/g;

const EMBED_PRESERVE_REGEX = /\[([^\]]+)\]\(im-nobsidian:\/\/embed\/([^)]+)\)/g;

export class MentionToWikilink implements Processor {
  readonly name = "MentionToWikilink";
  readonly order = 10;

  process(input: ProcessorInput): ProcessorOutput {
    let content = input.content;

    content = content.replace(NOTION_LINK_REGEX, (_match, display: string) => `[[${display}]]`);

    content = content.replace(
      WIKILINK_PRESERVE_REGEX,
      (_match, display: string, encodedTarget: string) => {
        const target = decodeURIComponent(encodedTarget);
        return target === display ? `[[${target}]]` : `[[${target}|${display}]]`;
      },
    );

    content = content.replace(
      EMBED_PRESERVE_REGEX,
      (_match, _display: string, encodedTarget: string) => {
        const target = decodeURIComponent(encodedTarget);
        return `![[${target}]]`;
      },
    );

    return { content, metadata: input.metadata };
  }
}
