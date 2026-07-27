import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  PreserveMarker,
} from "../../types/convert.js";
import { MARKER_BRAND } from "../../constants/markers.js";
import { mapOutsideCodeFences, mapOutsideMarkers, computeAnchor } from "../../utils/md-regions.js";

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
 *
 * 마커 회피는 **본문에서 마커 토큰을 먼저 떼어 낸 뒤**(`mapOutsideMarkers`) 남은 평문에만
 * 주석 정규식을 돌리는 방식이다. 예전처럼 매치 본문의 접두만 보고 되돌리면, 구분자 짝짓기
 * 자체는 이미 마커의 `%%` 를 소비한 뒤라 늦다 — 본문 한가운데의 홑 `%%`(예: `압축률 100%%`)가
 * 마커 여는 `%%` 와 짝지어져 그 사이 문장과 마커 내용이 통째로 삭제됐다(실측 D-COMMENT-PAIR).
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
      const afterObsidian = mapOutsideMarkers(segment, (plain, base) =>
        plain.replace(COMMENT_REGEX, (match, body: string, offset: number) => {
          // 개행이 섞여 MARKER_TOKEN_RE 에 안 걸린 깨진 마커까지 삼키지 않도록 남겨 둔 방어선.
          const trimmed = body.trimStart();
          if (trimmed.startsWith(`${MARKER_BRAND}:`) || trimmed.startsWith("/")) {
            return match;
          }
          markers.push({
            type: "comment",
            params: { text: body, __anchor: computeAnchor(segment, base + offset) },
            startIndex: base + offset,
          });
          return "";
        }),
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
