import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  WikilinkEntry,
  PreserveMarker,
} from "../../types/convert.js";
import { WIKILINK_PROTOCOL } from "../../constants/markers.js";
import { computeAnchor } from "../../utils/md-regions.js";

const WIKILINK_REGEX = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export type WikilinkResolverFn = (text: string) => WikilinkEntry | null;

export class WikilinkResolver implements Processor {
  readonly name = "WikilinkResolver";
  readonly order = 20;

  constructor(private readonly resolve?: WikilinkResolverFn) {}

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    const preserveMarkers: PreserveMarker[] = input.metadata.preserveMarkers
      ? [...input.metadata.preserveMarkers]
      : [];

    const resolved = input.content.replace(
      WIKILINK_REGEX,
      (_match: string, target: string, display: string | undefined, offset: number) => {
        const label = display ?? target;

        if (this.resolve) {
          const entry = this.resolve(target);
          if (entry) {
            return `<mention-page id="${entry.notionPageId}">${label}</mention-page>`;
          }
        }

        // F28 교훈: startIndex 0 하드코딩은 pull 재삽입 시 프론트매터 앞 오염을
        // 낳았다. 실제 오프셋 + 텍스트 앵커를 남겨 위치 복원이 가능하게 한다.
        const params: Record<string, string> = display
          ? { text: target, display }
          : { text: target };
        params.__anchor = computeAnchor(input.content, offset);
        preserveMarkers.push({
          type: "wikilink",
          params,
          startIndex: offset,
        });

        const encodedTarget = encodeURIComponent(target);
        return `[${label}](${WIKILINK_PROTOCOL}${encodedTarget})`;
      },
    );

    return {
      content: resolved,
      metadata: { ...input.metadata, preserveMarkers },
    };
  }
}
