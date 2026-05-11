import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  PreserveMarker,
} from "../../types/convert.js";

export class PreserveMarkerInjector implements Processor {
  readonly name = "PreserveMarkerInjector";
  readonly order = 100;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const markers = input.metadata.preserveMarkers;
    if (!markers || markers.length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    let content = input.content;

    const missingMarkers = markers.filter((m) => !content.includes(this.formatMarker(m)));

    if (missingMarkers.length === 0) {
      return { content, metadata: input.metadata };
    }

    const markerLines = missingMarkers.map((m) => this.formatMarker(m));
    const suffix = "\n\n" + markerLines.join("\n");
    content = content.trimEnd() + suffix + "\n";

    return { content, metadata: input.metadata };
  }

  private formatMarker(marker: PreserveMarker): string {
    const params = Object.entries(marker.params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `%% obsinotion:${marker.type}:${params} %%`;
  }
}
