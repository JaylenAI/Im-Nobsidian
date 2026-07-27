/**
 * `[[notion:<id>]]` / `[[notion:<id>|별칭]]` 을 볼트 위키링크로 되돌린다.
 *
 * pull 1차 변환(`notionEnhancedToObsidian`)은 page mention 과 라벨 달린 페이지 링크를
 * 전부 이 중간 형태로 환원한다. 여기서 id → 볼트 경로 역조회로 최종 `[[제목]]` 을 만든다.
 * 볼트 밖/미추적 페이지면 중간 형태를 그대로 남겨 정보 손실을 막는다.
 *
 * 오케스트레이터(state DB)와 테스트가 같은 규칙을 봐야 하므로 순수 함수로 분리한다.
 * **이 파일이 유일한 해소 지점이다** — 오케스트레이터의 pull 후처리(resolveNotionLinks)도
 * 자체 정규식을 두지 않고 이 함수를 부른다. 예전엔 후처리가 별칭 없는 형태만 아는
 * 정규식을 따로 갖고 있어, 변환 시점에 대상이 아직 안 만들어진 링크(같은 pull 안의
 * 정방향 참조)가 별칭을 달고 있으면 **대상이 볼트에 실재하는데도** 영영
 * `[[notion:<id>|별칭]]` 으로 남았다(실볼트 2건 실측).
 */

/** notion page id → 볼트 파일 경로. 미추적이면 null. */
export type NotionIdToPath = (id: string) => string | null;

export interface NotionIdWikilinkResolution {
  markdown: string;
  /** 실제로 `[[제목]]` 으로 바뀐 링크 수 — 호출자가 로그·통계에 그대로 쓴다. */
  resolved: number;
}

/**
 * id 표기는 두 가지가 다 들어온다 — 변환기가 만드는 압축형(32 hex)과 상태 DB·Notion
 * API 의 하이픈형(36자). 한쪽만 받으면 다른 쪽 경로의 링크가 통째로 미해소로 남는다.
 */
const NOTION_ID_WIKILINK_RE = /\[\[notion:([a-f0-9]{32}|[a-f0-9-]{36})(?:\|([^[\]]+))?\]\]/g;

export function resolveNotionIdWikilinks(
  markdown: string,
  lookup: NotionIdToPath,
): NotionIdWikilinkResolution {
  let resolved = 0;
  const out = markdown.replace(
    NOTION_ID_WIKILINK_RE,
    (match, id: string, alias: string | undefined) => {
      const path = lookup(id);
      if (!path) return match;
      resolved++;
      const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
      // 별칭은 push 가 라벨 달린 페이지 링크로 실어 보낸 `[[대상|별칭]]` 의 별칭이다 —
      // 대상만 역조회로 채우고 별칭은 그대로 살려야 왕복이 닫힌다.
      //
      // 단, 별칭이 대상 제목과 **같으면** 버린다. `[[X|X]]` 는 `[[X]]` 와 뜻이 같은데,
      // push 의 분기(별칭 유무로 mention/라벨 링크를 가른다)를 헛돌게 해 mention 이어야
      // 할 링크를 평범한 URL 링크로 내보낸다. breadcrumb 처럼 라벨이 곧 대상 제목인
      // 링크가 여기 해당하며 실볼트에 45건 쌓여 있었다.
      return alias === undefined || alias === base ? `[[${base}]]` : `[[${base}|${alias}]]`;
    },
  );
  return { markdown: out, resolved };
}
