import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import type { PreserveMarker } from "../../types/convert.js";
import { MARKER_BRAND_RE } from "../../constants/markers.js";
import { computeAnchor } from "../../utils/md-regions.js";

const MARKER_REGEX = new RegExp(`%% ${MARKER_BRAND_RE}:(\\w[\\w-]*):([^\\s]+?) %%`, "g");

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
        params: parseMarkerParams(match[2]!, input.content, match.index!),
        startIndex: match.index!,
      });
    }

    return {
      content: input.content,
      metadata: { ...input.metadata, preserveMarkers: markers },
    };
  }
}

/**
 * 파라미터 파싱. `k=v&k2=v2` 형식이 아닌 원시 페이로드(`local-image:경로` 류)는
 * `__raw` 로 원문 보존한다 — 과거엔 빈 객체로 저장돼 재삽입 시
 * `%% brand:local-image: %%` 껍데기 마커가 생성됐다(F29).
 * `__anchor` 는 push 시점 오프셋이 무의미해진 pull 산출물에서의 위치 복원 수단.
 */
function parseMarkerParams(
  paramString: string,
  content: string,
  index: number,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (paramString.includes("=")) {
    for (const pair of paramString.split("&")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        params[pair.slice(0, eqIdx)] = decodeURIComponent(pair.slice(eqIdx + 1));
      }
    }
  } else {
    params.__raw = paramString;
  }
  params.__anchor = computeAnchor(content, index);
  return params;
}
