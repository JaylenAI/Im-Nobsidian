import { splitAnchor } from "../converter/anchor-links.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { PreserveMarker } from "../types/convert.js";
import type { SyncRecord } from "../types/sync.js";

/**
 * N8 — 다시 보내야 멘션 · 블록 링크가 되는 노트. push 를 마친 뒤 한 번 더 보는 후처리 패스다(pull 의
 * `notion-link-pass` 와 같은 자리).
 *
 * push 는 노트를 하나씩 올리며 `[[대상]]` 을 그때 아는 페이지로만 멘션으로 바꾼다. 같은 push 에서 뒤에
 * 만드는 노트로 가는 링크는 아직 대상이 없어 글 링크(`im-nobsidian://wikilink/…`)로 올라갔고, 그 노트를
 * 고치기 전까지 다시 보내지 않아 Notion 에서 계속 글이었다. 풀지 못한 위키링크는 보존 마커(`wikilink`)로
 * 상태 DB 에 남으므로, 그 대상이 지금 풀리는 노트를 다시 보내면 멘션이 된다. 다시 보내면 마커가 새로
 * 적혀 같은 노트를 또 고르지 않는다.
 *
 * 제목 · 블록 링크(`[[노트#제목]]` · `[[#제목]]`)는 마커의 `anchor` 가 못 푼 까닭을 적는다(P14).
 * - `page` — 그때 대상 페이지가 없었다(같은 push 에서 뒤에 만든 노트 · 새 노트의 자기 링크). 지금 페이지가 있으면 다시 보낸다
 * - `block` — 페이지는 있었지만 그 블록이 없었다. 대상 노트를 이번 push 가 올렸으면(제목이 생겼을 수 있다) 다시 보낸다.
 *   자기 링크는 다시 보내도 같다 — 고르지 않는다
 * - 없음 — v0.18 까지 적은 마커. 페이지가 있으면 한 번 다시 보낸다 — 다시 적힌 마커에는 까닭이 붙는다
 *
 * @param pushed 이번 push 가 올린 노트 경로
 * @returns 다시 보낼 노트 경로 — 경로 순
 */
export function notesWithResolvableWikilinks(
  stateDb: IStateDB,
  pushed: ReadonlySet<string> = new Set(),
): string[] {
  const paths: string[] = [];
  for (const record of stateDb.getAll()) {
    if (!record.notionPageId || record.status !== "synced") continue;
    const resolvable = stateDb
      .getPreserveMarkers(record.obsidianPath)
      .some((marker) => marker.type === "wikilink" && resolvesNow(stateDb, record, marker, pushed));
    if (resolvable) paths.push(record.obsidianPath);
  }
  return paths.sort();
}

function resolvesNow(
  stateDb: IStateDB,
  record: SyncRecord,
  marker: PreserveMarker,
  pushed: ReadonlySet<string>,
): boolean {
  const text = marker.params.text;
  if (text === undefined) return false;
  const split = splitAnchor(text);
  if (!split) return stateDb.resolveWikilink(text) !== null;
  const target = split.note === "" ? null : stateDb.resolveWikilink(split.note);
  if (split.note !== "" && target === null) return false;
  switch (marker.params.anchor) {
    case "page":
      return true;
    case "block":
      return (
        target !== null &&
        target.obsidianPath !== record.obsidianPath &&
        pushed.has(target.obsidianPath)
      );
    default:
      return true;
  }
}
