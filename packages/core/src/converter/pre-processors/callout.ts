import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { spacedMarker } from "../../constants/markers.js";
import { DEFAULT_CALLOUT_TYPE, calloutIconOf } from "../callout-types.js";

const CALLOUT_REGEX = /^> \[!(\w+)\]([+-])?\s*(.*)?$/gm;

export class CalloutTransformer implements Processor {
  readonly name = "CalloutTransformer";
  readonly order = 30;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.path === "markdown-api") {
      return { content: input.content, metadata: input.metadata };
    }

    const content = input.content.replace(
      CALLOUT_REGEX,
      (_match, type: string, foldable: string | undefined, title: string | undefined) => {
        const emoji = calloutIconOf(type) ?? calloutIconOf(DEFAULT_CALLOUT_TYPE)!;
        const titleText = title?.trim() || type;
        const foldMeta = foldable
          ? `\n${spacedMarker(`callout:type=${type}&foldable=${foldable === "+" ? "open" : "closed"}`)}`
          : `\n${spacedMarker(`callout:type=${type}`)}`;

        return `> ${emoji} **${titleText}**${foldMeta}`;
      },
    );

    return {
      content,
      metadata: input.metadata,
    };
  }
}
