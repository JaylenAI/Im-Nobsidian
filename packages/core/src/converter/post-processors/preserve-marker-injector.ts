import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  PreserveMarker,
} from "../../types/convert.js";
import { spacedMarker } from "../../constants/markers.js";

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

    // 유실 마커를 원래 위치(startIndex) 기준으로 재삽입한다.
    // startIndex 오름차순으로 처리하면 앞선 마커가 먼저 복원되어, 각 마커의 절대 startIndex 가
    // 현재 문자열에서도 유효하다 — 변환이 주변 텍스트를 보존한 채 마커만 제거한 경우 원본
    // 전체 문자열을 정확히 재구성한다(위치 무손실). startIndex 가 현재 길이를 넘으면(stale
    // offset) 말미로 degrade 하는 것이 최후 보루다. 과거엔 항상 말미로 모아(append) 본문
    // 중간의 위치를 잃고도 '개수 보존'으로 위장했다 — 그 결함을 제거한다.
    const sorted = [...missingMarkers].sort((a, b) => a.startIndex - b.startIndex);
    for (const m of sorted) {
      const markerText = this.formatMarker(m);
      const at = Math.max(0, Math.min(m.startIndex, content.length));
      content = content.slice(0, at) + markerText + content.slice(at);
    }

    return { content, metadata: input.metadata };
  }

  private formatMarker(marker: PreserveMarker): string {
    const params = Object.entries(marker.params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return spacedMarker(`${marker.type}:${params}`);
  }
}
