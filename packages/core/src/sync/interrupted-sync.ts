import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionClient } from "../notion/client.js";
import { isNotionObjectNotFound } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { SyncRecord } from "../types/sync.js";
import { getLogger } from "../utils/logger.js";
import { isFolderNotePath } from "./folder-container.js";

/**
 * 중단된 실행이 남긴 것을 정리한다 — 진행 중 플래그, 끝나지 않은 생성 작업(WAL, I12).
 *
 * Notion 생성 요청에는 idempotency key 가 없어서, 적용됐는지 모르는 생성은 다시 보내지 않고
 * 부모에서 같은 제목의 짝 없는 페이지 · 행을 찾아 입양한다(S-07). 같은 실행의 재시도(pushCreate)와
 * 폴더 페이지 준비도 이 찾기 · 입양을 쓴다.
 */
export class InterruptedSyncRecovery {
  constructor(
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
  ) {}

  cleanupInterruptedSync(): void {
    const pushInProgress = this.stateDb.getMeta("push_in_progress");
    const pullInProgress = this.stateDb.getMeta("pull_in_progress");

    if (pushInProgress === "true") {
      getLogger().warn("[Im-Nobsidian] 이전 push가 비정상 종료됨 — 플래그 정리");
      this.stateDb.setMeta("push_in_progress", "");
    }
    if (pullInProgress === "true") {
      getLogger().warn("[Im-Nobsidian] 이전 pull이 비정상 종료됨 — 플래그 정리");
      this.stateDb.setMeta("pull_in_progress", "");
    }
  }

  /**
   * I12 — 중단된 push create 작업 재개.
   *
   * pending_operations 에 미완료(create·push) 항목이 있으면:
   *  - state 에 notion_page_id 가 이미 있으면 → 생성·매핑까지는 끝났고 markCompleted 직전에
   *    중단된 것 → 완료 처리(잔여 본문/이미지는 다음 변경감지가 pushUpdate 로 마무리).
   *  - notion_page_id 가 비어 있으면(Window A: 생성 적용됐으나 매핑 기록 전 중단) → 부모에서
   *    제목으로 child_page 를 검색해 고아 페이지를 입양(중복 생성 차단). 없으면 자리표시
   *    레코드를 제거(FK CASCADE 로 op 도 삭제)해 다음 push 가 새로 생성하게 한다.
   *
   * Notion 은 idempotency key 가 없다. 그래서 생성 요청은 적용됐는지 모르는 실패(타임아웃 ·
   * 5xx)에서 클라이언트가 다시 보내지 않고(S-07), 같은 실행의 재시도(pushCreate)와 다음
   * 실행의 재개(여기)가 모두 이 검색-입양을 거친다. 자식 목록을 **읽지 못하면** 자리표시를
   * 지우지 않는다 — 읽지 못한 것을 "없다" 로 보면 다음 push 가 같은 페이지를 또 만든다.
   * DB 폴더의 행(`parentType: "database"`)은 자식 목록이 아니라 DB 조회로 같은 제목의 짝 없는
   * 행을 찾는다. 한계: DB 모드의 행은 부모를 폴더 페이지로 적어 찾지 못하고, 자리표시 제거 후
   * 재생성으로 폴백한다.
   *
   * 이동(move·push) WAL 은 재개가 아니라 «아직 반영하지 않은 이동» 의 기록이라 그대로 둔다 —
   * 옮긴 노트를 다시 반영하는 것은 변경 감지(`moved`)와 pushMove 가 한다(S-11).
   */
  async recoverInterruptedPushOps(): Promise<void> {
    const ops = this.stateDb.getIncompletePendingOperations();
    if (ops.length === 0) return;

    for (const op of ops) {
      if (op.direction === "push" && op.operation === "move") continue;
      if (op.direction !== "push" || op.operation !== "create") {
        // 현재 WAL 재개는 create·push 만 대상. 그 외는 정리만 한다.
        this.stateDb.markPendingFailed(op.id, "unsupported resume op");
        continue;
      }

      let payload: {
        path?: string;
        parentId?: string;
        parentType?: "page" | "database";
        title?: string;
      } = {};
      try {
        payload = JSON.parse(op.payload ?? "{}") as typeof payload;
      } catch {
        this.stateDb.markPendingFailed(op.id, "invalid payload json");
        continue;
      }
      const path = payload.path;
      if (!path) {
        this.stateDb.markPendingFailed(op.id, "missing payload.path");
        continue;
      }

      const state = this.stateDb.getByPath(path);
      if (state?.notionPageId) {
        // 매핑 존재 → 안전. 완료 처리하고 잔여는 변경감지(contentHash="")가 pushUpdate 로 마무리.
        this.stateDb.markPendingCompleted(op.id);
        continue;
      }

      const parentId = payload.parentId ?? state?.notionParentId ?? undefined;
      const title = payload.title;
      let adopted: string | null = null;
      if (parentId && title) {
        try {
          const orphan =
            payload.parentType === "database"
              ? await this.findUntrackedRowByTitle(parentId, title)
              : await this.findChildPageByTitle(parentId, title);
          adopted = orphan?.id ?? null;
        } catch (error) {
          // 읽지 못함 ≠ 없음. op 와 자리표시를 그대로 두면 이번 push 의 pushCreate 가 다시
          // 확인하고, 그래도 못 읽으면 그 항목만 실패로 남는다 — 중복 생성은 없다.
          getLogger().warn(
            `[Im-Nobsidian] 중단된 create 재개 보류 — 부모 자식 목록을 읽지 못함 (${path}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
      }

      if (adopted) {
        this.adoptOrphanPage(path, adopted, parentId ?? null, state);
        this.stateDb.markPendingCompleted(op.id);
        getLogger().info(`[Im-Nobsidian] 중단된 create 재개 — 고아 페이지 입양: ${path}`);
      } else if (state) {
        // 생성된 페이지를 못 찾음 → 자리표시 제거(CASCADE 로 op 삭제) → 다음 push 가 새로 생성.
        this.stateDb.delete(state.id);
        getLogger().info(`[Im-Nobsidian] 중단된 create 재개 — 미생성 확인, 자리표시 제거: ${path}`);
      } else {
        this.stateDb.markPendingCompleted(op.id);
      }
    }
  }

  /**
   * 부모 페이지의 직속 자식 중 제목이 일치하고 아직 아무 레코드도 짝으로 삼지 않은
   * (보관/휴지통 제외) child_page 를 찾는다 — 앞선 생성 요청이 남긴 고아 후보다.
   *
   * 이미 추적 중인 페이지는 제외한다. `A/x.md` 의 페이지와 폴더 `A/x/` 의 페이지는 제목이
   * 같은 형제라서, 제목만 보면 남의 짝을 가로챈다.
   *
   * `null` 은 «끝까지 읽었고 없었다» 일 때만 돌려준다. 목록이나 후보 페이지를 읽지 못하면
   * 던진다 — 호출측이 "없다" 로 오해하면 이미 만들어진 페이지를 두고 하나를 더 만든다.
   * 후보가 404 면 그 사이 지워졌거나 접근이 끊긴 것이라 건너뛴다.
   */
  async findChildPageByTitle(parentId: string, title: string): Promise<PageObjectResponse | null> {
    const children = await this.notionClient.fetchAllChildren(parentId);
    for (const b of children) {
      if (b.type !== "child_page") continue;
      const childTitle = (b as { child_page?: { title?: string } }).child_page?.title;
      if (childTitle !== title) continue;
      if (this.stateDb.getByNotionId(b.id)) continue;
      let page: PageObjectResponse;
      try {
        page = await this.notionClient.getPage(b.id);
      } catch (error) {
        if (isNotionObjectNotFound(error)) continue;
        throw error;
      }
      const inTrash = (page as { in_trash?: boolean }).in_trash === true;
      if (inTrash || page.archived) continue;
      return page;
    }
    return null;
  }

  /**
   * DB 에서 제목이 같고 아직 아무 레코드도 짝으로 삼지 않은(휴지통 제외) 행을 찾는다 — 앞선
   * 행 생성 요청이 남긴 고아 후보다. 제목 속성은 이름이 DB 마다 달라 속성 id(`title`)로 거른다.
   *
   * `null` 은 «끝까지 조회했고 없었다» 일 때만이다. 조회에 실패하면 던진다({@link findChildPageByTitle}
   * 와 같은 이유 — 읽지 못한 것을 «없다» 로 보면 같은 행을 하나 더 만든다).
   */
  async findUntrackedRowByTitle(
    databaseId: string,
    title: string,
  ): Promise<PageObjectResponse | null> {
    const rows = await this.notionClient.queryAllDatabasePages(databaseId, {
      property: "title",
      title: { equals: title },
    });
    for (const row of rows) {
      if (this.stateDb.getByNotionId(row.id)) continue;
      const inTrash = (row as { in_trash?: boolean }).in_trash === true;
      if (inTrash || row.archived) continue;
      return row;
    }
    return null;
  }

  /**
   * 앞선 생성 요청이 서버에 적용돼 있던 페이지를 이 노트의 짝으로 삼는다 — 매핑만 채운다.
   * contentHash 를 비우고 pending 으로 두어, 본문 · 이미지는 다음 갱신(pushUpdate)이 마무리한다.
   */
  adoptOrphanPage(
    path: string,
    pageId: string,
    parentId: string | null,
    state: SyncRecord | null,
  ): void {
    this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: pageId,
      notionParentId: parentId,
      contentHash: "",
      notionLastEdited: state?.notionLastEdited ?? null,
      notionLastEditedBy: state?.notionLastEditedBy ?? null,
      notionSeenAt: state?.notionSeenAt ?? null,
      notionBodyFingerprint: state?.notionBodyFingerprint ?? null,
      localLastModified: new Date().toISOString(),
      syncDirection: state?.syncDirection ?? "both",
      fileType: state?.fileType ?? (isFolderNotePath(path) ? "folder-note" : "file"),
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });
  }
}
