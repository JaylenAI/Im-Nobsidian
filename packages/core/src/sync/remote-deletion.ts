import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { isNotionObjectNotFound, isTrashedOrArchived } from "../notion/client.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Conflict, ConflictStrategy, RemoteChange, SyncRecord } from "../types/sync.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
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
 * 원격에서 사라진 노트를 볼트에 반영한 결과.
 *
 * - `deleted` — 파일(deleteSync)과 추적을 지웠다.
 * - `kept` — 올리지 않은 로컬 편집이 있어 파일을 두고 추적만 놓았다(local-first). 다음 push 가 새
 *   페이지로 만든다.
 * - `conflict` — 올리지 않은 로컬 편집이 있어 파일과 추적을 두고 충돌로 남겼다(manual · duplicate).
 */
export type RemoteDeletionOutcome =
  | { readonly action: "deleted" }
  | { readonly action: "kept" }
  | { readonly action: "conflict"; readonly conflict: Conflict };

export interface RemoteDeletionOptions {
  /** 볼트 파일도 지우는가(deleteSync). 아니면 추적만 놓고 파일은 늘 둔다. */
  readonly deleteFile: boolean;
  /** 로컬 편집과 원격 삭제가 겹치면 무엇이 이기나. */
  readonly strategy: ConflictStrategy;
  /** 충돌로 남길 때 싣는 원격 변경(`type: "deleted"`). */
  readonly remoteChange: RemoteChange;
}

/**
 * 원격에서 사라진 노트를 볼트에서 지우고 추적을 놓는다 — 페이지(오케스트레이터)와 DB 행
 * (DatabaseSyncer)이 같이 쓴다. 파일은 `deleteFile`(deleteSync)일 때만 지운다.
 *
 * 올리지 않은 로컬 편집이 있으면 지우기 전에 전략을 본다 — 수정과 삭제가 겹친 것이다. 예전에는 늘
 * 지워, 어느 전략이든 그 편집이 볼트에서 사라졌다(local-first 도). 지난 동기화 뒤 파일이 바뀌었으면
 * (해시) 편집이 있다.
 *
 * - remote-first — 삭제가 이긴다. 예전처럼 지운다.
 * - local-first — 로컬이 이긴다. 파일을 두고 추적만 놓는다 — 다음 push 가 새 페이지로 만든다.
 * - manual · duplicate — 파일과 추적을 두고 충돌로 남긴다. 사용자가 로컬 유지(다시 만들기)나 원격
 *   유지(지우기)를 고른다.
 *
 * 파일을 읽지 못하면 던진다 — 편집이 있는지 모르는 채 지우지 않는다.
 */
export async function applyRemoteDeletion(
  stateDb: IStateDB,
  vaultFs: VaultFS,
  record: SyncRecord,
  options: RemoteDeletionOptions,
): Promise<RemoteDeletionOutcome> {
  const local = options.deleteFile ? await unsyncedLocalEdit(vaultFs, record) : null;
  if (local !== null && options.strategy !== "remote-first") {
    if (options.strategy === "local-first") {
      untrack(stateDb, record);
      getLogger().info(
        `[Im-Nobsidian] Notion 에서 지운 ${record.obsidianPath} 에 올리지 않은 로컬 편집이 있어 파일을 둠 — ` +
          `다음 push 가 새 페이지로 만든다(local-first)`,
      );
      return { action: "kept" };
    }
    stateDb.updateStatus(record.id, "conflict");
    return {
      action: "conflict",
      conflict: remoteDeletionConflict(record, local, options.remoteChange),
    };
  }
  await removeTrackedNote(stateDb, vaultFs, record, options.deleteFile);
  return { action: "deleted" };
}

/**
 * 추적하던 노트를 볼트에서 지운다 — 파일(`deleteFile` 일 때)과 레코드 · 위키링크. 원격 삭제를 받을
 * 때와, 원격 삭제 충돌을 «원격 유지» 로 풀 때 쓴다.
 */
export async function removeTrackedNote(
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
  untrack(stateDb, record);
}

/** 레코드와 위키링크를 지워 추적을 놓는다. 파일은 그대로다. */
function untrack(stateDb: IStateDB, record: SyncRecord): void {
  stateDb.transaction(() => {
    stateDb.delete(record.id);
    stateDb.deleteWikilink(record.obsidianPath);
  });
}

/** 지난 동기화 뒤 고쳐 아직 올리지 않은 로컬 본문. 파일이 없거나 그대로면 null. */
async function unsyncedLocalEdit(vaultFs: VaultFS, record: SyncRecord): Promise<string | null> {
  if (!(await vaultFs.exists(record.obsidianPath))) return null;
  const content = await vaultFs.readFile(record.obsidianPath);
  return computeHash(content) === record.contentHash ? null : content;
}

/**
 * 추적하던 페이지 · 행이 원격에서 사라졌다는 변경. 사라진 시각은 알 수 없어 확인한 지금을 적는다.
 */
export function remoteDeletionChange(record: SyncRecord): RemoteChange {
  return {
    pageId: record.notionPageId!,
    type: "deleted",
    lastEdited: new Date().toISOString(),
    previousEdited: record.notionLastEdited,
  };
}

/** 원격에서 지운 노트의 충돌 — 원격 본문은 없다. */
export function remoteDeletionConflict(
  record: SyncRecord,
  localContent: string,
  remoteChange: RemoteChange,
): Conflict {
  return {
    syncRecord: record,
    localChange: {
      path: record.obsidianPath,
      type: "modified",
      currentHash: computeHash(localContent),
      previousHash: record.contentHash,
    },
    remoteChange,
    baseContent: record.baseSnapshot?.toString("utf-8") ?? null,
    localContent,
    remoteContent: "",
  };
}
