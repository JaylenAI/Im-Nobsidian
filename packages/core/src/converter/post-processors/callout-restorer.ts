import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND_RE } from "../../constants/markers.js";

const EMOJI_TYPE_MAP: Record<string, string> = {
  "\u{1F4DD}": "note",
  "\u{1F4CB}": "abstract",
  "\u{2139}\u{FE0F}": "info",
  "\u{1F4A1}": "tip",
  "\u{2705}": "success",
  "\u{2753}": "question",
  "\u{26A0}\u{FE0F}": "warning",
  "\u{274C}": "failure",
  "\u{1F525}": "danger",
  "\u{1F41B}": "bug",
  "\u{1F4CC}": "example",
  "\u{1F4AC}": "quote",
};

const CALLOUT_PRESERVE_REGEX = new RegExp(
  `%% ${MARKER_BRAND_RE}:callout:type=(\\w+)(?:&foldable=(open|closed))? %%`,
  "g",
);

export class CalloutRestorer implements Processor {
  readonly name = "CalloutRestorer";
  readonly order = 20;

  process(input: ProcessorInput): ProcessorOutput {
    let content = input.content;

    content = content.replace(CALLOUT_PRESERVE_REGEX, (_match, type: string, foldable?: string) => {
      if (foldable) {
        const foldChar = foldable === "open" ? "+" : "-";
        return `[!${type}]${foldChar}`;
      }
      return `[!${type}]`;
    });

    for (const [emoji, type] of Object.entries(EMOJI_TYPE_MAP)) {
      const pattern = new RegExp(`> ${escapeRegex(emoji)} \\*\\*(.+?)\\*\\*`, "g");
      content = content.replace(pattern, (_match, title: string) => {
        if (title.toLowerCase() === type) {
          return `> [!${type}]`;
        }
        return `> [!${type}] ${title}`;
      });
    }

    return {
      content,
      metadata: input.metadata,
    };
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
