import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { ChangeDiff, LocalChange, RemoteChange, SyncRecord } from "../types/sync.js";
import { isFolderRecord } from "./folder-container.js";
import type { LocalPlanner } from "./local-planner.js";
import type { PagePuller } from "./page-puller.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * 변경 하나를 들여다보고 되돌린다 — 지난 동기화 때의 글과 지금 글(볼트 · Notion)을 견주고(Git 의
 * `diff`), 로컬 변경을 지난 동기화 때의 글로 되돌린다(Git 의 `restore`). 견주는 기준은 모두 지난
 * 동기화 사본(`baseSnapshot`)이다. Notion 은 읽기만 한다.
 */
export class ChangeInspector {
  constructor(
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
    private readonly notionClient: NotionClient,
    private readonly planner: LocalPlanner,
    private readonly puller: PagePuller,
  ) {}

  /**
   * 추적 파일의 **현재 원격 본문**을 pull 과 같은 변환으로 렌더한다 — 표시 전용.
   *
   * 첨부는 내려받지 않는다: 비교를 보려다 볼트에 파일이 생기면 안 된다. 그 대가로 아직
   * 내려받지 않은 미디어는 원격 URL 로 남아 비교 화면에만 차이로 보인다.
   *
   * @returns 추적되지 않았거나 원격 페이지가 없으면 null.
   */
  async renderRemoteSnapshot(path: string): Promise<string | null> {
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return null;
    return this.renderRemoteRecord(record, record.notionPageId);
  }

  /**
   * 로컬 변경 하나의 두 글 — 지난 동기화 때의 글과 지금 볼트의 글. 표시 전용이라 잠그지 않는다.
   *
   * 변경 목록(`statusLocal`)이 준 변경을 그대로 받고 볼트를 다시 훑지 않는다. 대신 짚은 추적 레코드가 그
   * 변경이 본 것과 같은지(글 지문) 확인한다 — 그 사이 올리거나 받아 레코드가 바뀌었으면 엉뚱한 옛 글과
   * 견주지 않게 거절한다.
   */
  async localChangeDiff(change: LocalChange): Promise<ChangeDiff> {
    const before =
      change.type === "created"
        ? null
        : this.syncedText(this.recordOfLocalChange(change), change.path);
    const after = change.type === "deleted" ? null : await this.vaultFs.readFile(change.path);
    return {
      path: change.path,
      type: change.type,
      ...(change.movedFrom ? { movedFrom: change.movedFrom } : {}),
      before,
      after,
    };
  }

  /**
   * 원격 변경 하나의 두 글 — 지난 동기화 때의 글과 Notion 의 지금 글(pull 과 같은 변환, 첨부는 내려받지
   * 않는다). 표시 전용이라 잠그지 않는다.
   *
   * 지금 볼트 글이 아니라 지난 동기화 사본과 견준다 — Notion 에서 바뀐 것만 보인다. 로컬 편집은 로컬
   * 변경이 따로 보인다(Git 이 받을 커밋을 합칠 기준과 견주는 것과 같다). 아직 받지 않은 새 페이지는 견줄
   * 글이 없어 거절한다.
   */
  async remoteChangeDiff(change: RemoteChange): Promise<ChangeDiff> {
    const record = this.stateDb.getByNotionId(change.pageId);
    if (!record) {
      throw new Error(
        `아직 받지 않은 새 페이지라 견줄 글이 없습니다 — ${change.title ?? change.pageId}`,
      );
    }
    if (isFolderRecord(record)) {
      throw new Error(`폴더라 견줄 글이 없습니다 — ${record.obsidianPath}`);
    }
    const before = this.syncedText(record, record.obsidianPath);
    const after =
      change.type === "deleted" ? null : await this.renderRemoteRecord(record, change.pageId);
    return { path: record.obsidianPath, type: change.type, before, after };
  }

  /**
   * 로컬 변경 하나를 지난 동기화 때의 글로 되돌린다 — Git 의 `restore` 와 같다. 고친 노트 · 지운 노트는
   * 지난 동기화 사본(`baseSnapshot`)으로 다시 쓴다. Notion 은 건드리지 않는다.
   *
   * 되돌릴 원본이 없는 것은 이유와 함께 거절한다 — 추적하지 않는 새 노트(지우는 것은 사용자가 휴지통으로),
   * 옮긴 노트의 새 자리(파일을 옛 자리로 옮기면 된다), 사본이 없는 노트, 충돌 중인 노트(충돌 해결로 고른다).
   */
  async discardLocalChange(path: string): Promise<void> {
    const record = this.stateDb.getByPath(path);
    if (!record) {
      throw new Error(await this.untrackedDiscardReason(path));
    }
    if (record.status === "conflict") {
      throw new Error(`충돌 중인 노트는 충돌 해결에서 고르세요 — ${path}`);
    }
    if (!record.baseSnapshot) {
      throw new Error(`지난 동기화 사본이 없어 되돌릴 수 없습니다 — ${path}`);
    }
    await this.vaultFs.writeFile(path, record.baseSnapshot.toString("utf-8"));
  }

  private async renderRemoteRecord(record: SyncRecord, pageId: string): Promise<string> {
    const page = await this.notionClient.getPage(pageId);
    const rendered = await this.puller.renderRemotePage(record, pageId, page, {
      downloadMedia: false,
    });
    return rendered.content;
  }

  /**
   * 로컬 변경이 짚는 추적 레코드. 옮긴 노트는 Notion 에 반영하기 전까지 레코드가 옛 자리에 있다 — 다만
   * 반영하다 멈춘 이동은 이미 새 자리에 있어 새 자리부터 본다.
   */
  private recordOfLocalChange(change: LocalChange): SyncRecord {
    for (const path of [change.path, change.movedFrom]) {
      if (!path) continue;
      const record = this.stateDb.getByPath(path);
      if (record && record.contentHash === change.previousHash) return record;
    }
    throw new Error(
      `지난 동기화 기록이 변경 목록과 맞지 않습니다 — 새로고침한 뒤 다시 보세요 (${change.path})`,
    );
  }

  /** 지난 동기화 때의 글 — 사본이 없으면 옛 글을 모르니 거절한다(없는 글로 보이면 모든 줄이 새 줄이다). */
  private syncedText(record: SyncRecord, path: string): string {
    if (!record.baseSnapshot) {
      throw new Error(`지난 동기화 사본이 없어 비교할 수 없습니다 — ${path}`);
    }
    return record.baseSnapshot.toString("utf-8");
  }

  /**
   * 추적하지 않는 경로를 되돌리려 한 이유. 옮긴 노트의 새 자리도 추적 레코드가 없다 — 「새 노트」 라고
   * 하면 변경 목록에서 «옮김» 으로 본 사용자가 무엇을 해야 할지 모른다. 옛 자리를 알린다.
   */
  private async untrackedDiscardReason(path: string): Promise<string> {
    const plan = await this.planner.planLocalChanges(await this.vaultFs.listMarkdownFileStats());
    const moved = plan.scan.changes.find((c) => c.type === "moved" && c.path === path);
    return moved?.movedFrom
      ? `옮긴 노트는 되돌리기가 제자리로 돌리지 않습니다 — 파일을 ${moved.movedFrom} 로 다시 옮기세요 (${path})`
      : `추적하지 않는 새 노트라 되돌릴 원본이 없습니다 — ${path}`;
  }
}
