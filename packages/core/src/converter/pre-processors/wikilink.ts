import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  WikilinkEntry,
  PreserveMarker,
} from "../../types/convert.js";
import { WIKILINK_PROTOCOL } from "../../constants/markers.js";
import { computeAnchor, mapOutsideCode } from "../../utils/md-regions.js";
import { encodeMarkerTarget } from "../marker-url.js";

/**
 * 대상·별칭 어디에도 `[` `]` 를 허용하지 않는다 — 안쪽 링크를 잡게 하기 위해서다.
 * `[^\]|]+` 였을 때 `[[[happy]]]`(감정 태그를 대괄호로 한 번 더 감싼 노트, 실볼트
 * 1181건/13파일)의 대상이 `[happy` 로 잡혀 존재하지 않는 페이지를 가리켰고, 남은
 * `]` 하나가 링크 밖으로 삐져나와 문법이 깨졌다. 이제 `[` + `[[happy]]` + `]` 로
 * 갈라져 사용자가 쓴 그대로 왕복한다.
 */
const WIKILINK_REGEX = /(?<!!)\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;

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

    /*
     * 코드 펜스·인라인 코드 **안쪽은 건너뛴다**. Obsidian 은 코드 구간의 `[[…]]` 를 링크로
     * 렌더하지 않는데, 예전엔 여기서 무차별 치환해 위키링크 문법을 설명하는 코드블록이
     * Notion 에서 `[코드 안 링크](im-nobsidian://wikilink/%EC%BD%94…)` 라는 URL 범벅으로
     * 보였다(실측 D-WIKI-CODEFENCE). pull 이 되돌리므로 왕복은 멀쩡했지만, Notion 쪽 화면이
     * 깨지는 건 그 자체로 결함이다 — pull 의 리터럴 이스케이프 판정과도 이제 대칭을 이룬다.
     */
    const resolved = mapOutsideCode(input.content, (segment, base) =>
      segment.replace(
        WIKILINK_REGEX,
        (_match: string, target: string, display: string | undefined, offset: number) => {
          const label = display ?? target;

          if (this.resolve) {
            const entry = this.resolve(target);
            if (entry) {
              // Notion page mention 은 라벨을 가질 수 없다 — 항상 대상 페이지의 현재
              // 제목을 렌더한다. 별칭이 붙은 링크를 mention 으로 올리면 `[[A|별칭]]` 의
              // 별칭이 Notion 에서 소실되고 pull 때 `[[A 의 제목]]` 으로 되돌아온다.
              // 별칭이 있을 때만 라벨을 가질 수 있는 일반 페이지 링크로 내보낸다 —
              // Notion 에서 클릭 가능하고, pull 은 id 역조회로 `[[대상|별칭]]` 을 복원한다.
              if (display !== undefined && display !== target) {
                return `[${label}](https://www.notion.so/${entry.notionPageId.replace(/-/g, "")})`;
              }
              return `<mention-page id="${entry.notionPageId}">${label}</mention-page>`;
            }
          }

          // F28 교훈: startIndex 0 하드코딩은 pull 재삽입 시 프론트매터 앞 오염을
          // 낳았다. 실제 오프셋 + 텍스트 앵커를 남겨 위치 복원이 가능하게 한다.
          const params: Record<string, string> = display
            ? { text: target, display }
            : { text: target };
          params.__anchor = computeAnchor(input.content, base + offset);
          preserveMarkers.push({
            type: "wikilink",
            params,
            startIndex: base + offset,
          });

          return `[${label}](${WIKILINK_PROTOCOL}${encodeMarkerTarget(target)})`;
        },
      ),
    );

    return {
      content: resolved,
      metadata: { ...input.metadata, preserveMarkers },
    };
  }
}
