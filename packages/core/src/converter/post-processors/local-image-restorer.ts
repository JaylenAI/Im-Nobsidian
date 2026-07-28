import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_PAYLOAD_CHAR, MEDIA_PLACEHOLDER_HEAD } from "../../constants/markers.js";
import { decodeMarkerTarget } from "../marker-url.js";

/**
 * push 가 심은 미디어 자리표시자를 원래 임베드로 되돌린다.
 *
 * 대상 경로는 공백을 포함할 수 있어(`![[내 사진.png]]`) 닫는 `%%` 까지 비탐욕 매칭한다 —
 * `[^\s]+` 로 끊으면 공백 있는 경로가 통째로 복원되지 않고 마커가 본문에 남았다.
 *
 * 경로는 push 가 퍼센트 인코딩해 실으므로 여기서 되돌린다. 인코딩 이전에 올라간
 * 구버전 마커는 원문 `%` 를 품고 있어 {@link MARKER_PAYLOAD_CHAR} 로 받고,
 * `decodeMarkerTarget` 이 잘못된 이스케이프에 원문을 돌려주므로 그대로 살아난다.
 */
const LOCAL_IMAGE_MARKER_REGEX = new RegExp(
  `${MEDIA_PLACEHOLDER_HEAD}(${MARKER_PAYLOAD_CHAR}+?)\\s*%%`,
  "g",
);

export class LocalImageRestorer implements Processor {
  readonly name = "LocalImageRestorer";
  readonly order = 15;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const content = input.content.replace(LOCAL_IMAGE_MARKER_REGEX, (_match, target: string) => {
      return `![[${decodeMarkerTarget(target)}]]`;
    });

    return { content, metadata: input.metadata };
  }
}
