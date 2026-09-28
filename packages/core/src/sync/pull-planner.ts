import { isNotionObjectNotFound } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type {
  FailedOperation,
  ProgressItem,
  PullOptions,
  PullResult,
  RemoteChange,
} from "../types/sync.js";
import { repairDbFolderCollisions } from "../utils/db-folder-path.js";
import { compactNotionId, notionIdsEqual } from "../utils/id.js";
import type { DatabaseSyncer, PlannedRow } from "./database-syncer.js";
import {
  DISCOVERED_DBS_META_KEY,
  loadInaccessibleDbIds,
  parseDiscoveredDbs,
  type DiscoveredDbConfig,
} from "./discovered-databases.js";
import { isFolderRecord } from "./folder-container.js";
import type { LocalPlan, LocalPlanner } from "./local-planner.js";
import { isDatabaseMode } from "./parent-mode.js";
import { decideRemoteDeletion } from "./remote-deletion.js";
import type { RemoteDriftChecker } from "./remote-drift.js";
import {
  LAST_FULL_PULL_META_KEY,
  remoteScanInfo,
  type DatabasePullLedger,
  type RemoteScan,
} from "./remote-scan.js";
import type { VaultFS } from "./vault-fs.js";

/** pull 할 것을 세기만 한다(dry-run) — 실제 pull 이 받을 것과 같은 규칙으로 센다. */
export class PullPlanner {
  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
    private readonly databaseSyncer: DatabaseSyncer,
    private readonly drift: RemoteDriftChecker,
    private readonly planner: LocalPlanner,
  ) {}

  /**
   * pull 할 것을 세기만 한다(dry-run) — 볼트 · 상태 DB · Notion 을 바꾸지 않는다. 페이지와 DB 행을
   * 같이 센다. DB 는 설정한 DB 와 이미 발견해 둔 DB 가운데 실제 pull 이 조회할 것(`ledger`)만 센다 —
   * 이번 pull 이 새로 발견할 DB 는 받아 봐야 안다. 세지 못한 DB 는 이유와 함께 `failed` 에 싣는다
   * (세지 못한 것을 없다고 하지 않는다).
   */
  async planPull(
    filtered: RemoteChange[],
    restoreChanges: RemoteChange[],
    localPlan: LocalPlan | null,
    options: PullOptions,
    startTime: number,
    scan: RemoteScan,
    ledger: DatabasePullLedger,
  ): Promise<PullResult> {
    // 받지 않으니 «확인 안 됨» 은 내용으로 가른다 — 같은 분 안에 바뀐 것이 없으면 세지 않는다.
    const unchangedDropped = await this.drift.withoutUnchangedRemotes(filtered);
    // 지울 것은 실제 pull 과 같게 가른다 — 폴더 레코드는 추적만 놓고, 올리지 않은 로컬 편집이
    // 있으면 전략에 따라 두거나 충돌로 남긴다. 어느 쪽이든 지운 것으로 세지 않는다.
    const planned: RemoteChange[] = [];
    for (const change of unchangedDropped) {
      if (change.type !== "deleted" || (await this.plannedRemoteDeletion(change))) {
        planned.push(change);
      }
    }
    const failed: FailedOperation[] = [];
    // 같은 행이 페이지 변경(되살릴 노트 포함)으로도 올라 있으면 페이지 쪽에서 한 번만 센다 — 실제
    // pull 은 그 행을 페이지 경로에서 먼저 받고, 뒤의 DB 경로는 받은 뒤라 무변경으로 건너뛴다.
    const queued = new Set(
      [...filtered, ...restoreChanges].map((change) => compactNotionId(change.pageId)),
    );
    const rows = (await this.planDatabaseRows(options.paths, failed, ledger)).filter(
      (row) => !queued.has(compactNotionId(row.pageId)),
    );

    const items: ProgressItem[] = [];
    // 옮겨 적지 않았으니 레코드는 옛 경로다 — 실제 pull 이 쓸 새 경로로 보인다(S-11).
    // 새 페이지는 받기 전에는 자리를 모른다(부모 · 자식 페이지가 정한다) — Notion 제목으로 보인다.
    // 예전에는 내부 id 를 보였다.
    const plannedPath = this.planner.plannedPaths(localPlan);
    for (const change of [...planned, ...restoreChanges]) {
      const record = this.stateDb.getByNotionId(change.pageId);
      items.push({
        path:
          (record && plannedPath.get(record.id)) ??
          record?.obsidianPath ??
          change.title ??
          change.pageId,
        operation:
          change.type === "created" ? "create" : change.type === "deleted" ? "delete" : "update",
      });
    }
    for (const row of rows) items.push({ path: row.path, operation: row.operation });
    items.forEach((item, index) => options.onProgress?.(index + 1, items.length, item));

    const count = (type: RemoteChange["type"]) => planned.filter((c) => c.type === type).length;
    const rowCount = (operation: PlannedRow["operation"], restore = false) =>
      rows.filter((row) => row.operation === operation && (row.restore ?? false) === restore)
        .length;
    return {
      created: count("created") + rowCount("create"),
      updated: count("modified") + rowCount("update"),
      deleted: count("deleted") + rowCount("delete"),
      // 복원은 updated 에 섞지 않는다 — dry-run 이 "수정 N건" 이라고만 말하면
      // 사용자가 사라진 파일이 되살아난다는 사실을 미리 알 수 없다.
      restored: restoreChanges.length + rowCount("update", true),
      conflicts: [],
      writtenPaths: [],
      failed,
      duration: Date.now() - startTime,
      imageCount: 0,
      fileCount: 0,
      linkCount: 0,
      remoteScan: {
        ...remoteScanInfo(
          scan,
          this.stateDb.getMeta(LAST_FULL_PULL_META_KEY),
          this.config.sync.deleteSync,
        ),
        skippedDatabases: ledger.skipped,
      },
    };
  }

  /** 원격에서 지운 페이지를 실제 pull 이 볼트에서 지우는가 — `PagePuller.pullDelete` 와 같게 가른다. */
  private async plannedRemoteDeletion(change: RemoteChange): Promise<boolean> {
    const record = this.stateDb.getByNotionId(change.pageId);
    if (!record || isFolderRecord(record)) return false;
    try {
      const decision = await decideRemoteDeletion(this.vaultFs, record, {
        deleteFile: this.config.sync.deleteSync,
        strategy: this.config.sync.conflictStrategy,
      });
      return decision.action === "deleted";
    } catch {
      // 볼트를 읽지 못하면 실제 pull 도 지우지 않는다(실패로 남긴다).
      return false;
    }
  }

  /**
   * dry-run 이 셀 DB 행 — 실제 pull 이 받는 DB 와 같다. 설정한 DB(`pullAll`)와 발견해 둔 DB
   * (`DatabaseDiscovery.pullDiscoveredDatabases`)를 같은 규칙으로 고른다. 세지 못한 DB 는 이유와 함께 `failed`
   * 에 싣는다 — 세지 못한 것을 없다고 하지 않는다.
   */
  private async planDatabaseRows(
    paths: readonly string[] | undefined,
    failed: FailedOperation[],
    ledger: DatabasePullLedger,
  ): Promise<PlannedRow[]> {
    const configured = this.config.notion.databases ?? [];
    const rows: PlannedRow[] = [];
    const plan = async (
      dbConfig: DiscoveredDbConfig,
      resolveDbFolder?: (dbId: string) => string | null,
    ): Promise<void> => {
      // 실제 pull 이 조회하지 않을 DB 는 세지 않는다 — 조회하지 않으면 받을 것도 없다.
      if (!ledger.selects(dbConfig.databaseId)) {
        ledger.skip();
        return;
      }
      try {
        rows.push(
          ...(await this.databaseSyncer.planDatabase(dbConfig, { paths, resolveDbFolder })),
        );
      } catch (error) {
        // 발견해 둔 DB 가 사라졌으면(404) 실제 pull 은 대상에서 빼기만 한다 — 실패가 아니다.
        if (resolveDbFolder && isNotionObjectNotFound(error)) return;
        failed.push({
          path: dbConfig.localFolder,
          operation: "update",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    for (const dbConfig of configured) await plan(dbConfig);
    if (isDatabaseMode(this.config)) return rows;

    // 폴더 충돌은 실제 pull 처럼 가른다(F24) — 읽어 온 사본만 고치고 상태에는 쓰지 않는다.
    const discovered = parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY));
    repairDbFolderCollisions(
      discovered,
      new Map(configured.map((d) => [d.localFolder, d.databaseId])),
    );
    const inaccessible = loadInaccessibleDbIds(this.stateDb);
    const resolveDbFolder = (dbId: string): string | null =>
      [...discovered, ...configured].find((c) => notionIdsEqual(c.databaseId, dbId))?.localFolder ??
      null;
    for (const dbConfig of discovered) {
      if (inaccessible.has(dbConfig.databaseId.replace(/-/g, ""))) continue;
      await plan(dbConfig, resolveDbFolder);
    }
    return rows;
  }
}
