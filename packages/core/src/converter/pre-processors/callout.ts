import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const CALLOUT_REGEX = /^> \[!(\w+)\]([+-])?\s*(.*)?$/gm;

const CALLOUT_EMOJI_MAP: Record<string, string> = {
  note: "\u{1F4DD}",
  abstract: "\u{1F4CB}",
  summary: "\u{1F4CB}",
  info: "\u{2139}\u{FE0F}",
  tip: "\u{1F4A1}",
  hint: "\u{1F4A1}",
  success: "\u{2705}",
  check: "\u{2705}",
  question: "\u{2753}",
  faq: "\u{2753}",
  warning: "\u{26A0}\u{FE0F}",
  caution: "\u{26A0}\u{FE0F}",
  failure: "\u{274C}",
  fail: "\u{274C}",
  danger: "\u{1F525}",
  error: "\u{1F525}",
  bug: "\u{1F41B}",
  example: "\u{1F4CC}",
  quote: "\u{1F4AC}",
  cite: "\u{1F4AC}",
};

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
        const emoji = CALLOUT_EMOJI_MAP[type.toLowerCase()] ?? "\u{1F4DD}";
        const titleText = title?.trim() || type;
        const foldMeta = foldable
          ? `\n%% im-nobsidian:callout:type=${type}&foldable=${foldable === "+" ? "open" : "closed"} %%`
          : "";

        return `> ${emoji} **${titleText}**${foldMeta}`;
      },
    );

    return {
      content,
      metadata: input.metadata,
    };
  }
}
