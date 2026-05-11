import type {
  ConversionContext,
  ConversionPath,
  ConversionResult,
  Processor,
  ProcessorInput,
  ProcessorMetadata,
} from "../types/convert.js";

export class ConversionPipeline {
  private readonly preProcessors: Processor[] = [];
  private readonly postProcessors: Processor[] = [];

  registerPreProcessor(processor: Processor): void {
    this.preProcessors.push(processor);
    this.preProcessors.sort((a, b) => a.order - b.order);
  }

  registerPostProcessor(processor: Processor): void {
    this.postProcessors.push(processor);
    this.postProcessors.sort((a, b) => a.order - b.order);
  }

  selectPath(content: string): ConversionPath {
    const hasInlineDb = /%% obsinotion:inline-db/.test(content);
    const hasColumnLayout = />\s*\[!col\]/.test(content);
    const hasToggleHeading = /%% obsinotion:toggle-heading/.test(content);

    if (hasInlineDb || hasColumnLayout || hasToggleHeading) {
      return "block-api";
    }

    return "markdown-api";
  }

  convertToNotion(markdown: string, context: ConversionContext): ConversionResult {
    let input: ProcessorInput = {
      content: markdown,
      metadata: {},
      context,
    };

    for (const processor of this.preProcessors) {
      try {
        const output = processor.process(input);
        input = {
          content: output.content,
          metadata: output.metadata,
          context,
        };
      } catch (error) {
        console.warn(`[${processor.name}] Pre-processor failed:`, error);
      }
    }

    return {
      content: input.content,
      properties: (input.metadata.properties as Record<string, unknown>) ?? {},
      images: input.metadata.images ?? [],
      preserveMarkers: input.metadata.preserveMarkers ?? [],
    };
  }

  convertToMarkdown(
    content: string,
    context: ConversionContext,
    metadata?: ProcessorMetadata,
  ): string {
    let input: ProcessorInput = {
      content,
      metadata: metadata ?? {},
      context,
    };

    for (const processor of this.postProcessors) {
      try {
        const output = processor.process(input);
        input = {
          content: output.content,
          metadata: output.metadata,
          context,
        };
      } catch (error) {
        console.warn(`[${processor.name}] Post-processor failed:`, error);
      }
    }

    return input.content;
  }
}
