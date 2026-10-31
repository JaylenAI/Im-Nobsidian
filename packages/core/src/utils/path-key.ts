import type { IStateDB } from "../state/state-db-interface.js";
import { notionIdsEqual } from "./id.js";

/**
 * 같은 파일로 열리는 경로인가를 견주는 열쇠 — NFC 로 맞추고 대소문자를 접는다.
 *
 * macOS(APFS 기본) · Windows(NTFS) 는 `Note.md` 와 `note.md` 를 같은 파일로 연다. 받으며 두 페이지에 이 두 이름을 주면
 * 나중에 쓴 페이지가 앞의 파일을 덮어 본문이 사라진다. Linux 에서도 같게 피한다 — 볼트는 git · 동기화 앱으로 다른 OS 에
 * 옮겨 간다. 이미 그렇게 따로 있는 두 노트(Linux)는 그대로 둔다 — 자기 자리는 언제나 다시 쓴다.
 */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * 대소문자만 다른 이름을 다른 페이지가 기록에 갖고 있나 — 그 이름을 고르면 macOS · Windows 에서 그 파일을 덮는다. 같은
 * 페이지의 옛 이름(Notion 에서 제목의 대소문자만 바꾼 것)은 막지 않는다 — 그 자리로 옮겨 간다.
 */
export function foldedOwnerOf(
  stateDb: Pick<IStateDB, "getByPathKey">,
  candidate: string,
  pageId: string,
): boolean {
  return stateDb
    .getByPathKey(candidate)
    .some(
      (record) =>
        record.obsidianPath !== candidate &&
        !(record.notionPageId != null && notionIdsEqual(record.notionPageId, pageId)),
    );
}
