import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { isNotionObjectNotFound, isTrashedOrArchived } from "../notion/client.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { SyncRecord } from "../types/sync.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * 목록에 없던 추적 페이지 · 행을 원격에 물어본 결과(S-12).
 *
 * 목록에 없다는 것은 사라졌다는 뜻이 아니다. 페이지 순회는 행을 보지 못하고 마감에 잘리며, search
 * 는 색인이 늦다. 조회에 없던 행은 다른 DB 로 옮겨졌을 수 있다. 목록만 믿고 지우면 멀쩡한 노트가
 * 볼트에서 사라진다 — 그래서 지우기 전에 하나씩 물어본다. 평소에는 목록에 없는 추적 항목이 없어
 * 요청이 들지 않는다.
 */
export type RemotePresence =
  { readonly kind: "gone" } | { readonly kind: "alive"; readonly page: PageObjectResponse };

/**
 * 휴지통 · 보관 · 없음(404)이면 사라졌다. 그 밖의 오류는 던진다 — 읽지 못한 것을 사라진 것으로 보면
 * 멀쩡한 노트를 지운다.
 */
export async function remotePresence(
  client: NotionClient,
  pageId: string,
): Promise<RemotePresence> {
  let page: PageObjectResponse;
  try {
    page = await client.getPage(pageId);
  } catch (error) {
    if (isNotionObjectNotFound(error)) return { kind: "gone" };
    throw error;
  }
  return isTrashedOrArchived(page) ? { kind: "gone" } : { kind: "alive", page };
}

/**
 * 원격에서 사라진 노트를 볼트에서 지우고 추적을 놓는다 — 페이지(오케스트레이터)와 DB 행
 * (DatabaseSyncer)이 같이 쓴다. 파일은 `deleteFile`(deleteSync)일 때만 지운다.
 */
export async function applyRemoteDeletion(
  stateDb: IStateDB,
  vaultFs: VaultFS,
  record: SyncRecord,
  deleteFile: boolean,
): Promise<void> {
  if (deleteFile) {
    try {
      await vaultFs.deleteFile(record.obsidianPath);
    } catch {
      // 이미 삭제된 경우 무시
    }
  }
  stateDb.transaction(() => {
    stateDb.delete(record.id);
    stateDb.deleteWikilink(record.obsidianPath);
  });
}
