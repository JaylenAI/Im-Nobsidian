import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const BLOCK_MATH_REGEX = /\$\$([\s\S]+?)\$\$/g;
const INLINE_MATH_REGEX = /(?<![\\$])\$([^\n$]+?)\$(?!\$)/g;

export class MathNormalizer implements Processor {
  readonly name = "MathNormalizer";
  readonly order = 50;

  process(input: ProcessorInput): ProcessorOutput {
    let content = input.content;

    content = content.replace(BLOCK_MATH_REGEX, (_match, equation: string) => {
      return `$$\n${equation.trim()}\n$$`;
    });

    content = content.replace(INLINE_MATH_REGEX, (_match, equation: string) => {
      return `$${equation.trim()}$`;
    });

    return {
      content,
      metadata: input.metadata,
    };
  }
}
