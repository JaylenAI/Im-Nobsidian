import type { IStateDB } from "../state/state-db-interface.js";

/**
 * N8 — 다시 보내야 멘션이 되는 노트. push 를 마친 뒤 한 번 더 보는 후처리 패스다(pull 의
 * `notion-link-pass` 와 같은 자리).
 *
 * push 는 노트를 하나씩 올리며 `[[대상]]` 을 그때 아는 페이지로만 멘션으로 바꾼다. 같은 push 에서 뒤에
 * 만드는 노트로 가는 링크는 아직 대상이 없어 글 링크(`im-nobsidian://wikilink/…`)로 올라갔고, 그 노트를
 * 고치기 전까지 다시 보내지 않아 Notion 에서 계속 글이었다. 풀지 못한 위키링크는 보존 마커(`wikilink`)로
 * 상태 DB 에 남으므로, 그 대상이 지금 풀리는 노트를 다시 보내면 멘션이 된다. 다시 보내면 마커가 새로
 * 적혀 같은 노트를 또 고르지 않는다.
 *
 * @returns 다시 보낼 노트 경로 — 경로 순
 */
export function notesWithResolvableWikilinks(stateDb: IStateDB): string[] {
  const paths: string[] = [];
  for (const record of stateDb.getAll()) {
    if (!record.notionPageId || record.status !== "synced") continue;
    const resolvable = stateDb
      .getPreserveMarkers(record.obsidianPath)
      .some(
        (marker) =>
          marker.type === "wikilink" &&
          marker.params.text !== undefined &&
          stateDb.resolveWikilink(marker.params.text) !== null,
      );
    if (resolvable) paths.push(record.obsidianPath);
  }
  return paths.sort();
}
