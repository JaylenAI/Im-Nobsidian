import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const COLOR_MARKER_REGEX =
  /%% im-nobsidian:color:(\w+(?:_background)?) %%([\s\S]*?)%% im-nobsidian:end %%/g;

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
