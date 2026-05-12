import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import type { PreserveMarker } from "../../types/convert.js";

const MARKER_REGEX = /%% im-nobsidian:(\w[\w-]*):([^\s]+?) %%/g;

export class PreserveMarkerCollector implements Processor {
  readonly name = "PreserveMarkerCollector";
  readonly order = 70;

  process(input: ProcessorInput): ProcessorOutput {
    const markers: PreserveMarker[] = input.metadata.preserveMarkers
      ? [...input.metadata.preserveMarkers]
      : [];

    const matches = [...input.content.matchAll(MARKER_REGEX)];
    for (const match of matches) {
      markers.push({
        type: match[1]!,
        params: parseMarkerParams(match[2]!),
        startIndex: match.index!,
      });
    }

    return {
      content: input.content,
      metadata: { ...input.metadata, preserveMarkers: markers },
    };
  }
}

function parseMarkerParams(paramString: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of paramString.split("&")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      params[pair.slice(0, eqIdx)] = decodeURIComponent(pair.slice(eqIdx + 1));
    }
  }
  return params;
}
