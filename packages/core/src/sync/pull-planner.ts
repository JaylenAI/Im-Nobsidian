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
import { compactNotionId, notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import type { DatabaseSyncer, PlannedResolution, PlannedRow } from "./database-syncer.js";
import type { DiscoveredDbConfig } from "./discovered-databases.js";
import { isFolderRecord } from "./folder-container.js";
import type { LocalPlan, LocalPlanner } from "./local-planner.js";
import type { DatabaseDiscovery } from "./database-discovery.js";
import type { PagePuller } from "./page-puller.js";
import { isDatabaseMode } from "./parent-mode.js";
import { decideRemoteDeletion } from "./remote-deletion.js";
import type { RemoteDetector } from "./remote-detector.js";
import type { RemoteDriftChecker } from "./remote-drift.js";
import {
  LAST_FULL_PULL_META_KEY,
  remoteScanInfo,
  type DatabasePullLedger,
  type RemoteScan,
} from "./remote-scan.js";
import type { VaultFS } from "./vault-fs.js";

/** 다시 이을 노트 · 이미 있는 폴더({@link PagePuller.plannedRelink}). */
type PlannedRelink = NonNullable<Awaited<ReturnType<PagePuller["plannedRelink"]>>>;

/** pull 할 것을 세기만 한다(dry-run) — 실제 pull 이 받을 것과 같은 규칙으로 센다. */
export class PullPlanner {
  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
    private readonly databaseSyncer: DatabaseSyncer,
    private readonly drift: RemoteDriftChecker,
    private readonly planner: LocalPlanner,
    private readonly puller: Pick<
      PagePuller,
      "folderPageHasBody" | "previewUpdate" | "plannedRelink" | "plannedNotePath"
    >,
    private readonly discovery: Pick<
      DatabaseDiscovery,
      "plannedNewDatabases" | "bodyRead" | "readNewPageBodies"
    >,
    private readonly detector: Pick<RemoteDetector, "rootChanged">,
  ) {}

  /**
   * pull 할 것을 세기만 한다(dry-run) — 볼트 · 상태 DB · Notion 을 바꾸지 않는다. 페이지와 DB 행을
   * 같이 센다. DB 는 설정한 DB 와 이미 발견해 둔 DB 가운데 실제 pull 이 조회할 것(`ledger`)과, 이번 pull 이 새로 찾을
   * DB(루트 · 미리 보며 읽은 본문 안)를 센다. 세지 못한 DB 는 이유와 함께 `failed` 에 싣는다(세지 못한 것을 없다고 하지
   * 않는다).
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
    // 상태 기록에 없던 같은 자리의 노트 · 폴더 — 실제 pull 은 새로 받지 않고 다시 잇는다(P7). 예전에는 생성으로 셌다.
    const relinks = await this.plannedRelinks(planned);
    for (const relink of relinks.byPage.values()) {
      if (relink.conflict) conflicts.push(relink.conflict);
    }
    // 같은 행이 페이지 변경(되살릴 노트 포함)으로도 올라 있으면 페이지 쪽에서 한 번만 센다 — 실제
    // pull 은 그 행을 페이지 경로에서 먼저 받고, 뒤의 DB 경로는 받은 뒤라 무변경으로 건너뛴다.
    const queued = new Set(
      [...filtered, ...restoreChanges].map((change) => compactNotionId(change.pageId)),
    );
    // 옮겨 적지 않은 볼트 이동 — 실제 pull 은 먼저 옮겨 적어 Notion 쪽 이동을 받지 않는다(볼트가 먼저).
    const movingInVault = new Set(localPlan?.scan.adoptions.map((adoption) => adoption.record.id));
    // 이번 pull 이 새로 찾을 DB — 새 DB 폴더는 부모 노트 옆이라 다시 이을 노트는 그 자리로 본다.
    const relinkPaths = new Map(
      [...relinks.byPage].map(([pageId, relink]) => [compactNotionId(pageId), relink.path]),
    );
    // 새로 받을 페이지 안의 DB — 본문을 읽어 찾는다(실제 pull 은 받으며 찾는다). 그 DB 의 폴더는 새 페이지가 받힐 자리 옆이다.
    const created = planned
      .filter((change) => change.type === "created")
      .map((change) => change.pageId);
    await this.discovery.readNewPageBodies(created, options.signal);
    const createdIds = new Set(created.map(compactNotionId));
    const newDatabases = await this.discovery.plannedNewDatabases(failed, {
      rescanRoot: this.detector.rootChanged(),
      notePathOf: async (pageId) =>
        relinkPaths.get(compactNotionId(pageId)) ??
        this.stateDb.getByNotionId(pageId)?.obsidianPath ??
        (createdIds.has(compactNotionId(pageId))
          ? await this.puller.plannedNotePath(pageId)
          : null),
    });
    const rows: PlannedRow[] = [];
    for (const row of await this.planDatabaseRows(
      options.paths,
      failed,
      ledger,
      movingInVault,
      relinks.taken,
      newDatabases,
    )) {
      if (queued.has(compactNotionId(row.pageId))) continue;
      if (row.resolution?.action === "conflict") conflicts.push(row.resolution.conflict);
      if (row.relinkConflict) conflicts.push(row.relinkConflict);
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
      const relink = relinks.byPage.get(change.pageId);
      if (relink) {
        // 실제 pull 처럼 받아 보기만 하고 쓰지 않는 것으로 — 화면이 받을 노트로 적지 않는다.
        items.push({ path: relink.path, operation: "create", unchanged: true });
        continue;
      }
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
    for (const row of rows) {
      items.push({
        path: row.path,
        operation: row.operation,
        ...(row.relink ? { unchanged: true } : {}),
      });
    }
    // Notion 에서 DB 안으로 옮긴 페이지 — 행이 되며 옮긴다. 행으로 다시 쓰므로 고친 것으로도 센다(실제 pull 과 같다).
    // Notion 에서 옮긴 DB 의 폴더도 옮긴다 — 행을 다시 쓰지 않아 고친 것으로 세지 않는다.
    const movedRows = rows.filter((row) => row.moves !== undefined);
    items.forEach((item, index) => options.onProgress?.(index + 1, items.length, item));

    const count = (type: RemoteChange["type"]) =>
      planned.filter((c) => c.type === type && !relinks.byPage.has(c.pageId)).length;
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
      rows.filter(
        (row) => row.operation === operation && (row.restore ?? false) === restore && !row.relink,
      ).length;
    // 본문을 읽지 못한 새 페이지(Markdown API · 블록 둘 다 실패) 안의 DB 는 세지 않았다 — 받아 봐야 안다. 세지 못한 것을 없다고
    // 하지 않는다.
    const undiscoveredDatabases =
      !isDatabaseMode(this.config) &&
      planned.some((c) => c.type === "created" && !this.discovery.bodyRead(c.pageId));
    const relinkedPaths = [
      ...[...relinks.byPage.values()]
        .filter((relink) => relink.kind === "note")
        .map((relink) => relink.path),
      ...rows.filter((row) => row.relink).map((row) => row.path),
    ];
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
      ...(relinkedPaths.length > 0 ? { relinkedPaths, relinkPending: true as const } : {}),
      ...(undiscoveredDatabases ? { undiscoveredDatabases: true as const } : {}),
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
   * 새 페이지 가운데 실제 pull 이 상태 기록에 없던 노트 · 폴더와 다시 이을 것({@link PagePuller.plannedRelink}) — 페이지 id →
   * 자리. `taken` 은 고른 자리라 행도 피한다.
   */
  private async plannedRelinks(planned: readonly RemoteChange[]): Promise<{
    readonly byPage: Map<string, PlannedRelink>;
    readonly taken: Set<string>;
  }> {
    const byPage = new Map<string, PlannedRelink>();
    const taken = new Set<string>();
    for (const change of planned) {
      if (change.type !== "created") continue;
      try {
        const relink = await this.puller.plannedRelink(change.pageId, taken);
        if (relink) byPage.set(change.pageId, relink);
      } catch (error) {
        // 자리를 보지 못했다 — 예전처럼 생성으로 센다. 실제 pull 이 받아 보며 가른다.
        getLogger().debug(
          `[Im-Nobsidian] 다시 이을 자리를 미리 보지 못함 (${change.pageId}):`,
          error,
        );
      }
    }
    return { byPage, taken };
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
    relinkTaken: Set<string>,
    databases: Awaited<ReturnType<DatabaseDiscovery["plannedNewDatabases"]>>,
  ): Promise<PlannedRow[]> {
    const configured = this.config.notion.databases ?? [];
    const rows: PlannedRow[] = [];
    const found = new Set(databases.found);
    const plan = async (
      dbConfig: DiscoveredDbConfig,
      resolveDbFolder?: (dbId: string) => string | null,
    ): Promise<void> => {
      // 실제 pull 이 조회하지 않을 DB 는 세지 않는다 — 조회하지 않으면 받을 것도 없다. 새로 찾을 DB 는 조회한다.
      if (!found.has(dbConfig) && !ledger.selects(dbConfig.databaseId)) {
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
            relinkTaken,
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

    // 발견해 둔 DB(폴더 충돌은 실제 pull 처럼 가른 사본, F24)와 새로 찾을 DB — 접근 불가 DB 는 뺐다.
    const discovered = databases.all;
    const resolveDbFolder = (dbId: string): string | null =>
      [...discovered, ...configured].find((c) => notionIdsEqual(c.databaseId, dbId))?.localFolder ??
      null;
    for (const dbConfig of discovered) await plan(dbConfig, resolveDbFolder);
    return rows;
  }
}
