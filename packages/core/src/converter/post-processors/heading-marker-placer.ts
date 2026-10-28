import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { placeHeadingMarkersBelow } from "../heading-markers.js";

/**
 * 받기 맨 끝(order 140) — 제목 줄 끝의 블록 색 · 토글 헤딩 마커를 제목 아래 줄로 내린다. Obsidian 이 제목 줄의
 * 마커를 제목 글자로 읽어 개요 · 제목 링크에 보이기 때문이다(`converter/heading-markers.ts`). 로컬 꼴 되살리기
 * (130) 뒤에 돌아 예전 꼴로 받은 노트도 다음에 다시 받으면 새 꼴이 된다.
 */
export class HeadingMarkerPlacer implements Processor {
  readonly name = "HeadingMarkerPlacer";
  readonly order = 140;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }
    return { content: placeHeadingMarkersBelow(input.content), metadata: input.metadata };
  }
}
