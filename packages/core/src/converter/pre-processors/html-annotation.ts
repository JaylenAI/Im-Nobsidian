import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND_RE } from "../../constants/markers.js";

const UNDERLINE_REGEX = /<u>([\s\S]*?)<\/u>/g;

const COLOR_SPAN_REGEX = /<span class="notion-(\w+?)(?:-bg)?">([\s\S]*?)<\/span>/g;

const IM_NOBSIDIAN_COLOR_REGEX = new RegExp(
  `%% ${MARKER_BRAND_RE}:color:(\\w+(?:_background)?) %%([\\s\\S]*?)%% ${MARKER_BRAND_RE}:end %%`,
  "g",
);

export class HtmlAnnotationStripper implements Processor {
  readonly name = "HtmlAnnotationStripper";
  readonly order = 5;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    let content = input.content;

    content = content.replace(IM_NOBSIDIAN_COLOR_REGEX, (_m, _color: string, text: string) => text);

    content = content.replace(UNDERLINE_REGEX, (_m, text: string) => text);

    content = content.replace(COLOR_SPAN_REGEX, (_m, _color: string, text: string) => text);

    return { content, metadata: input.metadata };
  }
}
