import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { restoreLinkMarkers } from "../link-restore.js";

export class MentionToWikilink implements Processor {
  readonly name = "MentionToWikilink";
  readonly order = 10;

  process(input: ProcessorInput): ProcessorOutput {
    return { content: restoreLinkMarkers(input.content), metadata: input.metadata };
  }
}
