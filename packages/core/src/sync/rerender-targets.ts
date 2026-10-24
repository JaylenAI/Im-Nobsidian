import type { IStateDB } from "../state/state-db-interface.js";
import type { RemoteChange, SyncRecord } from "../types/sync.js";
import { inAnyPathScope } from "../utils/path-scope.js";
import { isFolderRecord } from "./folder-container.js";

/**
 * `pull --rerender` 가 다시 그릴 받아 둔 노트(B14).
 *
 * pull 은 Notion 에서 바뀐 페이지만 받는다. 그래서 변환기가 나아져도 이미 받아 둔 노트는 그 페이지가
 * Notion 에서 바뀔 때까지 옛 모양으로 남았다 — 「🔖 Bookmark」 가 Notion 블록을 가리키는 옛 북마크
 * (실볼트 166개 · 54노트) · 코드 상자로 보이는 옛 4칸 자식. `--force` 도 훑는 범위만 넓힐 뿐 바뀌지
 * 않은 페이지는 다시 그리지 않는다.
 *
 * 대상은 볼트에서 고치지 않은 노트뿐이다 — 고친 노트는 이어지는 push 가 올린다. 받는 쪽(`pullUpdate`)도
 * 로컬이 지난 사본과 다르면 덮지 않으므로, 여기서 빼는 것은 요청을 아끼려는 것이다.
 *
 * @param scope.localChangedPaths 지난 동기화 뒤 볼트에서 바뀐 경로. 볼트를 읽지 못했으면 null — 모두
 *   후보로 두고 받는 쪽의 내용 확인에 맡긴다.
 * @param scope.queued 이미 받을 차례에 오른 페이지 — 두 번 받지 않는다.
 * @param scope.adopting 볼트에서 옮겨 이번에 옮겨 적는 레코드 — 레코드가 아직 옛 경로를 적고 있다.
 */
export function rerenderTargets(
  stateDb: Pick<IStateDB, "getAll">,
  scope: {
    readonly localChangedPaths: ReadonlySet<string> | null;
    readonly queued: ReadonlySet<string>;
    readonly adopting: ReadonlySet<string>;
    readonly paths?: string[];
    /** 설정이 동기화에서 뺀 경로(이슈 #8). */
    readonly excludes?: (path: string) => boolean;
  },
): RemoteChange[] {
  return stateDb
    .getAll()
    .filter(
      (record): record is SyncRecord & { notionPageId: string } =>
        isRerenderable(record) &&
        record.notionPageId !== null &&
        !scope.queued.has(record.notionPageId) &&
        !scope.adopting.has(record.id) &&
        !(scope.localChangedPaths?.has(record.obsidianPath) ?? false) &&
        inAnyPathScope(record.obsidianPath, scope.paths) &&
        !(scope.excludes?.(record.obsidianPath) ?? false),
    )
    .map((record) => ({
      pageId: record.notionPageId,
      type: "modified" as const,
      lastEdited: record.notionLastEdited ?? record.updatedAt,
      previousEdited: record.notionLastEdited,
      path: record.obsidianPath,
    }));
}

/** 노트 하나로 그리는 레코드 — 페이지 · 폴더 노트 · DB 행. 폴더 레코드는 볼트에 노트가 없다. */
function isRerenderable(record: SyncRecord): boolean {
  return (
    (record.fileType === "file" ||
      record.fileType === "folder-note" ||
      record.fileType === "db-row") &&
    !isFolderRecord(record) &&
    record.status === "synced"
  );
}
