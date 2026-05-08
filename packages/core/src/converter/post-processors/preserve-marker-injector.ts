import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

export class PreserveMarkerInjector implements Processor {
  readonly name = "PreserveMarkerInjector";
  readonly order = 100;

  process(input: ProcessorInput): ProcessorOutput {
    return {
      content: input.content,
      metadata: input.metadata,
    };
  }
}
