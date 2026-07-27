/**
 * `[[notion:<id>]]` / `[[notion:<id>|별칭]]` 을 볼트 위키링크로 되돌린다.
 *
 * pull 1차 변환(`notionEnhancedToObsidian`)은 page mention 과 라벨 달린 페이지 링크를
 * 전부 이 중간 형태로 환원한다. 여기서 id → 볼트 경로 역조회로 최종 `[[제목]]` 을 만든다.
 * 볼트 밖/미추적 페이지면 중간 형태를 그대로 남겨 정보 손실을 막는다.
 *
 * 오케스트레이터(state DB)와 테스트가 같은 규칙을 봐야 하므로 순수 함수로 분리한다.
 */

/** notion page id(하이픈 없는 32 hex) → 볼트 파일 경로. 미추적이면 null. */
export type NotionIdToPath = (id: string) => string | null;

const NOTION_ID_WIKILINK_RE = /\[\[notion:([a-f0-9]{32})(\|[^[\]]+)?\]\]/g;

export function resolveNotionIdWikilinks(markdown: string, lookup: NotionIdToPath): string {
  return markdown.replace(NOTION_ID_WIKILINK_RE, (match, id: string, alias: string | undefined) => {
    const path = lookup(id);
    if (!path) return match;
    const base = path.split("/").pop() ?? path;
    // 별칭은 push 가 라벨 달린 페이지 링크로 실어 보낸 `[[대상|별칭]]` 의 별칭이다 —
    // 대상만 역조회로 채우고 별칭은 그대로 살려야 왕복이 닫힌다.
    return `[[${base.replace(/\.md$/, "")}${alias ?? ""}]]`;
  });
}
