import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { liftHeadingMarkers } from "../heading-markers.js";

/**
 * 보내기 맨 앞 — 제목 아래 줄로 내린 블록 색 · 토글 헤딩 마커를 제목 줄 끝으로 되올린다. 뒤 전처리 · 변환기는
 * 제목 줄 끝의 마커만 안다(`converter/heading-markers.ts`).
 */
export class HeadingMarkerLifter implements Processor {
  readonly name = "HeadingMarkerLifter";
  readonly order = 0;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }
    return { content: liftHeadingMarkers(input.content), metadata: input.metadata };
  }
}
