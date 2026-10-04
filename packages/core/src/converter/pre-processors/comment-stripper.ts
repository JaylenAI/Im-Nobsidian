import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  PreserveMarker,
} from "../../types/convert.js";
import { computeAnchor } from "../../utils/md-regions.js";
import { cutComments } from "../comments.js";

/**
 * Obsidian 주석(`%%...%%`)과 HTML 주석(`<!--...-->`)은 로컬 전용 표기다 —
 * Notion 에 평문으로 노출되면 사적 메모가 유출된다(F26; HTML 주석은 P5 push
 * E2E 실측으로 확인). push 시 본문에서 제거한다. 지우는 규칙과 찾는 규칙은 {@link cutComments}.
 *
 * pull 은 받기 직전의 로컬 노트에서 주석을 되살린다(`CommentRestorer`). 여기 남기는 preserve
 * marker(DB)는 로컬 노트가 없을 때(지운 노트를 되살리는 pull)의 대비다 — 그때는 앵커 줄 다음에
 * 원래 문법(`params.style` 구분)으로 끼운다(`PreserveMarkerInjector`). 앵커는 주석을 지운 글에서
 * 잡는다 — Notion 에 있는 것은 그 글이다.
 *
 * im-nobsidian 브랜드 마커(`%%im-nobsidian:...%%`·`%% im-nobsidian:... %%`)와
 * 닫는 토큰(`%%/color%%` 류)은 동기화 자체의 운반체이므로 건드리지 않는다.
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

    const { content, cuts } = cutComments(input.content);
    for (const cut of cuts) {
      const anchor = computeAnchor(content, cut.at);
      for (const comment of cut.comments) {
        markers.push({
          type: "comment",
          params: {
            text: comment.text,
            ...(comment.style === "html" ? { style: "html" } : {}),
            __anchor: anchor,
          },
          startIndex: cut.at,
        });
      }
    }

    return {
      content,
      metadata: { ...input.metadata, preserveMarkers: markers },
    };
  }
}
