import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  WikilinkEntry,
  PreserveMarker,
} from "../../types/convert.js";

const WIKILINK_REGEX = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export type WikilinkResolverFn = (text: string) => WikilinkEntry | null;

export class WikilinkResolver implements Processor {
  readonly name = "WikilinkResolver";
  readonly order = 20;

  constructor(private readonly resolve?: WikilinkResolverFn) {}

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    const preserveMarkers: PreserveMarker[] = input.metadata.preserveMarkers
      ? [...input.metadata.preserveMarkers]
      : [];

    const resolved = input.content.replace(
      WIKILINK_REGEX,
      (_match, target: string, display?: string) => {
        const label = display ?? target;

        if (this.resolve) {
          const entry = this.resolve(target);
          if (entry) {
            return `<mention-page id="${entry.notionPageId}">${label}</mention-page>`;
          }
        }

        preserveMarkers.push({
          type: "wikilink",
          params: display ? { text: target, display } : { text: target },
          startIndex: 0,
        });

        const encodedTarget = encodeURIComponent(target);
        return `[${label}](im-nobsidian://wikilink/${encodedTarget})`;
      },
    );

    return {
      content: resolved,
      metadata: { ...input.metadata, preserveMarkers },
    };
  }
}
