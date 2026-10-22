import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND_RE } from "../../constants/markers.js";
import { calloutIcons } from "../callout-types.js";

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

    for (const [emoji, type] of calloutIcons()) {
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
