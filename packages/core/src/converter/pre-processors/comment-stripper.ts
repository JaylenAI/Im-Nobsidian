import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  PreserveMarker,
} from "../../types/convert.js";
import { MARKER_BRAND } from "../../constants/markers.js";
import { mapOutsideCodeFences, computeAnchor } from "../../utils/md-regions.js";

const COMMENT_REGEX = /%%([\s\S]*?)%%/g;
const HTML_COMMENT_REGEX = /<!--([\s\S]*?)-->/g;

/**
 * Obsidian 주석(`%%...%%`)과 HTML 주석(`<!--...-->`)은 로컬 전용 표기다 —
 * Notion 에 평문으로 노출되면 사적 메모가 유출된다(F26; HTML 주석은 P5 push
 * E2E 실측으로 확인). push 시 본문에서 제거하되, preserve marker(DB)로 남겨
 * pull 재작성 시 앵커 위치에 원래 문법(`params.style` 구분)으로 복원한다.
 *
 * im-nobsidian 브랜드 마커(`%%im-nobsidian:...%%`·`%% im-nobsidian:... %%`)와
 * 닫는 토큰(`%%/color%%` 류)은 동기화 자체의 운반체이므로 건드리지 않는다.
 * HTML 주석 문법은 브랜드 마커가 쓰지 않으므로 무조건 제거한다.
 */
export class CommentStripper implements Processor {
  readonly name = "CommentStripper";
  // FrontmatterExtractor(10) 뒤 — YAML 값 속 `%%` 를 본문 주석으로 오인하지 않는다.
  readonly order = 11;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    const markers: PreserveMarker[] = input.metadata.preserveMarkers
      ? [...input.metadata.preserveMarkers]
      : [];

    const content = mapOutsideCodeFences(input.content, (segment) => {
      const afterObsidian = segment.replace(
        COMMENT_REGEX,
        (match, body: string, offset: number) => {
          const trimmed = body.trimStart();
          if (trimmed.startsWith(`${MARKER_BRAND}:`) || trimmed.startsWith("/")) {
            return match;
          }
          markers.push({
            type: "comment",
            params: { text: body, __anchor: computeAnchor(segment, offset) },
            startIndex: offset,
          });
          return "";
        },
      );
      return afterObsidian.replace(HTML_COMMENT_REGEX, (_match, body: string, offset: number) => {
        markers.push({
          type: "comment",
          params: { text: body, style: "html", __anchor: computeAnchor(afterObsidian, offset) },
          startIndex: offset,
        });
        return "";
      });
    });

    return {
      content,
      metadata: { ...input.metadata, preserveMarkers: markers },
    };
  }
}
