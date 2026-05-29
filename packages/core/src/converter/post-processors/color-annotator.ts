import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND_RE } from "../../constants/markers.js";

const COLOR_MARKER_REGEX = new RegExp(
  `%% ${MARKER_BRAND_RE}:color:(\\w+(?:_background)?) %%([\\s\\S]*?)%% ${MARKER_BRAND_RE}:end %%`,
  "g",
);

export class ColorAnnotator implements Processor {
  readonly name = "ColorAnnotator";
  readonly order = 30;

  process(input: ProcessorInput): ProcessorOutput {
    const content = input.content.replace(
      COLOR_MARKER_REGEX,
      (_match, color: string, text: string) => {
        const cssClass = color.endsWith("_background")
          ? `notion-${color.replace("_background", "-bg")}`
          : `notion-${color}`;
        return `<span class="${cssClass}">${text}</span>`;
      },
    );

    return {
      content,
      metadata: input.metadata,
    };
  }
}
