import { isNotionObjectNotFound } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type {
  Conflict,
  FailedOperation,
  ProgressItem,
  PullOptions,
  PullResult,
  RemoteChange,
} from "../types/sync.js";
import { repairDbFolderCollisions } from "../utils/db-folder-path.js";
import { compactNotionId, notionIdsEqual } from "../utils/id.js";
import type { DatabaseSyncer, PlannedResolution, PlannedRow } from "./database-syncer.js";
import {
  DISCOVERED_DBS_META_KEY,
  loadInaccessibleDbIds,
  parseDiscoveredDbs,
  type DiscoveredDbConfig,
} from "./discovered-databases.js";
import { isFolderRecord } from "./folder-container.js";
import type { LocalPlan, LocalPlanner } from "./local-planner.js";
import type { PagePuller } from "./page-puller.js";
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
    private readonly puller: Pick<PagePuller, "folderPageHasBody" | "previewUpdate">,
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
    restoreIds: ReadonlySet<string>,
    localPlan: LocalPlan | null,
    options: PullOptions,
    startTime: number,
    scan: RemoteScan,
    ledger: DatabasePullLedger,
  ): Promise<PullResult> {
    // 받지 않으니 «확인 안 됨» 은 내용으로 가른다 — 같은 분 안에 바뀐 것이 없으면 세지 않는다.
    const unchangedDropped = await this.drift.withoutUnchangedRemotes(filtered, options.signal);
    // 지울 것은 실제 pull 과 같게 가른다 — 폴더 레코드는 추적만 놓고, 올리지 않은 로컬 편집이
    // 있으면 전략에 따라 두거나 충돌로 남긴다. 어느 쪽이든 지운 것으로 세지 않는다.
    const planned: RemoteChange[] = [];
    const failed: FailedOperation[] = [];
    // 로컬도 고친 노트 — 실제 pull 처럼 충돌로 남길 것 · 합칠 것을 알리고, 받지 않을 것은 세지 않는다.
    const conflicts: Conflict[] = [];
    const mergedPaths: string[] = [];
    for (const change of unchangedDropped) {
      if (change.type === "deleted" && !(await this.plannedRemoteDeletion(change))) continue;
      if (change.type === "modified" && !(await this.plannedFolderPage(change))) continue;
      if (change.type === "modified" && !restoreIds.has(change.pageId)) {
        const resolution = await this.previewUpdate(change, failed);
        if (resolution === undefined) continue;
        if (resolution?.action === "conflict") {
          conflicts.push(resolution.conflict);
          continue;
        }
        if (resolution?.action === "skip") continue;
        if (resolution?.action === "merge") {
          mergedPaths.push(this.stateDb.getByNotionId(change.pageId)!.obsidianPath);
        }
      }
      planned.push(change);
    }
    // 같은 행이 페이지 변경(되살릴 노트 포함)으로도 올라 있으면 페이지 쪽에서 한 번만 센다 — 실제
    // pull 은 그 행을 페이지 경로에서 먼저 받고, 뒤의 DB 경로는 받은 뒤라 무변경으로 건너뛴다.
    const queued = new Set(
      [...filtered, ...restoreChanges].map((change) => compactNotionId(change.pageId)),
    );
    // 옮겨 적지 않은 볼트 이동 — 실제 pull 은 먼저 옮겨 적어 Notion 쪽 이동을 받지 않는다(볼트가 먼저).
    const movingInVault = new Set(localPlan?.scan.adoptions.map((adoption) => adoption.record.id));
    const rows: PlannedRow[] = [];
    for (const row of await this.planDatabaseRows(options.paths, failed, ledger, movingInVault)) {
      if (queued.has(compactNotionId(row.pageId))) continue;
      if (row.resolution?.action === "conflict") conflicts.push(row.resolution.conflict);
      else if (row.resolution?.action === "merge") mergedPaths.push(row.path);
      if (row.resolution?.action === "conflict" || row.resolution?.action === "skip") continue;
      rows.push(row);
    }

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
    // Notion 에서 DB 안으로 옮긴 페이지 — 행이 되며 옮긴다. 행으로 다시 쓰므로 고친 것으로도 센다(실제 pull 과 같다).
    // Notion 에서 옮긴 DB 의 폴더도 옮긴다 — 행을 다시 쓰지 않아 고친 것으로 세지 않는다.
    const movedRows = rows.filter((row) => row.moves !== undefined);
    items.forEach((item, index) => options.onProgress?.(index + 1, items.length, item));

    const count = (type: RemoteChange["type"]) => planned.filter((c) => c.type === type).length;
    // 원격도 바뀐 페이지라도 볼트에서 사라진 것이면 되살린 것으로 센다 — 실제 pull 과 같다.
    const restoredModified = planned.filter(
      (c) => c.type === "modified" && restoreIds.has(c.pageId),
    ).length;
    // 되살릴 노트 · 행 — 화면이 경로로 미리 알린다(D8).
    const restoredPaths = [
      ...[
        ...restoreChanges,
        ...planned.filter((c) => c.type === "modified" && restoreIds.has(c.pageId)),
      ]
        .map((change) => this.stateDb.getByNotionId(change.pageId)?.obsidianPath)
        .filter((path): path is string => path !== undefined),
      ...rows.filter((row) => row.operation === "update" && row.restore).map((row) => row.path),
    ];
    const rowCount = (operation: PlannedRow["operation"], restore = false) =>
      rows.filter((row) => row.operation === operation && (row.restore ?? false) === restore)
        .length;
    return {
      created: count("created") + rowCount("create"),
      updated: count("modified") - restoredModified + rowCount("update"),
      deleted: count("deleted") + rowCount("delete"),
      // 복원은 updated 에 섞지 않는다 — dry-run 이 "수정 N건" 이라고만 말하면
      // 사용자가 사라진 파일이 되살아난다는 사실을 미리 알 수 없다.
      restored: restoreChanges.length + restoredModified + rowCount("update", true),
      ...(restoredPaths.length > 0 ? { restoredPaths } : {}),
      ...(movedRows.length > 0 ? { moved: movedRows.flatMap((row) => row.moves!) } : {}),
      conflicts,
      ...(mergedPaths.length > 0 ? { mergedPaths } : {}),
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

  /**
   * 고친 페이지를 실제 pull 이 받는가 — 폴더로만 추적하는 페이지는 본문이 생겼을 때만 폴더 노트로 받는다. 하위 페이지 ·
   * DB 를 옮기기만 해도 그 페이지의 수정 시각이 바뀌어 고친 것으로 보였다. 확인하지 못하면 센다(실제 pull 이 받아 본다).
   */
  private async plannedFolderPage(change: RemoteChange): Promise<boolean> {
    const record = this.stateDb.getByNotionId(change.pageId);
    if (!record || !isFolderRecord(record)) return true;
    try {
      return await this.puller.folderPageHasBody(record);
    } catch {
      return true;
    }
  }

  /**
   * 로컬도 고친 노트를 실제 pull 이 어떻게 처리할지({@link PagePuller.previewUpdate}). 원격을 읽지 못했으면 실제
   * pull 도 그 노트에서 실패한다 — 실패로 싣고 undefined(세지 않는다).
   */
  private async previewUpdate(
    change: RemoteChange,
    failed: FailedOperation[],
  ): Promise<PlannedResolution | null | undefined> {
    try {
      return await this.puller.previewUpdate(change);
    } catch (error) {
      failed.push({
        path: this.stateDb.getByNotionId(change.pageId)?.obsidianPath ?? change.pageId,
        operation: "update",
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
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
   * (`DatabaseDiscovery.pullDiscoveredDatabases`)를 같은 규칙으로 고른다. 세지 못한 DB 는 이유와
   * 함께 `failed` 에 싣는다 — 세지 못한 것을 없다고 하지 않는다.
   */
  private async planDatabaseRows(
    paths: readonly string[] | undefined,
    failed: FailedOperation[],
    ledger: DatabasePullLedger,
    movingInVault: ReadonlySet<string>,
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
          ...(await this.databaseSyncer.planDatabase(dbConfig, {
            paths,
            resolveDbFolder,
            followPlacement: resolveDbFolder !== undefined,
            movingInVault,
          })),
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
