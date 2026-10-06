import type {
  PushOptions,
  PushResult,
  PullOptions,
  PullResult,
  SyncOptions,
  SyncResult,
  StatusResult,
  LocalChange,
  RemoteChange,
  Conflict,
  ConflictStrategy,
  FailedOperation,
  ChangeDiff,
  ProgressCallback,
  ProgressItem,
} from "../types/sync.js";
import type { Config } from "../types/config.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { NotionClient } from "../notion/client.js";
import { ChangeDetector } from "./change-detector.js";
import { createDefaultPipeline } from "../converter/pipeline-factory.js";
import { BlockConverter } from "../converter/block-converter.js";
import { ImageHandler } from "./image-handler.js";
import { FileHandler } from "./file-handler.js";
import { DatabaseSyncer, type RowProgress } from "./database-syncer.js";
import { verifyDatabaseCompleteness, verifyPageCompleteness } from "../audit/completeness.js";
import type { VaultCompletenessReport } from "../audit/completeness.js";
import { ConflictResolver, choiceForStrategy } from "../conflict/resolver.js";
import type { ResolutionChoice, ResolutionResult } from "../conflict/resolver.js";
import { PropertyMapper, type WikilinkResolver } from "../notion/property-mapper.js";
import { getLogger } from "../utils/logger.js";
import { inAnyPathScope } from "../utils/path-scope.js";
import { runPool } from "../utils/pool.js";
import { withDeadline } from "../utils/deadline.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import type { VaultFS } from "./vault-fs.js";
import { nextPullWatermark } from "./pull-watermark.js";
import {
  DatabasePullLedger,
  LAST_FULL_PULL_META_KEY,
  parsePendingDatabases,
  PENDING_DATABASES_META_KEY,
  remoteScanInfo,
} from "./remote-scan.js";
import { OperationAbortedError } from "../utils/abort.js";
import { RowSchemaCache } from "./row-schema-cache.js";
import { OperationGate } from "./operation-gate.js";
import { RunObservation } from "./run-observation.js";
import { InterruptedSyncRecovery } from "./interrupted-sync.js";
import { isDatabaseMode } from "./parent-mode.js";
import { DatabaseDiscovery } from "./database-discovery.js";
import { FolderPlacement } from "./folder-placement.js";
import { LocalPlanner, type LocalPlan, type PendingFolderMove } from "./local-planner.js";
import { ChangeInspector } from "./change-inspector.js";
import { ConflictWorkflow } from "./conflict-workflow.js";
import { PagePusher } from "./page-pusher.js";
import { PagePuller } from "./page-puller.js";
import { resolveNotionLinks } from "./notion-link-pass.js";
import { PullPlanner } from "./pull-planner.js";
import { RemoteDetector, type RemoteDetection } from "./remote-detector.js";
import { detectMissingLocalFiles } from "./missing-local-files.js";
import { RemoteDriftChecker } from "./remote-drift.js";
import { DISCOVERED_DBS_META_KEY, parseDiscoveredDbs } from "./discovered-databases.js";
import type { GatedOperation } from "./operation-gate.js";
import {
  forgetRenameHint,
  isEmptyRenameHints,
  recordRenameHint,
  type RenameKind,
} from "./local-moves.js";

export class SyncOrchestrator {
  private readonly fileHandler: FileHandler;
  private readonly databaseSyncer: DatabaseSyncer;
  /** DB 행 push 용 — DB 마다 스키마를 읽은 매퍼. 실행마다 비운다(S-01). */
  private readonly rowSchemas: RowSchemaCache;
  // 이번 실행이 원격을 보는 기준(N-05) — push · pull · status 가 시작할 때 정한다
  // ({@link RunObservation.begin}). 원격 판정과 관측 기록이 같은 값을 쓴다.
  private readonly observation: RunObservation;

  // 볼트 폴더의 Notion 자리 — 새 노트 · 옮긴 노트의 부모, 폴더 페이지 마련, 둘 자리가 없는 것의
  // 거절(S-04 · S-11 · S-15).
  private readonly placement: FolderPlacement;

  // 이번 실행의 로컬 변경 — 옮긴 노트 · 폴더를 짝짓고 상태 DB 에 옮겨 적는다(S-11).
  private readonly planner: LocalPlanner;

  // 원격에서 바뀐 것 — 전체 대조 · 증분 감지(ADR-027).
  private readonly detector: RemoteDetector;

  // 지난번에 본 뒤로 원격이 바뀌었나(N-05) — 덮어쓰기 · 지우기 전에, 변경을 보이기 전에 본다.
  private readonly drift: RemoteDriftChecker;

  // 페이지 모드의 DB 자동 발견 — 페이지 안의 DB 를 찾아 등록하고 받는다.
  private readonly discovery: DatabaseDiscovery;

  // 원격 페이지를 볼트에 받는다 — 새로 생긴 · 바뀐 · 지운 페이지, 충돌의 원격 렌더.
  private readonly puller: PagePuller;

  // pull 할 것을 세기만 한다(dry-run).
  private readonly pullPlanner: PullPlanner;

  // 로컬 변경을 Notion 에 올린다 — 새 노트 · 고친 노트 · 옮긴 노트와 폴더 · 지운 노트, 충돌 해소 결과.
  private readonly pusher: PagePusher;

  // 충돌 해소 — 목록 · 해소 · Notion 전파(I8 · N-06).
  private readonly conflictWorkflow: ConflictWorkflow;

  // 변경 하나를 들여다보고 되돌린다 — 두 글 견주기 · 로컬 변경 되돌리기.
  private readonly inspector: ChangeInspector;

  // 중단된 실행의 정리 · 앞선 생성이 남긴 고아 페이지의 입양(I12 · S-07).
  private readonly recovery: InterruptedSyncRecovery;

  // 작업은 한 번에 하나만 돈다(S-09) — 위의 실행별 상태를 두 실행이 함께 쓰지 않도록.
  private readonly gate = new OperationGate();

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
    customFetch?: typeof globalThis.fetch,
  ) {
    this.observation = new RunObservation(stateDb, notionClient);
    this.recovery = new InterruptedSyncRecovery(stateDb, notionClient);
    this.detector = new RemoteDetector(config, stateDb, notionClient, this.observation);
    const changeDetector = new ChangeDetector(stateDb);
    const pipeline = createDefaultPipeline({
      wikilinkResolver: (text) => stateDb.resolveWikilink(text),
    });
    const blockConverter = new BlockConverter();
    const imageHandler = new ImageHandler(
      vaultFs,
      config.paths.attachments,
      notionClient,
      customFetch,
      {
        concurrency: config.advanced.mediaConcurrency,
        maxRetries: config.advanced.mediaMaxRetries,
        retryBaseMs: config.advanced.mediaRetryBaseMs,
        maxFileSizeBytes: config.advanced.maxFileSizeBytes,
        downloadTimeoutMs: config.advanced.mediaDownloadTimeoutMs,
      },
      stateDb,
    );
    this.fileHandler = new FileHandler(
      vaultFs,
      notionClient,
      stateDb,
      config.advanced.fileConcurrency,
      {
        fetch: customFetch,
        downloadTimeoutMs: config.advanced.mediaDownloadTimeoutMs,
        itemTimeoutMs: config.advanced.itemTimeoutMs,
      },
    );
    const propertyMapper = PropertyMapper.fromConfig(config);
    this.databaseSyncer = new DatabaseSyncer(
      config,
      stateDb,
      notionClient,
      vaultFs,
      pipeline,
      imageHandler,
      () => this.observation.context,
    );
    this.discovery = new DatabaseDiscovery(
      config,
      stateDb,
      notionClient,
      vaultFs,
      this.databaseSyncer,
    );
    // M4: 후처리 패스(resolveNotionLinks)와 동일하게 파일 basename 으로 위키링크
    // 텍스트를 만든다. 원시 제목(.title)을 쓰면 슬래시·콜론 등 파일명 금지문자
    // 때문에 단일 패스 링크가 실제 파일을 못 가리키는 불일치가 생겼다.
    // M1: 동일 resolver 를 페이지 모드 변환 경로(notionClient.extractProperties)에도
    // 주입한다. 주입하지 않으면 페이지 모드 relation 이 raw UUID 로 남아 매 pull 마다
    // 후처리로만 해소되는 2-write churn 이 생긴다(DB 모드는 propertyMapper 가 처리).
    const wikilinkResolver: WikilinkResolver = {
      resolve: (title: string) => stateDb.resolveWikilink(title)?.notionPageId ?? null,
      resolvePageId: (pageId: string) => {
        const entry = stateDb.resolvePageId(pageId);
        return entry ? wikilinkTitleFromPath(entry.obsidianPath) : null;
      },
    };
    propertyMapper.setWikilinkResolver(wikilinkResolver);
    this.notionClient.setWikilinkResolver(wikilinkResolver);
    this.rowSchemas = new RowSchemaCache(
      (databaseId) => notionClient.getDatabaseSchema(databaseId),
      wikilinkResolver,
      () => PropertyMapper.fromConfig(config),
    );

    this.drift = new RemoteDriftChecker(
      config,
      stateDb,
      notionClient,
      this.databaseSyncer,
      this.rowSchemas,
      this.observation,
    );
    this.placement = new FolderPlacement(
      config,
      stateDb,
      notionClient,
      this.observation,
      this.drift,
      this.recovery,
    );
    this.planner = new LocalPlanner(config, stateDb, vaultFs, changeDetector, this.placement);
    this.puller = new PagePuller(
      config,
      stateDb,
      notionClient,
      vaultFs,
      pipeline,
      blockConverter,
      imageHandler,
      propertyMapper,
      this.databaseSyncer,
      this.observation,
      this.drift,
      this.placement,
      this.detector,
      this.discovery,
    );
    this.pullPlanner = new PullPlanner(
      config,
      stateDb,
      vaultFs,
      this.databaseSyncer,
      this.drift,
      this.planner,
    );
    this.pusher = new PagePusher(
      config,
      stateDb,
      notionClient,
      vaultFs,
      pipeline,
      blockConverter,
      imageHandler,
      this.rowSchemas,
      this.observation,
      this.drift,
      this.placement,
      this.recovery,
    );
    this.conflictWorkflow = new ConflictWorkflow(
      stateDb,
      vaultFs,
      notionClient,
      changeDetector,
      new ConflictResolver(stateDb, vaultFs),
      this.observation,
      this.planner,
      this.puller,
      this.pusher,
    );
    this.inspector = new ChangeInspector(stateDb, vaultFs, notionClient, this.planner, this.puller);

    blockConverter.initNotionToMd(this.notionClient.getInternalClient());
  }

  /** 도는 작업 — 없으면 null(S-09). 부른 쪽이 겹칠 요청을 미리 거를 때 쓴다. */
  get runningOperation(): GatedOperation | null {
    return this.gate.running;
  }

  async push(options?: PushOptions): Promise<PushResult> {
    return this.gate.run("push", () => this.executePush(options));
  }

  private async executePush(options?: PushOptions): Promise<PushResult> {
    const startTime = Date.now();

    if (this.config.sync.direction === "pull") {
      return {
        created: 0,
        updated: 0,
        deleted: 0,
        moved: 0,
        failed: [],
        duration: Date.now() - startTime,
      };
    }

    this.observation.begin(startTime);
    // dry-run 은 상태를 바꾸지 않는다 — 끊긴 실행의 표시 · 폴더 레코드 · 끊긴 생성은 실제 push 가
    // 정리한다(N-03). 끊긴 생성을 되살려 입양할 노트도 dry-run 은 새로 만들 것으로 센다.
    if (!options?.dryRun) {
      this.recovery.cleanupInterruptedSync();
      this.placement.repairFolderRecords();
    }
    this.rowSchemas.clear();
    this.placement.resetUnpreparedFolders();
    if (!options?.dryRun) await this.recovery.recoverInterruptedPushOps();

    // 옮긴 노트 · 폴더는 올리기 전에 상태 DB 에 옮겨 적는다(S-11). 판정은 옮겨 적은 뒤의 모습으로
    // 한다 — dry-run 은 옮겨 적지 않고 같은 모습을 겹쳐 본다.
    const plan = await this.planner.planLocalChanges(await this.vaultFs.listMarkdownFileStats());
    const view = this.planner.localView(plan);
    if (!options?.dryRun) this.planner.adoptLocalMoves(plan);
    const changes = plan.scan.changes;

    const conflictPaths = new Set(this.stateDb.getByStatus("conflict").map((r) => r.obsidianPath));
    const eligible = options?.force ? changes : changes.filter((c) => !conflictPaths.has(c.path));

    const excludeSet = options?.excludePaths ? new Set(options.excludePaths) : null;
    const filtered = (
      options?.paths ? eligible.filter((c) => inAnyPathScope(c.path, options.paths)) : eligible
    ).filter((c) => !excludeSet || !excludeSet.has(c.path));
    // 범위를 좁힌 push 는 그 범위 안의 폴더만 옮긴다. 노트의 부모는 폴더 레코드의 페이지라, 폴더
    // 페이지를 옮기기 전에도 노트는 맞는 자리로 간다.
    const folderMoves = this.planner
      .pendingFolderMoves(plan)
      .filter((move) => inAnyPathScope(move.to, options?.paths));

    if (filtered.length === 0 && folderMoves.length === 0) {
      return {
        created: 0,
        updated: 0,
        deleted: 0,
        moved: 0,
        failed: [],
        duration: Date.now() - startTime,
      };
    }

    // 둘 자리가 없는 새 노트와 Notion 에서 그렇게 옮길 수 없는 노트 · 폴더는 이유와 함께 실패로
    // 남긴다. dry-run 도 같은 판정을 쓴다 — 실제 push 가 거절할 것을 세지 않는다(S-04 · S-11).
    const refusedCreates = this.placement.refusedCreates(filtered, view.lookup);
    const refusedMoves = this.placement.refusedMoves(filtered, view);
    const refusedFailures: FailedOperation[] = [
      ...[...refusedCreates].map(([path, error]) => ({
        path,
        operation: "create" as const,
        error,
      })),
      ...[...refusedMoves].map(([path, error]) => ({ path, operation: "move" as const, error })),
    ];
    const movableFolders: PendingFolderMove[] = [];
    for (const move of folderMoves) {
      const error = this.placement.folderMoveRefusal(move.to, view.lookup);
      if (error) refusedFailures.push({ path: move.to, operation: "move", error });
      else movableFolders.push(move);
    }
    const applicable = filtered.filter(
      (c) => !refusedCreates.has(c.path) && !refusedMoves.has(c.path),
    );

    if (options?.dryRun) {
      // deleteSync 가 꺼져 있으면 실제 push 는 지운 노트를 대기로 적기만 한다 — 지우지도 세지도
      // 않는다(N-02). dry-run 도 지울 것으로 보이지 않는다.
      const planned = this.config.sync.deleteSync
        ? applicable
        : applicable.filter((c) => c.type !== "deleted");
      const items: ProgressItem[] = [
        ...movableFolders.map(({ to }) => ({ path: to, operation: "move" as const })),
        ...planned.map((change) => ({ path: change.path, operation: pushOperationOf(change) })),
      ];
      items.forEach((item, index) => options?.onProgress?.(index + 1, items.length, item));
      const count = (operation: ProgressItem["operation"]): number =>
        items.filter((item) => item.operation === operation).length;
      return {
        created: count("create"),
        updated: count("update"),
        deleted: count("delete"),
        moved: count("move"),
        failed: refusedFailures,
        duration: Date.now() - startTime,
      };
    }

    this.stateDb.setMeta("push_in_progress", "true");
    await this.observation.resolveBotUserId();

    const counts = { created: 0, updated: 0, deleted: 0, moved: 0 };
    const failed: FailedOperation[] = [...refusedFailures];

    let completed = 0;
    const total = movableFolders.length + applicable.length;

    // 옮긴 폴더의 페이지부터 — 그 아래로 옮긴 노트의 부모다.
    counts.moved += await this.pusher.pushFolderMoves(movableFolders, failed, (to) =>
      options?.onProgress?.(++completed, total, { path: to, operation: "move" }),
    );

    // 단건 변경을 적용하고 카운트를 올린다. 실패는 throw 로 호출자에 위임.
    const applyPushChange = async (change: LocalChange): Promise<void> => {
      switch (change.type) {
        case "created":
          await this.pusher.pushCreate(change.path);
          counts.created++;
          break;
        case "modified":
          await this.pusher.pushUpdate(change.path);
          counts.updated++;
          break;
        case "moved":
          await this.pusher.pushMove(change);
          counts.moved++;
          break;
        case "deleted": {
          const propagated = await this.pusher.pushDelete(change.path);
          if (propagated) counts.deleted++;
          break;
        }
      }
    };

    // 1차 처리 — 고정 크기 워커 풀(백프레셔). 실패분은 변경 객체째 재시도 큐로.
    const retryQueue: LocalChange[] = [];
    const firstAttempt = async (change: LocalChange): Promise<void> => {
      if (options?.signal?.aborted) return;
      options?.onProgress?.(++completed, total, {
        path: change.path,
        operation: pushOperationOf(change),
      });
      try {
        await withDeadline(
          () => applyPushChange(change),
          this.config.advanced.itemTimeoutMs,
          `push ${change.path}`,
        );
      } catch {
        retryQueue.push(change);
      }
    };
    // 폴더의 자리부터 — 새 폴더 노트는 여기서 먼저 올린다(S-15).
    const pushedEarly = await this.placement.prepareFolders(applicable, firstAttempt);
    await runPool(
      applicable.filter((c) => !pushedEarly.has(c.path)),
      firstAttempt,
      { concurrency: this.config.advanced.concurrency, signal: options?.signal },
    );

    // 재시도 — 워커 풀 병렬(기존엔 순차). 변경 객체를 그대로 들고 있어 경로 역매칭
    // 취약함이 없다. pushCreate 는 멱등하므로 부분 성공분을 다시 만들지 않는다.
    if (retryQueue.length > 0) {
      const retryWaitMs = this.config.advanced.retryWaitMs;
      getLogger().info(
        `[Im-Nobsidian] Push ${retryQueue.length}건 재시도 (${retryWaitMs / 1000}초 후)`,
      );
      await new Promise((r) => setTimeout(r, retryWaitMs));

      const retry = async (change: LocalChange): Promise<void> => {
        try {
          await withDeadline(
            () => applyPushChange(change),
            this.config.advanced.itemTimeoutMs,
            `push ${change.path}`,
          );
          getLogger().info(`[Im-Nobsidian] 재시도 성공: ${change.path}`);
        } catch (error) {
          failed.push({
            path: change.path,
            operation: pushOperationOf(change),
            error: error instanceof Error ? error.message : String(error),
          });
          getLogger().warn(`[Im-Nobsidian] 재시도 실패: ${change.path}`);
        }
      };
      // 첫 차례에 새 행 · 폴더 노트가 생기면 그 아래 폴더가 그제서야 자리를 얻는다 — 재시도 전에
      // 폴더를 다시 본다. 자리를 얻지 못한 폴더의 노트는 그 이유와 함께 실패로 남는다.
      const retriedEarly = await this.placement.prepareFolders(retryQueue, retry);
      await runPool(
        retryQueue.filter((c) => !retriedEarly.has(c.path)),
        retry,
        { concurrency: this.config.advanced.concurrency, signal: options?.signal },
      );
    }

    if (this.config.sync.syncFiles !== false) {
      try {
        const fileResults = await this.fileHandler.pushAllFiles();
        if (fileResults.length > 0) {
          getLogger().info(`[Im-Nobsidian] ${fileResults.length}개 파일 업로드 완료`);
        }
      } catch (error) {
        getLogger().warn("[Im-Nobsidian] 파일 업로드 중 오류:", error);
      }
    }

    this.stateDb.setMeta("last_push_at", new Date().toISOString());
    this.stateDb.setMeta("last_sync_at", new Date().toISOString());
    this.stateDb.setMeta("push_in_progress", "");
    // 완료/실패한 WAL 항목 정리 — 테이블 무한 증가 방지(미완료 항목은 보존).
    this.stateDb.clearCompletedOperations();

    return {
      created: counts.created,
      updated: counts.updated,
      deleted: counts.deleted,
      moved: counts.moved,
      failed,
      duration: Date.now() - startTime,
    };
  }

  async pull(options?: PullOptions): Promise<PullResult> {
    return this.gate.run("pull", () => this.executePull(options));
  }

  private async executePull(options?: PullOptions): Promise<PullResult> {
    const startTime = Date.now();
    this.puller.beginPull();
    this.rowSchemas.clear();
    const emptyResult: PullResult = {
      created: 0,
      updated: 0,
      deleted: 0,
      restored: 0,
      conflicts: [],
      writtenPaths: [],
      failed: [],
      duration: Date.now() - startTime,
      imageCount: 0,
      fileCount: 0,
      linkCount: 0,
    };

    if (this.config.sync.direction === "push") {
      return emptyResult;
    }

    this.observation.begin(startTime);
    if (!options?.dryRun) this.recovery.cleanupInterruptedSync();

    // 옮긴 노트를 먼저 옮겨 적는다 — 아니면 옛 자리의 노트를 되살리고 원격 변경을 옛 경로에
    // 쓴다(S-11). dry-run 은 옮겨 적지 않고, 옮겨 적을 노트를 되살릴 대상에서 뺀다.
    // 볼트를 읽지 못하면(읽는 사이 파일이 사라짐 등) 옮긴 노트와 지운 노트를 가를 수 없다 —
    // 이번 pull 은 사라진 노트를 되살리지 않는다. 되살리면 옮긴 노트가 옛 자리에도 생긴다.
    let localPlan: LocalPlan | null = null;
    try {
      localPlan = await this.planner.planLocalChanges(await this.vaultFs.listMarkdownFileStats());
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 볼트를 읽지 못해 옮긴 노트를 확인하지 못함 — 이번 pull 은 사라진 노트를 되살리지 않는다: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (localPlan && !options?.dryRun) this.planner.adoptLocalMoves(localPlan);
    const adopting = new Set(localPlan?.scan.adoptions.map((adoption) => adoption.record.id));

    const counts = { created: 0, updated: 0, deleted: 0, restored: 0 };
    this.discovery.clearInlineRefs();
    const conflicts: Conflict[] = [];
    const writtenPaths: string[] = [];
    const failed: FailedOperation[] = [];
    // 감지한 원격 변경과 그중 적용을 마친 것 — 받지 못한 변경이 다음 기준 시각을 묶는다.
    let detected: readonly RemoteChange[] = [];
    const applied = new Set<RemoteChange>();

    await this.observation.resolveBotUserId();
    // 원격을 얼마나 훑을지(ADR-027). 경로를 좁힌 pull 은 볼트 전체를 받지 않으므로 주기가 됐어도
    // 전체 대조하지 않는다 — 전체 대조를 마친 것으로 적을 수 없다.
    const scan = this.detector.remoteScan({
      force: options?.force === true,
      deferDue: !!options?.paths,
    });
    let detection: RemoteDetection;
    try {
      detection = await this.detector.detectRemote(scan, {
        signal: options?.signal,
        databases: true,
      });
    } catch (error) {
      // 취소 — 받은 것이 없다. 기준 시각 · 전체 대조 시각을 옮기지 않고 끝낸다.
      if (error instanceof OperationAbortedError) {
        return { ...emptyResult, duration: Date.now() - startTime };
      }
      throw error;
    }
    const remoteChanges = detection.changes;
    detected = remoteChanges;
    const pendingDatabases = parsePendingDatabases(
      this.stateDb.getMeta(PENDING_DATABASES_META_KEY),
    );
    const ledger = new DatabasePullLedger(
      this.detector.databaseSelection(
        detection,
        localPlan?.scan.changes ?? null,
        pendingDatabases,
        options?.paths,
      ),
      pendingDatabases,
    );

    // M2: pull 의 모든 종료 경로가 동일하게 마감되도록 단일 헬퍼로 모은다 —
    // 기록된 파일(writtenPaths)의 본문 링크·frontmatter relation 후처리(resolveNotionLinks)와
    // 메타 마킹을 빠짐없이 거친다. 과거엔 디스커버리 DB 전용 조기 반환 경로가 이 후처리를
    // 건너뛰어, 그 행들의 위키링크/relation 이 UUID 그대로 남았다.
    const finalize = async (
      created: number,
      updated: number,
      deleted: number,
      restored = 0,
    ): Promise<PullResult> => {
      const linkCount = writtenPaths.length > 0 ? await this.resolveNotionLinks(writtenPaths) : 0;
      // 기준 시각은 pull 을 시작한 때로, 받지 못한 변경(재시도까지 실패 · 중단으로 건너뜀)이
      // 있으면 그 수정 시각 앞으로 묶는다. 경로를 좁힌 pull 은 범위 밖을 받지 않았으므로
      // 옮기지 않는다 — 옮기면 범위 밖 변경이 다음 조회 창 밖으로 밀린다.
      if (!options?.paths) {
        const startedAt = new Date(startTime).toISOString();
        this.stateDb.setMeta(
          "last_pull_at",
          nextPullWatermark(
            startedAt,
            detected.filter((change) => !applied.has(change)),
          ),
        );
        // 전체 대조를 마쳤다 — 취소로 끊겼으면 다 훑지 못했으니 적지 않는다. 받지 못한 DB 는
        // 대기로 남아 다음 pull 이 조회한다.
        if (scan.kind === "full" && !options?.signal?.aborted) {
          this.stateDb.setMeta(LAST_FULL_PULL_META_KEY, startedAt);
        }
        this.detector.savePendingDatabases(ledger);
      }
      this.stateDb.setMeta("last_sync_at", new Date().toISOString());
      this.stateDb.setMeta("pull_in_progress", "");
      return {
        created,
        updated,
        deleted,
        restored,
        conflicts,
        writtenPaths,
        failed,
        duration: Date.now() - startTime,
        imageCount: this.puller.imageCount,
        fileCount: this.puller.fileCount,
        linkCount,
        remoteScan: {
          ...remoteScanInfo(
            scan,
            this.stateDb.getMeta(LAST_FULL_PULL_META_KEY),
            this.config.sync.deleteSync,
          ),
          skippedDatabases: ledger.skipped,
        },
      };
    };

    const filtered = options?.paths
      ? remoteChanges.filter((c) => {
          const record = this.stateDb.getByNotionId(c.pageId);
          return !!record && inAnyPathScope(record.obsidianPath, options.paths);
        })
      : remoteChanges;

    // D-DELETE-NORESTORE: 원격 변경 감지는 "Notion 에서 바뀐 것"만 본다. 로컬에서 지워진
    // 추적 파일은 어느 경로로도 큐에 오르지 않아, 증분이든 --force 든 되살아나지 않고
    // 영구히 발산했다(실측 0/4). 상태 DB 와 실제 볼트의 차집합으로 직접 잡아 복원 대상으로
    // 밀어 넣는다. 이미 원격 변경으로 큐에 오른 페이지는 중복 처리하지 않는다.
    const queuedIds = new Set(filtered.map((c) => c.pageId));
    const missingLocal = localPlan
      ? await detectMissingLocalFiles(this.config, this.stateDb, this.vaultFs, options?.paths)
      : [];
    const restoreChanges: RemoteChange[] = missingLocal
      .filter(
        (r) => r.notionPageId !== null && !queuedIds.has(r.notionPageId) && !adopting.has(r.id),
      )
      .map((r) => ({
        pageId: r.notionPageId as string,
        type: "modified" as const,
        lastEdited: r.notionLastEdited ?? r.updatedAt,
        previousEdited: r.notionLastEdited,
      }));
    const restoreIds = new Set(restoreChanges.map((c) => c.pageId));
    const workItems = restoreChanges.length > 0 ? [...filtered, ...restoreChanges] : filtered;

    // dry-run 은 여기서 끝낸다 — 아래 DB 경로 · 마감(finalize)은 행을 쓰고 기준 시각을 옮긴다.
    // 예전에는 페이지 변경이 없으면 dry-run 도 아래 DB 경로로 가 행을 실제로 썼다(N-01).
    if (options?.dryRun) {
      return this.pullPlanner.planPull(
        filtered,
        restoreChanges,
        localPlan,
        options,
        startTime,
        scan,
        ledger,
      );
    }

    let pullTotal = workItems.length;
    let pullCompleted = 0;
    // 행은 DB 를 조회해야 몇 개인지 안다 — 받을 행 수만큼 전체를 늘려 페이지와 한 수 · 한 목록으로
    // 보인다. 예전에는 행을 알리지 않아, 행이 대부분인 볼트는 pull 내내 진행 표시가 멈춰 보였다.
    const onProgress = options?.onProgress;
    const rowProgress: RowProgress | undefined = onProgress && {
      planned: (count) => {
        pullTotal += count;
      },
      done: (item) => onProgress(++pullCompleted, pullTotal, item),
    };

    // 설정한 DB(pullAll)와 발견한 DB 를 받는다. 조회는 `ledger` 가 고른 DB 만 — 바뀐 것이 보이지
    // 않은 DB 는 요청 없이 건너뛴다(ADR-027). 예전에는 pull 마다 모든 DB 를 다시 조회했다(실볼트
    // 발견 DB 166개 — 원격이 그대로여도 재pull 523.5초).
    const pullDatabases = async (): Promise<void> => {
      if ((this.config.notion.databases?.length ?? 0) > 0) {
        try {
          const dbResult = await this.databaseSyncer.pullAll({
            paths: options?.paths,
            progress: rowProgress,
            ledger,
            signal: options?.signal,
          });
          counts.created += dbResult.created;
          counts.updated += dbResult.updated;
          counts.deleted += dbResult.deleted;
          counts.restored += dbResult.restored;
          conflicts.push(...dbResult.conflicts);
          failed.push(...dbResult.failed);
          // M3: 후처리 대상은 실제 기록된 행 경로를 그대로 받는다. 과거엔 "synced 상태의
          // db-row 중 마지막 N개" 라는 슬라이스 추정을 썼는데, 정렬·기존행 혼입 때문에
          // 엉뚱한 파일을 후처리하거나 갓 쓴 행을 놓쳐 링크가 미해소로 남았다.
          writtenPaths.push(...dbResult.writtenPaths);
        } catch (error) {
          // 경고로만 남기면 pull 이 성공으로 끝나, 사용자는 설정한 DB 를 받지 못한 줄 모른다.
          getLogger().warn("[Im-Nobsidian] DB Pull 중 오류:", error);
          failed.push({
            path: "",
            operation: "update",
            error: `설정한 DB 를 받지 못함: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const dbDiscovery = await this.discovery.pullDiscoveredDatabases(
        writtenPaths,
        failed,
        conflicts,
        {
          forceRediscovery: options?.force === true,
          paths: options?.paths,
          progress: rowProgress,
          ledger,
          signal: options?.signal,
        },
      );
      counts.created += dbDiscovery.created;
      counts.updated += dbDiscovery.updated;
      counts.deleted += dbDiscovery.deleted;
      counts.restored += dbDiscovery.restored;
    };

    if (workItems.length === 0) {
      // 본문 페이지에 변경이 없어도 DB 행은 원격에서 바뀌었거나 로컬에서 사라졌을 수 있다.
      // 그래서 "변경 없음"으로 끊기 전에 DB 경로를 반드시 거친다 — 설정된 DB(pullAll)와
      // 디스커버리 DB 둘 다. 과거엔 설정된 DB 가 하나라도 있으면 여기서 곧장 emptyResult 로
      // 빠져나가, 그 DB 의 원격 변경도 로컬 삭제 복원도 조용한 pull 에서는 영영 반영되지
      // 않았다(디스커버리 DB 만 살아 있던 한쪽 누락). 아래 정상 경로는 두 DB 소스를 모두
      // 거치므로, 이 조기 반환만 어휘가 달랐던 셈이다.
      // 기록이 0건이면 writtenPaths 가 비어 linkCount 0 으로 마감된다(emptyResult 와 동일).
      // 기록이 생겼다면 그 행들의 본문 링크·frontmatter relation 을 finalize 가 해소한다(M2).
      await pullDatabases();
      return finalize(counts.created, counts.updated, counts.deleted, counts.restored);
    }

    this.stateDb.setMeta("pull_in_progress", "true");

    // 변경 메타를 FailedOperation 으로 변환(경로·작업종류·에러 메시지).
    const toFailure = (change: RemoteChange, error: unknown): FailedOperation => {
      const record = this.stateDb.getByNotionId(change.pageId);
      return {
        path: record?.obsidianPath ?? change.pageId,
        operation:
          change.type === "created" ? "create" : change.type === "deleted" ? "delete" : "update",
        error: error instanceof Error ? error.message : String(error),
      };
    };

    // 단일 변경을 적용하고 진행률 표시용 경로를 돌려준다. 실패는 throw 로 호출자에 위임.
    const applyChange = async (change: RemoteChange): Promise<string | undefined> => {
      switch (change.type) {
        case "created": {
          const path = await this.puller.pullCreate(change.pageId);
          writtenPaths.push(path);
          counts.created++;
          return path;
        }
        case "modified": {
          const outcome = await this.puller.pullUpdate(change);
          if (outcome.action === "conflict") {
            conflicts.push(outcome.conflict);
          } else if (outcome.action === "written") {
            writtenPaths.push(outcome.path);
            if (restoreIds.has(change.pageId)) counts.restored++;
            else counts.updated++;
          }
          // unchanged(받을 것이 없음 — I5) · skipped(local-first 가 로컬을 지킴)는 받은 것이 아니다.
          // 세지 않고, sync 의 이어지는 push 에서도 빼지 않는다(F-h).
          return outcome.path;
        }
        case "deleted": {
          const outcome = await this.puller.pullDelete(change);
          if (outcome.action === "deleted") counts.deleted++;
          else if (outcome.action === "conflict") conflicts.push(outcome.conflict);
          return outcome.path;
        }
        default:
          return undefined;
      }
    };

    // 1차 처리 — 고정 크기 워커 풀(백프레셔). 실패한 변경은 재시도 큐로 모은다.
    const retryQueue: RemoteChange[] = [];
    await runPool(
      workItems,
      async (change) => {
        if (options?.signal?.aborted) return;
        try {
          const resultPath = await withDeadline(
            () => applyChange(change),
            this.config.advanced.itemTimeoutMs,
            `pull ${this.stateDb.getByNotionId(change.pageId)?.obsidianPath ?? change.pageId}`,
          );
          applied.add(change);
          const record = this.stateDb.getByNotionId(change.pageId);
          const displayPath = resultPath ?? record?.obsidianPath ?? change.pageId;
          const op =
            change.type === "created"
              ? ("create" as const)
              : change.type === "deleted"
                ? ("delete" as const)
                : ("update" as const);
          options?.onProgress?.(++pullCompleted, pullTotal, { path: displayPath, operation: op });
        } catch {
          retryQueue.push(change);
        }
      },
      { concurrency: this.config.advanced.concurrency, signal: options?.signal },
    );

    // 재시도 — 1차와 동일하게 워커 풀로 병렬 실행(기존엔 순차였다). 변경 객체를
    // 그대로 들고 있으므로 경로 문자열로 역매칭하던 취약함이 사라진다.
    if (retryQueue.length > 0) {
      const retryWaitMs = this.config.advanced.retryWaitMs;
      getLogger().info(
        `[Im-Nobsidian] Pull ${retryQueue.length}건 재시도 (${retryWaitMs / 1000}초 후)`,
      );
      await new Promise((r) => setTimeout(r, retryWaitMs));

      await runPool(
        retryQueue,
        async (change) => {
          try {
            await withDeadline(
              () => applyChange(change),
              this.config.advanced.itemTimeoutMs,
              `pull ${this.stateDb.getByNotionId(change.pageId)?.obsidianPath ?? change.pageId}`,
            );
            applied.add(change);
            const record = this.stateDb.getByNotionId(change.pageId);
            getLogger().info(
              `[Im-Nobsidian] 재시도 성공: ${record?.obsidianPath ?? change.pageId}`,
            );
          } catch (error) {
            const failure = toFailure(change, error);
            failed.push(failure);
            getLogger().warn(`[Im-Nobsidian] 재시도 실패: ${failure.path}`);
          }
        },
        { concurrency: this.config.advanced.concurrency, signal: options?.signal },
      );
    }

    await pullDatabases();
    return finalize(counts.created, counts.updated, counts.deleted, counts.restored);
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    return this.gate.run("sync", () => this.executeSync(options));
  }

  private async executeSync(options?: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    // 받기 · 올리기를 한 번에 돌리므로 진행 항목에 어느 쪽인지 적는다 — 화면이 둘을 가른다.
    const onProgress = options?.onProgress;
    const tagged = (direction: "pull" | "push"): ProgressCallback | undefined =>
      onProgress && ((current, total, item) => onProgress(current, total, { ...item, direction }));
    const pullResult = await this.executePull({ ...options, onProgress: tagged("pull") });
    const pushResult = await this.executePush({
      ...options,
      onProgress: tagged("push"),
      paths: options?.paths,
      excludePaths: pullResult.writtenPaths,
    });

    return {
      pull: pullResult,
      push: pushResult,
      conflicts: pullResult.conflicts,
      duration: Date.now() - startTime,
    };
  }

  /** 원격까지 본다 — 이번 실행의 원격 기준을 정하므로 다른 작업과 겹치지 않는다. */
  async status(): Promise<StatusResult> {
    return this.gate.run("status", () => this.executeStatus());
  }

  private async executeStatus(): Promise<StatusResult> {
    this.observation.begin(Date.now());
    const plan = await this.planner.planLocalChanges(await this.vaultFs.listMarkdownFileStats());
    const localChanges = plan.scan.changes;
    const lastSyncAt = this.stateDb.getMeta("last_sync_at");
    await this.observation.resolveBotUserId();
    // 상태 확인은 주기가 됐어도 전체 대조하지 않는다 — 볼트를 받지 않아 마쳤다고 적을 수 없고, 확인할
    // 때마다 분 단위를 쓰게 된다. 원격 삭제는 다음 pull 의 전체 대조가 보인다(ADR-027).
    const scan = this.detector.remoteScan({ force: false, deferDue: true });
    const detection = await this.detector.detectRemote(scan, { databases: false });
    const remoteChanges = await this.drift.withoutUnchangedRemotes(detection.changes);
    const conflictRecords = this.stateDb.getByStatus("conflict");

    const conflicts: Conflict[] = await this.conflictWorkflow.buildConflictsFromRecords(
      conflictRecords,
      localChanges,
      remoteChanges,
    );
    const lastFullScanAt = this.stateDb.getMeta(LAST_FULL_PULL_META_KEY);

    return {
      localChanges,
      folderMoves: this.planner.folderMoveChanges(plan),
      remoteChanges,
      conflicts,
      conflictRecords,
      pendingOperations: conflictRecords.length,
      lastSyncAt,
      lastFullScanAt,
      remoteScan: remoteScanInfo(scan, lastFullScanAt, this.config.sync.deleteSync),
    };
  }

  /**
   * 로컬만 본다 — 원격 기준을 정하지 않아 도는 작업과 겹쳐도 된다. 변경은 push 가 쓰는 판정 그대로다
   * (옮긴 노트 · 폴더 포함). 상태 DB 는 바꾸지 않는다.
   */
  async statusLocal(): Promise<StatusResult> {
    const plan = await this.planner.planLocalChanges(await this.vaultFs.listMarkdownFileStats());
    const conflictRecords = this.stateDb.getByStatus("conflict");
    const lastSyncAt = this.stateDb.getMeta("last_sync_at");

    return {
      localChanges: plan.scan.changes,
      folderMoves: this.planner.folderMoveChanges(plan),
      remoteChanges: [],
      conflicts: [],
      conflictRecords,
      pendingOperations: conflictRecords.length,
      lastSyncAt,
      lastFullScanAt: this.stateDb.getMeta(LAST_FULL_PULL_META_KEY),
    };
  }

  /**
   * 볼트에서 노트 · 폴더의 이름을 바꿨다는 기록 — 플러그인이 볼트의 rename 이벤트로 알린다(S-11).
   *
   * 다음 실행이 옮긴 노트를 추적 레코드와 짝지을 때 쓴다. 이름과 내용을 함께 바꾼 노트는 이
   * 기록 없이는 짝을 찾지 못해, 옛 페이지를 지우고 새 페이지를 만든다.
   */
  recordLocalRename(from: string, to: string, kind: RenameKind): void {
    this.planner.writeRenameHints(recordRenameHint(this.planner.renameHints(), from, to, kind));
  }

  /** 볼트에서 지운 노트 · 폴더 — 그 자리를 새 경로로 적은 힌트를 버린다. */
  recordLocalDelete(path: string): void {
    const hints = this.planner.renameHints();
    if (isEmptyRenameHints(hints)) return;
    this.planner.writeRenameHints(forgetRenameHint(hints, path));
  }

  /**
   * 볼트 완결성 검증 — 원격에 있는 것이 볼트에 빠짐없이 있는지 대조한다(R11-B · R12-C).
   *
   * 기존 게이트(해시 일치·repull 바이트 동일·churn 0)는 전부 **멱등성**을 본다. 매번
   * 같은 것을 놓치는 체계적 미발견은 그 게이트를 전부 통과한다 — 실제로 296개 DB 행이
   * 그렇게 침묵 유실됐다. 여기서만 "빠짐없다"를 본다.
   *
   * 대조 대상 database id 는 이 클래스가 조립한다: 설정에 적힌 것 + 디스커버리 캐시가
   * 아는 것 + DB 모드의 루트 DB. 캐시 표현(`discovered_dbs` 메타 키)은 `discovered-databases.ts`
   * 한 곳이 정하고 여기서 조립한다 — 호출부(CLI·E2E)가 그 표현을 각자 다시 해석하지 않게.
   *
   * 페이지(R12-C)는 pull 이 쓴 경로가 아니라 **search 열거**로 대조한다. 페이지는 열거
   * 경로가 둘이고 둘이 같은 집합을 내지 않는 게 애초의 결함이므로(R12-A), 독립된 두 번째
   * 열거와 맞대 봐야 의미가 있다.
   */
  async verifyCompleteness(): Promise<VaultCompletenessReport> {
    const ids: string[] = [];
    if (isDatabaseMode(this.config)) ids.push(this.config.notion.databaseId!);
    for (const db of this.config.notion.databases ?? []) ids.push(db.databaseId);

    // 캐시가 깨졌으면 설정·볼트 추적분만으로 대조한다(검증 자체는 계속).
    for (const entry of parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY))) {
      if (entry.databaseId) ids.push(entry.databaseId);
    }

    const databases = await verifyDatabaseCompleteness(this.notionClient, this.stateDb, {
      databaseIds: ids,
    });

    // 페이지 대조는 페이지 모드에서만 의미가 있다 — DB 모드에는 root 서브트리가 없다.
    const pages = isDatabaseMode(this.config)
      ? null
      : await verifyPageCompleteness(
          this.notionClient,
          this.stateDb,
          this.config.notion.rootPageId,
        );

    return { databases, pages, complete: databases.complete && (pages?.complete ?? true) };
  }

  async fetch(): Promise<{
    newPages: number;
    deletedPages: number;
    modifiedPages: number;
    duration: number;
  }> {
    return this.gate.run("fetch", () => this.executeFetch());
  }

  private async executeFetch(): Promise<{
    newPages: number;
    deletedPages: number;
    modifiedPages: number;
    duration: number;
  }> {
    const startTime = Date.now();
    const changes = await this.detector.detectRemoteChanges();
    this.stateDb.setMeta("last_fetch_at", new Date().toISOString());
    return {
      newPages: changes.filter((c) => c.type === "created").length,
      modifiedPages: changes.filter((c) => c.type === "modified").length,
      deletedPages: changes.filter((c) => c.type === "deleted").length,
      duration: Date.now() - startTime,
    };
  }

  /** pull 이 쓴 노트의 Notion 링크를 볼트 링크로 푼다 — 푼 링크 수를 돌려준다. */
  private async resolveNotionLinks(paths: string[]): Promise<number> {
    return resolveNotionLinks(this.stateDb, this.vaultFs, paths);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 충돌 해소 · 변경 살펴보기 — 규칙은 ConflictWorkflow · ChangeInspector 가 갖는다. 여기는 공개
  // API 로 이어 주고, 해소 · 되돌리기는 다른 작업과 겹치지 않게 돌린다(S-09).
  // ──────────────────────────────────────────────────────────────────────────

  /** 해소 대상 충돌 목록 — 원격 본문을 pull 과 같은 파이프라인으로 렌더해 담는다. */
  async listConflicts(): Promise<Conflict[]> {
    return this.conflictWorkflow.listConflicts();
  }

  /**
   * 추적 파일의 현재 원격 본문을 pull 과 같은 변환으로 렌더한다 — 표시 전용이라 첨부를 내려받지
   * 않는다. 추적되지 않았거나 원격 페이지가 없으면 null.
   */
  async renderRemoteSnapshot(path: string): Promise<string | null> {
    return this.inspector.renderRemoteSnapshot(path);
  }

  /** 로컬 변경 하나의 두 글 — 지난 동기화 때의 글과 지금 볼트의 글. 표시 전용이라 잠그지 않는다. */
  async localChangeDiff(change: LocalChange): Promise<ChangeDiff> {
    return this.inspector.localChangeDiff(change);
  }

  /** 원격 변경 하나의 두 글 — 지난 동기화 때의 글과 Notion 의 지금 글. 표시 전용이라 잠그지 않는다. */
  async remoteChangeDiff(change: RemoteChange): Promise<ChangeDiff> {
    return this.inspector.remoteChangeDiff(change);
  }

  /** 해소할 게 남지 않은 충돌 레코드를 `synced` 로 되돌리고, 되돌린 경로를 반환한다. */
  clearStaleConflicts(conflicts: readonly Conflict[]): string[] {
    return this.gate.runSync("resolve", () => this.conflictWorkflow.clearStaleConflicts(conflicts));
  }

  /** 단일 충돌을 사용자가 고른 선택지(local/remote/merge/duplicate)로 해소 + Notion 전파. */
  async resolveConflict(conflict: Conflict, choice: ResolutionChoice): Promise<ResolutionResult> {
    return this.gate.run("resolve", () => this.conflictWorkflow.resolveConflict(conflict, choice));
  }

  /** 단일 충돌을 전략(manual/local-first/remote-first/duplicate)으로 해소 + Notion 전파. */
  async resolveConflictByStrategy(
    conflict: Conflict,
    strategy: ConflictStrategy,
  ): Promise<ResolutionResult> {
    return this.resolveConflict(conflict, choiceForStrategy(conflict, strategy));
  }

  /** 여러 충돌을 동일 전략으로 일괄 해소 + Notion 전파. 하나를 올리지 못해도 나머지를 푼다. */
  async resolveAllConflicts(
    conflicts: Conflict[],
    strategy: ConflictStrategy,
  ): Promise<ResolutionResult[]> {
    return this.gate.run("resolve", () =>
      this.conflictWorkflow.resolveAllConflicts(conflicts, strategy),
    );
  }

  /**
   * 로컬 변경 하나를 지난 동기화 때의 글로 되돌린다 — Git 의 `restore` 와 같다. Notion 은 건드리지
   * 않는다. 되돌릴 원본이 없는 것은 이유와 함께 거절한다.
   */
  async discardLocalChange(path: string): Promise<void> {
    return this.gate.run("discard", () => this.inspector.discardLocalChange(path));
  }

  /** 충돌 미리보기용 줄 비교(로컬 vs 원격). 해소 없이 표시 전용. */
  generateConflictDiff(conflict: Conflict): string {
    return this.conflictWorkflow.generateConflictDiff(conflict);
  }
}

/** 로컬 변경을 Notion 에 반영하는 일 — 진행 표시 · 결과 수 · 실패가 같은 이름을 쓴다. */
function pushOperationOf(change: LocalChange): ProgressItem["operation"] {
  switch (change.type) {
    case "created":
      return "create";
    case "deleted":
      return "delete";
    case "moved":
      return "move";
    case "modified":
      return "update";
  }
}
