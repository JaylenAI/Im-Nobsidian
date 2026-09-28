import type {
  PushOptions,
  PushResult,
  PullOptions,
  PullResult,
  SyncOptions,
  SyncResult,
  StatusResult,
  SyncRecord,
  LocalChange,
  RemoteChange,
  Conflict,
  ConflictStrategy,
  FailedOperation,
  FileType,
  ChangeDiff,
  ProgressCallback,
  ProgressItem,
} from "../types/sync.js";
import type { Config } from "../types/config.js";
import type { ConversionResult } from "../types/convert.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { NotionClient } from "../notion/client.js";
import { isNotionObjectNotFound } from "../notion/client.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { Sema } from "async-sema";
import { ChangeDetector } from "./change-detector.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import { createDefaultPipeline } from "../converter/pipeline-factory.js";
import { BlockConverter } from "../converter/block-converter.js";
import { ImageHandler } from "./image-handler.js";
import { FileHandler } from "./file-handler.js";
import { DatabaseSyncer, type PlannedRow, type RowProgress } from "./database-syncer.js";
import { resolvePullConflict, sameNoteContent } from "./conflict-detector.js";
import type { PullOutcome } from "./pull-outcome.js";
import {
  applyRemoteDeletion,
  decideRemoteDeletion,
  remoteDeletionChange,
  remoteDeletionConflict,
  remotePresence,
  type RemoteDeletionOutcome,
} from "./remote-deletion.js";
import { verifyDatabaseCompleteness, verifyPageCompleteness } from "../audit/completeness.js";
import type { VaultCompletenessReport } from "../audit/completeness.js";
import { ConflictResolver, choiceForStrategy, isRemoteDeletion } from "../conflict/resolver.js";
import type { ResolutionChoice, ResolutionResult } from "../conflict/resolver.js";
import { PropertyMapper, type WikilinkResolver } from "../notion/property-mapper.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { compactNotionId, notionIdsEqual, normalizeNotionId } from "../utils/id.js";
import { inAnyPathScope } from "../utils/path-scope.js";
import { runPool } from "../utils/pool.js";
import { withDeadline } from "../utils/deadline.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { resolveFrontmatterRelations } from "./frontmatter-link-resolver.js";
import { readLocalNote, type VaultFS } from "./vault-fs.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../converter/enhanced-md-converter.js";
import { isCompactExport } from "../converter/post-processors/block-spacer.js";
import { hasBodyBesidesChildren } from "../converter/child-tags.js";
import {
  resolveNotionIdWikilinks,
  degradeUnresolvedNotionIdWikilinks,
  resolveNotionRelativePageLinks,
  degradeUnresolvedNotionRelativePageLinks,
} from "../converter/notion-id-links.js";
import { repairDbFolderCollisions } from "../utils/db-folder-path.js";
import { pagePathCandidates } from "../utils/db-row-path.js";
import { replacePageBody } from "./page-body.js";
import { remoteBodyFingerprint, type RemotePageStamp } from "./remote-observation.js";
import { nextPullWatermark } from "./pull-watermark.js";
import {
  DatabasePullLedger,
  LAST_FULL_PULL_META_KEY,
  parsePendingDatabases,
  PENDING_DATABASES_META_KEY,
  remoteScanInfo,
  type RemoteScan,
} from "./remote-scan.js";
import { OperationAbortedError } from "../utils/abort.js";
import { RowSchemaCache } from "./row-schema-cache.js";
import { diffRowProperties } from "./row-properties.js";
import { OperationGate } from "./operation-gate.js";
import { RunObservation } from "./run-observation.js";
import { InterruptedSyncRecovery } from "./interrupted-sync.js";
import { isDatabaseMode, rowDatabaseOf } from "./parent-mode.js";
import { extractParentId } from "./notion-parent.js";
import { DatabaseDiscovery } from "./database-discovery.js";
import { FolderPlacement } from "./folder-placement.js";
import { LocalPlanner, type LocalPlan, type PendingFolderMove } from "./local-planner.js";
import { RemoteDetector, type RemoteDetection } from "./remote-detector.js";
import { detectMissingLocalFiles } from "./missing-local-files.js";
import {
  refuseUnpulledBody,
  refuseUnpulledDeletion,
  RemoteDriftChecker,
  type RemoteDrift,
} from "./remote-drift.js";
import {
  DISCOVERED_DBS_META_KEY,
  loadInaccessibleDbIds,
  loadLinkedDbMap,
  parseDiscoveredDbs,
  type DiscoveredDbConfig,
} from "./discovered-databases.js";
import type { GatedOperation } from "./operation-gate.js";
import {
  explicitTitle,
  followsFileName,
  noteTitle,
  titleAfterMove,
  titleMayChange,
} from "./note-title.js";
import { parseFrontmatter, snapshotFrontmatter } from "../utils/frontmatter.js";
import {
  folderContainer,
  folderNoteOf,
  isFolderNotePath,
  isFolderRecord,
  parentFolderOf,
} from "./folder-container.js";
import {
  forgetRenameHint,
  isEmptyRenameHints,
  moveOrigin,
  recordRenameHint,
  type RenameKind,
} from "./local-moves.js";

/** DB 행을 보낼 때 견줄 기준 — 속성 · 제목 · 본문(null 이면 모름: 본문을 보낸다). */
interface RowState {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly title: string;
  readonly body: string | null;
}

/** push 가 만든 페이지 · 행. `markdown` 은 본문으로 보낸 markdown — 블록으로 보냈으면 null. */
interface CreatedPage {
  readonly page: PageObjectResponse;
  readonly markdown: string | null;
}

export class SyncOrchestrator {
  private readonly changeDetector: ChangeDetector;
  private readonly pipeline: ConversionPipeline;
  private readonly blockConverter: BlockConverter;
  private readonly imageHandler: ImageHandler;
  private readonly fileHandler: FileHandler;
  private readonly databaseSyncer: DatabaseSyncer;
  private readonly propertyMapper: PropertyMapper;
  /** DB 행 push 용 — DB 마다 스키마를 읽은 매퍼. 실행마다 비운다(S-01). */
  private readonly rowSchemas: RowSchemaCache;
  private readonly conflictResolver: ConflictResolver;
  private dbSchemaLoaded = false;
  private _pullImageCount = 0;
  private _pullFileCount = 0;

  // 이번 pull 실행에서 이미 배정된 파일 경로. 워커 풀이 동시에 도는 동안 동명 페이지가
  // 같은 경로를 골라 서로를 덮어쓰는 것을 막는다({@link resolveUniqueFilePath}).
  // 실행마다 비운다 — 지난 실행에서 삭제된 경로를 영구히 막지 않기 위해.
  private readonly claimedPaths = new Set<string>();

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
    this.changeDetector = new ChangeDetector(stateDb);
    this.pipeline = createDefaultPipeline({
      wikilinkResolver: (text) => stateDb.resolveWikilink(text),
    });
    this.blockConverter = new BlockConverter();
    this.imageHandler = new ImageHandler(
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
    this.propertyMapper = new PropertyMapper();
    this.databaseSyncer = new DatabaseSyncer(
      config,
      stateDb,
      notionClient,
      vaultFs,
      this.pipeline,
      this.imageHandler,
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
    // 후처리로만 해소되는 2-write churn 이 생긴다(DB 모드는 this.propertyMapper 가 처리).
    const wikilinkResolver: WikilinkResolver = {
      resolve: (title: string) => stateDb.resolveWikilink(title)?.notionPageId ?? null,
      resolvePageId: (pageId: string) => {
        const entry = stateDb.resolvePageId(pageId);
        return entry ? wikilinkTitleFromPath(entry.obsidianPath) : null;
      },
    };
    this.propertyMapper.setWikilinkResolver(wikilinkResolver);
    this.notionClient.setWikilinkResolver(wikilinkResolver);
    this.rowSchemas = new RowSchemaCache(
      (databaseId) => notionClient.getDatabaseSchema(databaseId),
      wikilinkResolver,
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
    this.planner = new LocalPlanner(config, stateDb, vaultFs, this.changeDetector, this.placement);

    this.blockConverter.initNotionToMd(this.notionClient.getInternalClient());
    this.conflictResolver = new ConflictResolver(stateDb, vaultFs);
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
    counts.moved += await this.pushFolderMoves(movableFolders, failed, (to) =>
      options?.onProgress?.(++completed, total, { path: to, operation: "move" }),
    );

    // 단건 변경을 적용하고 카운트를 올린다. 실패는 throw 로 호출자에 위임.
    const applyPushChange = async (change: LocalChange): Promise<void> => {
      switch (change.type) {
        case "created":
          await this.pushCreate(change.path);
          counts.created++;
          break;
        case "modified":
          await this.pushUpdate(change.path);
          counts.updated++;
          break;
        case "moved":
          await this.pushMove(change);
          counts.moved++;
          break;
        case "deleted": {
          const propagated = await this.pushDelete(change.path);
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
    // 이번 실행의 경로 선점 장부를 비운다 — 지난 실행에서 삭제된 경로를 계속 막지 않도록.
    this.claimedPaths.clear();
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
    this._pullImageCount = 0;
    this._pullFileCount = 0;
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
        imageCount: this._pullImageCount,
        fileCount: this._pullFileCount,
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
      return this.planPull(filtered, restoreChanges, localPlan, options, startTime, scan, ledger);
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
          const path = await this.pullCreate(change.pageId);
          writtenPaths.push(path);
          counts.created++;
          return path;
        }
        case "modified": {
          const outcome = await this.pullUpdate(change);
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
          const outcome = await this.pullDelete(change);
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

    const conflicts: Conflict[] = await this.buildConflictsFromRecords(
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

  /**
   * @param options.fullRender 원격 본문을 pull 과 동일한 파이프라인으로 렌더할지.
   *   기본(false)은 화면 미리보기용 경량 렌더 — 첨부를 내려받지 않으므로 `status` 처럼
   *   읽기만 하는 경로가 쓴다. 볼트에 덮어쓸 본문이 필요한 해소 경로는 반드시 켠다.
   */
  private async buildConflictsFromRecords(
    records: SyncRecord[],
    localChanges: LocalChange[],
    remoteChanges: RemoteChange[],
    options?: { fullRender?: boolean },
  ): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];

    for (const record of records) {
      const localChange = localChanges.find((c) => c.path === record.obsidianPath) ?? {
        path: record.obsidianPath,
        type: "modified" as const,
        currentHash: record.contentHash,
        previousHash: record.contentHash,
      };

      let localContent = "";
      try {
        localContent = await this.vaultFs.readFile(record.obsidianPath);
      } catch {
        // 파일이 삭제된 경우
      }

      let remoteContent = "";
      let remoteLastEdited: string | null = null;
      let remoteGone = false;
      if (record.notionPageId) {
        try {
          // 휴지통 · 보관 · 없음이면 원격에서 지운 노트의 충돌이다 — 렌더할 본문이 없다.
          const presence = await remotePresence(this.notionClient, record.notionPageId);
          if (presence.kind === "gone") {
            remoteGone = true;
          } else if (options?.fullRender) {
            remoteLastEdited = presence.page.last_edited_time;
            remoteContent = (
              await this.renderRemotePage(record, record.notionPageId, presence.page)
            ).content;
          } else {
            remoteContent = (await this.fetchPageMarkdown(record.notionPageId)).content;
          }
        } catch (error) {
          // 해소할 목록은 원격을 읽지 못하면 이유와 함께 실패한다(N-06). 빈 원격으로 충돌을 만들면
          // 병합은 원격이 모든 줄을 지운 것으로 보고, 원격 유지는 로컬을 빈 파일로 덮는다.
          if (options?.fullRender) {
            throw new Error(
              `충돌 노트의 원격을 읽지 못함 (${record.obsidianPath}): ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
          }
          // 상태 표시용 미리보기 — 읽지 못하면 원격을 비워 둔 채 충돌이 있다는 것만 보인다.
        }
      }

      if (remoteGone) {
        conflicts.push(
          remoteDeletionConflict(
            record,
            localContent,
            remoteChanges.find((c) => c.pageId === record.notionPageId && c.type === "deleted") ??
              remoteDeletionChange(record),
          ),
        );
        continue;
      }

      const remoteChange = remoteChanges.find((c) => c.pageId === record.notionPageId) ?? {
        pageId: record.notionPageId ?? "",
        type: "modified" as const,
        // 현재 원격 시각을 실제로 읽어왔다면 그 값을 쓴다. 해소 후 재조정(propagateResolution)
        // 이 이 값을 그대로 기준점으로 삼는데, 낡은 저장값을 실으면 다음 pull 이 같은 변경을
        // 다시 충돌로 보고 무한 재충돌한다.
        lastEdited: remoteLastEdited ?? record.notionLastEdited ?? "",
        previousEdited: null,
      };

      conflicts.push({
        syncRecord: record,
        localChange,
        remoteChange,
        baseContent: record.baseSnapshot?.toString("utf-8") ?? null,
        localContent,
        remoteContent,
      });
    }

    return conflicts;
  }

  private async resolveNotionLinks(paths: string[]): Promise<number> {
    let totalResolved = 0;
    let totalDegraded = 0;
    const allRecords = this.stateDb.getAll();
    const idToTitle = new Map<string, string>();
    const idToPath = new Map<string, string>();
    for (const r of allRecords) {
      if (r.notionPageId && r.obsidianPath) {
        // M4: 단일 변환 패스(resolvePageId)와 동일한 규칙으로 위키링크 텍스트를 만든다.
        const title = wikilinkTitleFromPath(r.obsidianPath);
        const cleanId = r.notionPageId.replace(/-/g, "");
        idToTitle.set(cleanId, title);
        idToTitle.set(r.notionPageId, title);
        idToPath.set(cleanId, r.obsidianPath);
      }
    }
    if (idToTitle.size === 0) return 0;

    // 두 표기(위키링크형·상대 url 형)가 **같은 역조회**를 봐야 한 표기만 해소되는 일이
    // 없다. 압축형/하이픈형 어느 쪽으로 들어와도 압축형 키로 맞춘다.
    const notionIdToPath = (id: string): string | null =>
      idToPath.get(id.replace(/-/g, "")) ?? null;

    for (const filePath of paths) {
      if (!filePath.endsWith(".md")) continue;
      try {
        let content = await this.vaultFs.readFile(filePath);
        let changed = false;

        // 변환 시점 패스(resolveNotionIdWikilinks)와 **같은 함수**를 쓴다. 자체 정규식을
        // 두던 시절엔 별칭 달린 `[[notion:<id>|별칭]]` 을 아예 매치하지 못해, 같은 pull
        // 안에서 나중에 만들어진 대상을 가리키는 링크가 대상이 볼트에 실재하는데도
        // 끊긴 채 남았다(실볼트 2건).
        const idPass = resolveNotionIdWikilinks(content, notionIdToPath);
        content = idPass.markdown;
        if (idPass.resolved > 0) {
          totalResolved += idPass.resolved;
          changed = true;
        }

        // 상대 url 표기(`[라벨](/p/<id>?…)`)도 **같은 모듈의 짝 함수**로 해소한다.
        // 여기 인라인 정규식으로 두던 시절엔 같은 규칙을 두 번 적는 대가를 치렀다 —
        // 자기별칭 접기를 빠뜨려 `[[X|X]]` 45건이 굳었고(R10-C), 격하도 빠뜨려 볼트
        // 밖 페이지를 가리키는 상대링크 89건이 끊긴 채 남았다(R10-D).
        const urlPass = resolveNotionRelativePageLinks(content, notionIdToPath);
        content = urlPass.markdown;
        if (urlPass.resolved > 0) {
          totalResolved += urlPass.resolved;
          changed = true;
        }

        // frontmatter 의 relation/people 원시 UUID → `[[제목]]`. 변환 시점에는 대상
        // 페이지가 미등록이라 UUID 로 남지만, 이 post-pass 시점엔 맵이 완성돼 해소된다.
        const fm = resolveFrontmatterRelations(content, idToTitle);
        if (fm.count > 0) {
          content = fm.content;
          totalResolved += fm.count;
          changed = true;
        }

        // 해소를 전부 시도한 **뒤** 남은 것 = 볼트 밖 페이지다. 끊긴 링크로 두지 않고
        // 동작하는 Notion URL 링크로 격하한다(순서가 뒤집히면 볼트에 실재하는 대상까지
        // 외부 링크로 굳는다). **두 표기 모두** 격하한다 — 한쪽만 하면 다른 쪽 표기로
        // 들어온 볼트 밖 링크가 끊긴 채 남는다(R10-B 는 위키링크형만 고쳐 상대 url 형
        // 89건이 남았다 → R10-D).
        for (const degrade of [
          degradeUnresolvedNotionIdWikilinks,
          degradeUnresolvedNotionRelativePageLinks,
        ]) {
          const degradation = degrade(content);
          if (degradation.degraded > 0) {
            content = degradation.markdown;
            totalDegraded += degradation.degraded;
            changed = true;
          }
        }

        if (changed) {
          await this.vaultFs.writeFile(filePath, content);
          // 링크 정규화로 디스크 내용이 바뀌었으므로 해당 sync record 의 해시·스냅샷·stat
          // 을 새 내용으로 재동기화한다. 이걸 빠뜨리면 디스크(위키링크 형태)와 저장 해시
          // (`/p/<id>` 형태)가 영구 불일치해 매 sync마다 "modified" 로 재감지되는
          // fixpoint 위반(I5)이 발생한다. push 가 가능한 파일은 다음 push 로 self-heal
          // 되지만, child page 를 가진 폴더노트는 push 가 실패해 영영 churn 한다.
          const record = this.stateDb.getByPath(filePath);
          if (record) {
            const stat = await this.vaultFs.getFileStat(filePath);
            this.stateDb.transaction(() => {
              this.stateDb.updateHash(
                record.id,
                computeHash(content),
                Buffer.from(content, "utf-8"),
              );
              if (stat) this.stateDb.updateStatCache(record.id, stat.mtime, stat.size);
            });
          }
        }
      } catch {
        // 파일 읽기/쓰기 실패 무시
      }
    }
    if (totalDegraded > 0) {
      getLogger().info(
        `[Im-Nobsidian] 볼트 밖 Notion 페이지 링크 ${totalDegraded}건을 URL 링크로 유지`,
      );
    }
    return totalResolved;
  }

  private async ensureDbSchema(): Promise<void> {
    if (this.dbSchemaLoaded || !isDatabaseMode(this.config)) return;
    const schema = await this.notionClient.getDatabaseSchema(this.config.notion.databaseId!);
    this.propertyMapper.loadSchema(schema);
    this.dbSchemaLoaded = true;
  }

  private async pushCreate(path: string): Promise<void> {
    // 멱등성/원자성: 이전 시도가 페이지 생성까지는 성공해 notionPageId 가 이미
    // 매핑돼 있으면(이미지 업로드 실패·크래시·인-런 재시도 등) 새 페이지를 또
    // 만들지 않고 업데이트 경로로 위임한다 → 고아 페이지·중복 생성 방지.
    const existingRecord = this.stateDb.getByPath(path);
    if (existingRecord?.notionPageId) {
      await this.pushUpdate(path);
      return;
    }

    const rowDatabaseId = this.placement.newRowDatabaseOf(path);
    if (rowDatabaseId) {
      await this.pushCreateRow(path, rowDatabaseId);
      return;
    }

    const content = await this.vaultFs.readFile(path);
    const parentId = await this.placement.resolveNotionParent(path);

    const selectedPath = this.pipeline.selectPath(content);
    if (selectedPath === "block-api") {
      getLogger().warn(
        `[Im-Nobsidian] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
      );
    }

    const conversionResult = this.pipeline.convertToNotion(content, {
      direction: "push",
      path: selectedPath,
      filePath: path,
      parentMode: this.config.notion.parentMode,
    });
    // 제목은 frontmatter `title` 이 먼저다 — 갱신(changedPageTitle) · 이동(titleAfterMove)과 같은
    // 규칙이어야 만든 뒤 첫 갱신에서 제목이 뒤집히지 않는다. 행도 같다(pushRowUpdate).
    const title = noteTitle(conversionResult.properties, path);

    // I12 WAL(쓰기-우선): 페이지를 만들기 전에 자리표시 state(notion_page_id=null) +
    // pending_operations(create) 를 먼저 기록한다. 생성 요청이 적용됐는데 응답이 유실되거나
    // (timeout) 프로세스가 죽어 매핑 기록 전에 중단되면, 다음 push 시작 시 recoverInterruptedPushOps
    // 가 부모에서 제목으로 고아 페이지를 찾아 입양하므로 중복 페이지 생성을 차단한다.
    const placeholder = this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: null,
      notionParentId: parentId,
      contentHash: "",
      notionLastEdited: null,
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: isFolderNotePath(path) ? "folder-note" : "file",
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });
    // 인-런 재시도 시 같은 state 에 대한 op 중복 기록을 막는다(기존 미완료 op 재사용).
    const existingOp = this.stateDb.getIncompleteOpByState(placeholder.id, "create");

    // 미완료 op 가 남아 있다 = 앞선 시도의 생성 요청이 적용됐는지 모른다(S-07 — 클라이언트는
    // 모호한 실패에서 생성 요청을 다시 보내지 않는다). 다시 만들기 전에 부모에서 제목으로
    // 찾아 입양한다. 목록을 읽지 못하면 던져서 이 항목만 실패로 남긴다 — 중복보다 낫다.
    if (existingOp) {
      const orphan = await this.recovery.findChildPageByTitle(parentId, title);
      if (orphan) {
        this.recovery.adoptOrphanPage(path, orphan.id, parentId, placeholder);
        this.stateDb.markPendingCompleted(existingOp.id);
        getLogger().info(`[Im-Nobsidian] 앞선 생성 요청이 적용돼 있었음 — 페이지 입양: ${path}`);
        await this.pushUpdate(path);
        return;
      }
    }

    const walOpId =
      existingOp?.id ??
      this.stateDb.recordPendingOperation({
        syncStateId: placeholder.id,
        operation: "create",
        direction: "push",
        payload: JSON.stringify({ path, parentId, title }),
      });

    const created = await this.pushCreatePage(
      parentId,
      "page",
      title,
      conversionResult.content,
      conversionResult.properties,
    );
    const { page } = created;

    // 페이지 생성 직후 매핑을 먼저 기록(전이 상태 pending). 이후 이미지 업로드 등이
    // 실패해도 이 레코드 덕에 다음 시도는 pushCreate(중복) 가 아니라 pushUpdate 로
    // 이어진다. contentHash 를 비워 변경감지가 "미완료 → 재푸시 필요"로 인식하게 한다.
    this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: page.id,
      notionParentId: parentId,
      contentHash: "",
      ...this.observation.fieldsOf(page, null),
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: isFolderNotePath(path) ? "folder-note" : "file",
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    const settled = await this.finishCreatedPage(created, conversionResult, path);

    const hash = computeHash(content);
    const fileStat = await this.vaultFs.getFileStat(path);

    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: path,
        notionPageId: page.id,
        notionParentId: parentId,
        contentHash: hash,
        ...this.observation.fieldsOf(settled.page, settled.bodyFingerprint),
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType: isFolderNotePath(path) ? "folder-note" : "file",
        status: "synced",
        baseSnapshot: Buffer.from(content, "utf-8"),
        localMtime: fileStat?.mtime ?? null,
        localFileSize: fileStat?.size ?? null,
      });

      const aliases = extractAliases(conversionResult.properties);
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: page.id,
        title: extractTitle(path),
        aliases,
      });

      this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
    });

    // 생성·매핑·이미지·최종 synced 까지 모두 끝났으므로 WAL 을 완료 처리한다.
    this.stateDb.markPendingCompleted(walOpId);
  }

  /**
   * DB 폴더(설정 · 자동 발견)에 새로 생긴 노트, 그리고 DB 모드의 새 노트를 그 DB 의 행으로
   * 만든다(S-04).
   *
   * 갱신(pushRowUpdate)과 같은 규칙이다 — 속성은 DB 스키마의 속성으로, 본문은 본문으로 보내고
   * 본문에 속성 YAML 을 끼우지 않는다. DB 에 없는 키(`cover` · `aliases` …)는 보내지 않는다.
   * 예전에는 자동 발견 DB 폴더의 새 노트가 DB 폴더 이름의 빈 페이지 아래 페이지로 만들어졌고,
   * 설정 DB 의 행은 WAL 없이 따로 만들어졌으며, DB 모드는 조상 폴더를 페이지로 만들었다.
   *
   * 생성 요청은 페이지와 같이 WAL 을 먼저 적는다. 요청이 적용됐는지 모르고 끝나면(S-07) 다음
   * 시도가 DB 에서 같은 제목의 짝 없는 행을 찾아 입양하고 로컬 내용으로 맞춘다.
   */
  private async pushCreateRow(path: string, databaseId: string): Promise<void> {
    const content = await this.vaultFs.readFile(path);
    const fileType = this.newRowFileType(path);
    // frontmatter 를 못 읽으면 만들지 않는다 — 파이프라인은 읽지 못한 frontmatter 를 «속성
    // 없음» 으로 넘겨, 제목만 있는 행이 생기고 속성은 사라진다.
    let current: ReturnType<typeof parseFrontmatter>;
    try {
      current = parseFrontmatter(content);
    } catch (error) {
      throw new Error(
        `frontmatter 를 읽지 못해 행을 만들지 않음 (${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const title = noteTitle(current.data, path);

    // 보낼 것을 먼저 다 만든다 — WAL 은 생성 요청 바로 앞에 적어야, 스키마를 읽지 못해 요청을
    // 보내지도 않은 실행이 «적용됐는지 모름» 기록을 남기지 않는다.
    const mapper = await this.rowSchemas.mapperFor(databaseId);
    const { properties, skipped } = mapper.toNotionPropertyChanges(
      diffRowProperties(null, current.data),
      title,
    );
    if (skipped.length > 0) {
      getLogger().info(
        `[Im-Nobsidian] 새 행 속성 ${skipped.length}개는 보내지 않음(DB 에 없는 속성 · 읽기 전용 · ` +
          `변환 불가): ${path} — ${skipped.join(", ")}`,
      );
    }
    const selectedPath = this.pipeline.selectPath(content);
    if (selectedPath === "block-api") {
      getLogger().warn(
        `[Im-Nobsidian] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
      );
    }
    const conversionResult = this.pipeline.convertToNotion(content, {
      direction: "push",
      path: selectedPath,
      filePath: path,
      parentMode: "database",
    });

    const placeholder = this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: null,
      notionParentId: databaseId,
      contentHash: "",
      notionLastEdited: null,
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType,
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });
    const existingOp = this.stateDb.getIncompleteOpByState(placeholder.id, "create");
    if (existingOp) {
      const orphan = await this.recovery.findUntrackedRowByTitle(databaseId, title);
      if (orphan) {
        this.recovery.adoptOrphanPage(path, orphan.id, databaseId, placeholder);
        this.stateDb.markPendingCompleted(existingOp.id);
        getLogger().info(`[Im-Nobsidian] 앞선 생성 요청이 적용돼 있었음 — 행 입양: ${path}`);
        // 입양한 행은 이 노트가 보낸 요청으로 생긴 것이다. 반쯤 채워졌을 수 있어 원격과 견줘
        // 다른 속성과 본문을 모두 보낸다.
        await this.pushUpdate(path, { overwriteRemote: true });
        return;
      }
    }

    const walOpId =
      existingOp?.id ??
      this.stateDb.recordPendingOperation({
        syncStateId: placeholder.id,
        operation: "create",
        direction: "push",
        payload: JSON.stringify({ path, parentId: databaseId, parentType: "database", title }),
      });

    const created = await this.pushCreatePage(
      databaseId,
      "database",
      title,
      conversionResult.content,
      properties,
    );
    const { page } = created;

    // 매핑을 먼저 적는다 — 첨부 업로드가 실패해도 다음 시도는 새로 만들지 않고 갱신한다.
    this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: page.id,
      notionParentId: databaseId,
      contentHash: "",
      ...this.observation.fieldsOf(page, null),
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType,
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    const settled = await this.finishCreatedPage(created, conversionResult, path);

    const fileStat = await this.vaultFs.getFileStat(path);
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: path,
        notionPageId: page.id,
        notionParentId: databaseId,
        contentHash: computeHash(content),
        ...this.observation.fieldsOf(settled.page, settled.bodyFingerprint),
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType,
        status: "synced",
        baseSnapshot: Buffer.from(content, "utf-8"),
        localMtime: fileStat?.mtime ?? null,
        localFileSize: fileStat?.size ?? null,
      });
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: page.id,
        title,
        aliases: extractAliases(current.data),
      });
      this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
    });

    this.stateDb.markPendingCompleted(walOpId);
  }

  /**
   * 노트에 박힌 로컬 미디어를 Notion 에 올린다(R1).
   *
   * 먼저 본문 자리표시자를 실제 image/file 블록으로 **제자리** 교체한다. 그러고도 남은
   * 이미지만 페이지 끝에 덧붙이는 예전 경로로 흘린다 — 자리표시자를 찾지 못했어도
   * (조회 실패 · 블록 방식 push 등) 이미지 자체는 올라가야 하므로 폴백을 남긴다.
   *
   * @returns 페이지 본문을 고쳤을 수 있으면 true — 본문을 보낸 뒤 만든 지문이 더는 맞지 않는다.
   */
  private async syncEmbeddedMedia(
    pageId: string,
    conversionResult: ConversionResult,
    path: string,
  ): Promise<boolean> {
    const { handledTargets, touched } = await this.imageHandler.materializeLocalMedia(
      pageId,
      conversionResult.content,
      path,
    );
    const leftovers = conversionResult.images.filter(
      (img) => !img.localPath || !handledTargets.has(img.localPath),
    );
    let appended = 0;
    if (leftovers.length > 0) {
      appended = (await this.imageHandler.uploadAndAppendImages(pageId, leftovers, path)).length;
    }
    return touched || appended > 0;
  }

  /**
   * @param options.overwriteRemote 원격을 로컬 내용으로 맞춘다(충돌 해소 결과 전파 · 입양한 행).
   *   원격이 바뀌었는지 확인하지 않고 덮어쓴다({@link RemoteDriftChecker.overwritesRemote}). DB 행은 비교 기준도
   *   달라진다(pushRowUpdate).
   */
  private async pushUpdate(path: string, options?: { overwriteRemote?: boolean }): Promise<void> {
    const content = await this.vaultFs.readFile(path);
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return;

    const rowDatabaseId = rowDatabaseOf(this.config, record);
    if (rowDatabaseId) {
      await this.pushRowUpdate(path, record, rowDatabaseId, content, {
        overwriteRemote: options?.overwriteRemote === true,
      });
      return;
    }

    const updatePath = this.pipeline.selectPath(content);
    if (updatePath === "block-api") {
      getLogger().warn(
        `[Im-Nobsidian] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
      );
    }

    const conversionResult = this.pipeline.convertToNotion(content, {
      direction: "push",
      path: updatePath,
      filePath: path,
      parentMode: this.config.notion.parentMode,
    });

    // 덮어쓰기 전에 pull 하지 않은 Notion 편집이 없는지 본다(N-05). 본문 밖만 바뀌었으면 본문은
    // 쓰되 수정 시각을 올리지 않는다 — 원격의 제목 변경은 다음 pull 이 받는다.
    const drift: RemoteDrift = this.drift.overwritesRemote(
      record,
      options?.overwriteRemote === true,
    )
      ? "none"
      : await this.drift.remoteDrift(record, await this.notionClient.getPage(record.notionPageId));
    refuseUnpulledBody(drift, path);
    const settles = drift === "none";

    let bodyFingerprint = await this.pushUpdatePage(
      record.notionPageId,
      conversionResult.content,
      record.baseSnapshot,
    );

    if (await this.syncEmbeddedMedia(record.notionPageId, conversionResult, path)) {
      bodyFingerprint = await this.drift.remoteBodyFingerprintOf(record.notionPageId);
    }

    // 페이지는 속성이 제목뿐이다 — 나머지 frontmatter 는 본문 첫머리 YAML 블록으로 간다
    // (PropertiesTableInjector). DB 행은 여기 오지 않는다(pushRowUpdate).
    const newTitle = this.changedPageTitle(record, content, path);
    const propsToUpdate = newTitle === null ? undefined : titleProperty(newTitle);

    // notionLastEdited 는 반드시 Notion 서버가 돌려준 값으로 저장한다. 로컬 시각
    // (new Date())을 쓰면 서버 시각과 클록 스큐·네트워크 지연만큼 어긋나 다음 pull 이
    // 가짜 modified 로 오인 → 불필요 재조회·집계(false-churn). 속성 갱신이 있으면 그
    // 응답이 최종 mutation 이라 권위값이고, 없으면(블록/이미지만 변경) 1회 getPage 로
    // 권위값을 받아 진짜 fixpoint 를 만든다. (I5 — pull 측 content_hash 가드와 이중 차단)
    let written: RemotePageStamp | null = null;
    if (propsToUpdate && Object.keys(propsToUpdate).length > 0) {
      written = await this.notionClient.updatePageProperties(record.notionPageId, propsToUpdate);
    } else if (settles) {
      written = await this.notionClient.getPage(record.notionPageId);
    }

    const hash = computeHash(content);
    const fileStat = await this.vaultFs.getFileStat(path);
    const title = extractTitle(path);
    const aliases = extractAliases(conversionResult.properties);
    this.stateDb.transaction(() => {
      this.stateDb.updateHash(record.id, hash, Buffer.from(content, "utf-8"));
      this.stateDb.updateStatus(record.id, "synced");
      if (written !== null && settles) {
        this.observation.record(record.id, written, bodyFingerprint);
      } else {
        this.stateDb.setNotionBodyFingerprint(record.id, bodyFingerprint);
      }
      if (fileStat) {
        this.stateDb.updateStatCache(record.id, fileStat.mtime, fileStat.size);
      }
      this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: record.notionPageId!,
        title,
        aliases,
      });
    });
  }

  /**
   * 페이지 제목을 바꿔야 하면 새 제목, 아니면 null.
   *
   * frontmatter `title` 을 고쳤을 때만 보낸다. 예전에는 갱신마다 `title` 을 보내, 파일 이름으로
   * 만든 페이지는 첫 갱신에서 제목이 뒤집히고, 이름을 바꿔 올린 제목도 다음 갱신이 옛 `title` 로
   * 되돌렸다(S-11). `title` 을 지웠으면 파일 이름으로 돌아간다. frontmatter 를 읽지 못하면
   * 제목을 건드리지 않는다 — 못 읽은 것을 «지웠다» 로 보면 제목이 파일 이름으로 바뀐다.
   */
  private changedPageTitle(record: SyncRecord, content: string, path: string): string | null {
    let current: Record<string, unknown>;
    try {
      current = parseFrontmatter(content).data;
    } catch {
      return null;
    }
    const written = explicitTitle(current);
    const base = snapshotFrontmatter(record.baseSnapshot);
    if (base === null) return written;
    if (written === explicitTitle(base)) return null;
    return written ?? wikilinkTitleFromPath(path);
  }

  /**
   * 새 행의 레코드 종류. DB 모드의 노트는 행이어도 페이지 레코드로 적는다 — DB 모드의 pull · 복원 ·
   * 렌더는 그 볼트의 노트를 모두 페이지 레코드로 다루고, 행인지는 전역 모드로 가른다(rowDatabaseOf).
   */
  private newRowFileType(path: string): FileType {
    if (!isDatabaseMode(this.config)) return "db-row";
    return isFolderNotePath(path) ? "folder-note" : "file";
  }

  /**
   * DB 행 갱신(S-01 · S-02).
   *
   * 행은 페이지가 아니다. 속성은 DB 스키마의 속성으로 보내고 본문에 YAML 로 끼우지 않는다.
   * 무엇을 보낼지는 비교 기준이 정한다 — 보내기 전에 행을 한 번 읽어 고른다.
   *
   * - 원격이 지난 동기화 뒤 그대로면 지난 동기화 사본(baseSnapshot)과 견줘 **바뀐 것만**
   *   보낸다. 통째로 보내면 로컬이 평문으로만 아는 서식(굵게 · 링크 · 멘션)이 매번 지워진다.
   *   본문도 바뀌었을 때만 보낸다 — 다시 쓰면 블록 ID 와 블록에 달린 댓글이 사라진다.
   * - 원격도 바뀌었으면 똑같이 로컬에서 바꾼 것만 보내되 notionLastEdited 를 올리지 않는다.
   *   올리면 다음 pull 이 원격 변경을 «이미 받은 것» 으로 여겨 영영 가져오지 않는다. 본문은
   *   통째로 바꾸므로 원격 본문이 그대로일 때만 보낸다 — 아니면 pull 을 먼저 하라며 거절한다.
   *   원격이 바뀌었는지는 같은 분 안의 편집까지 내용으로 가른다(N-05, {@link RemoteDriftChecker.remoteDrift}).
   * - 충돌 해소 결과를 보낼 때(`overwriteRemote`)는 원격의 지금 값과 견줘 다른 것을 모두
   *   보내고 본문도 보낸다 — 로컬이 이긴다(페이지가 본문을 통째로 바꾸는 것과 같다).
   */
  private async pushRowUpdate(
    path: string,
    record: SyncRecord,
    databaseId: string,
    content: string,
    options: { overwriteRemote: boolean },
  ): Promise<void> {
    const pageId = record.notionPageId!;
    // frontmatter 를 못 읽으면 멈춘다. 파이프라인은 읽지 못한 frontmatter 를 «속성 없음» 으로
    // 넘기므로, 그대로 견주면 모든 속성을 지우라는 요청이 된다.
    let current: ReturnType<typeof parseFrontmatter>;
    try {
      current = parseFrontmatter(content);
    } catch (error) {
      throw new Error(
        `frontmatter 를 읽지 못해 행을 보내지 않음 (${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const mapper = await this.rowSchemas.mapperFor(databaseId);
    const remote = await this.notionClient.getPage(pageId);
    const drift: RemoteDrift = options.overwriteRemote
      ? "none"
      : await this.drift.remoteDrift(record, remote);
    const against = options.overwriteRemote
      ? this.remoteRowState(mapper, remote)
      : this.baseRowState(record);

    const title = noteTitle(current.data, path);
    const { properties, skipped } = mapper.toNotionPropertyChanges(
      diffRowProperties(
        against?.properties ?? null,
        options.overwriteRemote ? mapper.pickWritable(current.data) : current.data,
      ),
      against?.title === title ? null : title,
    );
    if (skipped.length > 0) {
      getLogger().info(
        `[Im-Nobsidian] 행 속성 ${skipped.length}개는 보내지 않음(DB 에 없는 속성 · 읽기 전용 · ` +
          `비울 수 없는 속성 · 변환 불가): ${path} — ${skipped.join(", ")}`,
      );
    }

    const bodyChanged = against?.body == null || against.body !== current.body;
    // 수정 시각을 올려도 되는가 — 원격의 변경을 모두 로컬이 덮었거나 원격이 그대로일 때만.
    const settles = drift === "none";
    if (bodyChanged && !this.drift.overwritesRemote(record, options.overwriteRemote)) {
      refuseUnpulledBody(drift, path);
    }
    let conversionResult: ConversionResult | null = null;
    let bodyFingerprint: string | null | undefined;
    if (bodyChanged) {
      const selectedPath = this.pipeline.selectPath(content);
      if (selectedPath === "block-api") {
        getLogger().warn(
          `[Im-Nobsidian] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
        );
      }
      conversionResult = this.pipeline.convertToNotion(content, {
        direction: "push",
        path: selectedPath,
        filePath: path,
        parentMode: "database",
      });
      bodyFingerprint = await this.pushUpdatePage(
        pageId,
        conversionResult.content,
        record.baseSnapshot,
      );
      if (await this.syncEmbeddedMedia(pageId, conversionResult, path)) {
        bodyFingerprint = await this.drift.remoteBodyFingerprintOf(pageId);
      }
    }

    // notionLastEdited 는 서버가 돌려준 값으로 적는다(pushUpdate 와 같은 이유 — I5).
    // 보낸 것이 없으면(스키마에 없는 키만 바뀜) 원격은 그대로이므로 옛 값을 둔다.
    let written: RemotePageStamp | null = null;
    if (Object.keys(properties).length > 0) {
      written = await this.notionClient.updatePageProperties(pageId, properties);
    } else if (bodyChanged && settles) {
      written = await this.notionClient.getPage(pageId);
    }
    if (!settles) {
      getLogger().info(
        `[Im-Nobsidian] Notion 에서도 바뀐 행 — 로컬에서 바꾼 것만 보냈고 Notion 쪽 변경은 ` +
          `다음 pull 에서 받음: ${path}`,
      );
    }

    const hash = computeHash(content);
    const fileStat = await this.vaultFs.getFileStat(path);
    this.stateDb.transaction(() => {
      this.stateDb.updateHash(record.id, hash, Buffer.from(content, "utf-8"));
      this.stateDb.updateStatus(record.id, "synced");
      if (written !== null && settles) {
        this.observation.record(record.id, written, bodyFingerprint);
      } else if (bodyFingerprint !== undefined) {
        this.stateDb.setNotionBodyFingerprint(record.id, bodyFingerprint);
      }
      if (fileStat) {
        this.stateDb.updateStatCache(record.id, fileStat.mtime, fileStat.size);
      }
      if (conversionResult) {
        this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
      }
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: pageId,
        title,
        aliases: extractAliases(current.data),
      });
    });
  }

  /**
   * 지난 동기화 시점의 행. 사본이 없거나 읽지 못하면 null — 호출측은 비교할 기준이 없다고
   * 보고 비어 있지 않은 속성을 모두 보낸다(지우는 요청은 보내지 않는다).
   */
  private baseRowState(record: SyncRecord): RowState | null {
    if (!record.baseSnapshot) return null;
    try {
      const base = parseFrontmatter(record.baseSnapshot.toString("utf-8"));
      return {
        properties: base.data,
        title: noteTitle(base.data, record.obsidianPath),
        body: base.body,
      };
    } catch {
      return null;
    }
  }

  /** 원격의 지금 행 — 보낼 수 있는 속성만. 본문은 읽지 않는다(null: 늘 보낸다). */
  private remoteRowState(
    mapper: PropertyMapper,
    page: Awaited<ReturnType<NotionClient["getPage"]>>,
  ): RowState {
    const raw = (page as unknown as { properties?: Record<string, unknown> }).properties ?? {};
    return {
      properties: mapper.pickWritable(mapper.fromNotionProperties(raw)),
      title: this.notionClient.extractTitle(page),
      body: null,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 충돌 해소 (I8) — 해소 결과를 로컬에만 쓰지 않고 Notion 으로 재push + notionLastEdited
  // 재조정까지 한 트랜잭션으로 묶는다. ConflictResolver 단독은 로컬 write + updateHash 만
  // 수행하므로(merge 결과가 Notion 에 반영되지 않음) 다음 pull 이 원격으로 덮어써 영구
  // 유실·충돌 루프가 발생한다. 해소 → 전파(propagate)를 오케스트레이터에서 봉합해 무손실
  // 보장. 변환 파이프라인이 필요한 push 는 기존 엔터프라이즈 경로(pushUpdate)를 재사용한다.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * 해소 대상 충돌 목록 — 원격 본문을 pull 과 **같은 파이프라인**으로 렌더해 담는다.
   *
   * 해소는 실제로 볼트 파일을 덮어쓰므로 `status()` 의 경량 미리보기 렌더를 쓰면 안 된다
   * (프론트매터·첨부가 빠진 반쪽 본문이 덮인다). 반대로 전체 pull 을 먼저 돌려 목록을
   * 얻는 것도 안 된다 — 해소하겠다고 볼트를 먼저 원격으로 덮어쓰는 셈이라 순서가 거꾸로다.
   * 그래서 충돌 레코드만 좁혀 그 페이지들만 읽어 온다.
   */
  async listConflicts(): Promise<Conflict[]> {
    const records = this.stateDb.getByStatus("conflict");
    if (records.length === 0) return [];
    const files = await this.vaultFs.listMarkdownFiles();
    const localChanges = this.changeDetector.detectLocalChanges(
      files,
      this.planner.localScanOptions(),
    );
    return this.buildConflictsFromRecords(records, localChanges, [], { fullRender: true });
  }

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

  private async renderRemoteRecord(record: SyncRecord, pageId: string): Promise<string> {
    const page = await this.notionClient.getPage(pageId);
    const rendered = await this.renderRemotePage(record, pageId, page, { downloadMedia: false });
    return rendered.content;
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
   * 해소할 게 남지 않은 충돌 레코드를 `synced` 로 되돌리고, 되돌린 경로를 반환한다.
   *
   * 충돌로 표시된 파일은 push 대상에서 통째로 빠진다(양쪽 덮어쓰기 방지). 그래서 사용자가
   * 손으로 양쪽을 맞춰 둬 이미 같은 내용이 됐는데도 레코드만 남으면, 그 파일의 이후 편집이
   * **영원히 Notion 에 올라가지 않는다** — 아무 경고 없이 정체된다. 내용이 이미 동일한
   * 건만 골라 상태를 되돌린다(진짜 충돌은 손대지 않는다).
   */
  clearStaleConflicts(conflicts: readonly Conflict[]): string[] {
    return this.gate.runSync("resolve", () => this.executeClearStaleConflicts(conflicts));
  }

  private executeClearStaleConflicts(conflicts: readonly Conflict[]): string[] {
    const cleared: string[] = [];
    for (const conflict of conflicts) {
      // 양쪽 다 비었으면 "같다"가 아니라 양쪽 다 사라진 것이다 — 삭제 전파의 몫으로 남긴다.
      if (conflict.localContent === "" && conflict.remoteContent === "") continue;
      if (conflict.localContent !== conflict.remoteContent) continue;

      const record = conflict.syncRecord;
      this.stateDb.transaction(() => {
        this.stateDb.updateHash(
          record.id,
          computeHash(conflict.localContent),
          Buffer.from(conflict.localContent, "utf-8"),
        );
        this.stateDb.updateStatus(record.id, "synced");
        if (conflict.remoteChange.lastEdited) {
          this.observation.recordUnverified(record.id, conflict.remoteChange.lastEdited);
        }
      });
      cleared.push(record.obsidianPath);
    }
    return cleared;
  }

  /** 단일 충돌을 사용자가 고른 선택지(local/remote/merge/duplicate)로 해소 + Notion 전파. */
  async resolveConflict(conflict: Conflict, choice: ResolutionChoice): Promise<ResolutionResult> {
    return this.gate.run("resolve", () => this.executeResolveConflict(conflict, choice));
  }

  private async executeResolveConflict(
    conflict: Conflict,
    choice: ResolutionChoice,
  ): Promise<ResolutionResult> {
    const result = await this.conflictResolver.resolve(conflict, choice);
    await this.propagateOrReopen(conflict, choice, result);
    return result;
  }

  /** 단일 충돌을 전략(manual/local-first/remote-first/duplicate)으로 해소 + Notion 전파. */
  async resolveConflictByStrategy(
    conflict: Conflict,
    strategy: ConflictStrategy,
  ): Promise<ResolutionResult> {
    return this.resolveConflict(conflict, choiceForStrategy(conflict, strategy));
  }

  /** 여러 충돌을 동일 전략으로 일괄 해소 + Notion 전파. */
  async resolveAllConflicts(
    conflicts: Conflict[],
    strategy: ConflictStrategy,
  ): Promise<ResolutionResult[]> {
    return this.gate.run("resolve", async () => {
      const results: ResolutionResult[] = [];
      // 하나를 올리지 못해도 나머지를 푼다 — 올리지 못한 것은 충돌로 되돌려져 있다(N-06).
      // 예전에는 첫 실패에서 던져, 뒤의 충돌은 손대지 않은 채 무엇이 풀렸는지도 알리지 못했다.
      for (const conflict of conflicts) {
        const choice = choiceForStrategy(conflict, strategy);
        try {
          results.push(await this.executeResolveConflict(conflict, choice));
        } catch (error) {
          results.push({
            path: conflict.syncRecord.obsidianPath,
            choice,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    });
  }

  /**
   * 로컬 변경 하나를 지난 동기화 때의 글로 되돌린다 — Git 의 `restore` 와 같다. 고친 노트 · 지운 노트는
   * 지난 동기화 사본(`baseSnapshot`)으로 다시 쓴다. Notion 은 건드리지 않는다.
   *
   * 되돌릴 원본이 없는 것은 이유와 함께 거절한다 — 추적하지 않는 새 노트(지우는 것은 사용자가 휴지통으로),
   * 옮긴 노트의 새 자리(파일을 옛 자리로 옮기면 된다), 사본이 없는 노트, 충돌 중인 노트(충돌 해결로 고른다).
   */
  async discardLocalChange(path: string): Promise<void> {
    return this.gate.run("discard", async () => {
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
    });
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

  /** 충돌 미리보기용 줄 비교(로컬 vs 원격). 해소 없이 표시 전용. */
  generateConflictDiff(conflict: Conflict): string {
    return this.conflictResolver.generateDiff(conflict);
  }

  /**
   * 해소 결과를 Notion 에 올린다. 올리지 못하면 충돌로 되돌리고 오류를 그대로 던진다(N-06).
   *
   * 해소는 지난 동기화 사본을 해소 결과로 바꿔 둔다. 그 결과가 Notion 에 없는데 «해결됨» 으로
   * 남으면, 다음 pull 은 로컬을 바뀌지 않은 것으로 보고 바뀐 원격으로 덮는다 — 고른 로컬 · 병합
   * 결과가 사라진다. 해소 전의 사본으로 되돌리면 다음 pull 이 다시 충돌로 본다. 볼트 파일(병합
   * 결과 · `.conflict` 사본)은 그대로 둔다 — 사용자가 고른 것이다.
   */
  private async propagateOrReopen(
    conflict: Conflict,
    choice: ResolutionChoice,
    result: ResolutionResult,
  ): Promise<void> {
    try {
      await this.propagateResolution(conflict, choice, result);
    } catch (error) {
      // 원격에서 지운 노트를 «로컬 유지» 로 풀면 추적을 놓은 뒤 새 페이지를 만든다 — 만들지 못해도
      // 파일은 추적하지 않는 새 노트로 남아 다음 push 가 만든다. 되돌릴 충돌이 없다.
      if (isRemoteDeletion(conflict)) {
        throw new Error(
          `Notion 에 다시 만들지 못함 — 파일은 그대로이고 다음 push 가 다시 만든다 (${
            conflict.syncRecord.obsidianPath
          }): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const record = conflict.syncRecord;
      this.stateDb.transaction(() => {
        this.stateDb.updateHash(record.id, record.contentHash, record.baseSnapshot);
        this.stateDb.updateStatus(record.id, "conflict");
      });
      throw error;
    }
  }

  /**
   * 해소 결과를 Notion 으로 전파해 로컬↔원격 일관성을 봉합한다.
   * - remote 선택: 로컬이 원격으로 갱신됐을 뿐이므로 push 불필요. notionLastEdited 만
   *   원격 변경의 lastEdited 로 재조정 → 다음 pull 이 같은 변경을 재충돌로 보지 않음.
   * - merge 실패(충돌 마커 잔존): 사용자가 직접 풀어야 하므로 conflict 상태 유지·push 안 함.
   * - local / merge(성공) / duplicate: 해소된 로컬 내용을 Notion 에 재push(pushUpdate 가
   *   변환·이미지·속성·해시·notionLastEdited 를 한 트랜잭션으로 재조정) → 무손실 수렴.
   * - 원격에서 지운 노트: local 은 새 페이지로 만들고(pushCreate), remote 는 볼트에서 지운 것으로
   *   끝난다.
   */
  private async propagateResolution(
    conflict: Conflict,
    choice: ResolutionChoice,
    result: ResolutionResult,
  ): Promise<void> {
    const record = conflict.syncRecord;
    if (!record.notionPageId) return;

    // 원격에서 지운 노트 — «원격 유지» 는 볼트에서 지운 것으로 끝났다. «로컬 유지» 는 추적을 놓은
    // 파일을 새 페이지로 만든다(지운 페이지는 휴지통에 그대로 둔다).
    if (isRemoteDeletion(conflict)) {
      if (choice === "local") await this.pushCreate(record.obsidianPath);
      return;
    }

    if (choice === "remote") {
      this.observation.recordUnverified(record.id, conflict.remoteChange.lastEdited);
      return;
    }

    // merge 가 충돌 마커를 남긴 경우(자동 병합 실패) → push 하지 않고 conflict 상태 유지.
    if (!result.success) return;

    // local / merge(성공) / duplicate: 해소된 로컬 본문을 Notion 으로 재push. 해소가 지난
    // 동기화 사본을 해소 결과로 바꿔 두었으므로 «사본과 달라진 것» 은 없다 — 원격에 맞춰
    // 보내도록 알린다(DB 행).
    await this.pushUpdate(record.obsidianPath, { overwriteRemote: true });
  }

  // 반환값: 실제로 원격(Notion) 삭제가 전파되었는지 여부.
  // deleteSync=false 면 로컬 삭제를 pending 으로만 기록하고 Notion 은 보존하므로
  // false 를 돌려준다 → 호출부가 deleted 카운트를 올리지 않아 보고가 정직해진다.
  //
  // 지우기 전에 원격을 본다(F-f) — pull 하지 않은 Notion 편집이 있으면 지우지 않는다. 휴지통으로
  // 보내면 그 편집은 볼트에도 Notion 에도 보이지 않는다. 이어지는 pull 이 파일을 되살려 받는다
  // (로컬 파일이 없으면 원격을 쓴다). 원격이 이미 사라졌으면 추적만 놓는다.
  private async pushDelete(path: string): Promise<boolean> {
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return false;

    if (!this.config.sync.deleteSync) {
      this.stateDb.updateStatus(record.id, "pending");
      return false;
    }

    const presence = await remotePresence(this.notionClient, record.notionPageId);
    if (presence.kind === "alive") {
      if (!this.drift.overwritesRemote(record, false)) {
        refuseUnpulledDeletion(await this.drift.remoteDrift(record, presence.page), path);
      }
      try {
        await this.notionClient.archivePage(record.notionPageId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("archived ancestor")) {
          // 부모 페이지가 이미 아카이브됨 → 자식도 자동 아카이브 상태
        } else {
          throw error;
        }
      }
    }
    this.stateDb.transaction(() => {
      this.stateDb.delete(record.id);
      this.stateDb.deleteWikilink(record.obsidianPath);
    });
    return true;
  }

  /**
   * 옮기거나 이름을 바꾼 노트를 Notion 에 반영한다(S-11) — 부모 페이지와 제목을 바꾸고, 내용도
   * 바뀌었으면 이어서 갱신한다. 예전에는 부모를 바꾸는 요청을 Notion 이 무시했고(pages.update 의
   * parent), 실패는 로그만 남겼다. 제목은 바꾸지 않았다.
   *
   * 무엇을 바꿀지는 이동 WAL 의 옛 경로 — 마지막으로 Notion 에 반영한 자리 — 와 견줘 정한다.
   * 반영을 마치면 WAL 을 지운다. 도중에 끊기면 다음 push 가 같은 옛 경로로 다시 한다 — 옮기기와
   * 제목 바꾸기는 다시 해도 결과가 같다. 행은 DB 안에서만 옮긴다(refusedMoves) — 제목만 바뀐다.
   */
  private async pushMove(change: LocalChange): Promise<void> {
    const path = change.path;
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) throw new Error(`옮긴 노트의 추적 기록이 없음: ${path}`);
    const op = this.stateDb.getIncompleteOpByState(record.id, "move");
    const from = (op ? moveOrigin(op.payload) : null) ?? change.movedFrom ?? path;

    const rowDatabaseId = rowDatabaseOf(this.config, record);
    const base = snapshotFrontmatter(record.baseSnapshot);
    let current: Record<string, unknown>;
    try {
      current = parseFrontmatter(await this.vaultFs.readFile(path)).data;
    } catch (error) {
      // 행은 멈춘다 — 이어지는 갱신이 모든 속성을 지우라는 요청이 된다(pushRowUpdate). 페이지는
      // 제목을 고치지 않은 것으로 본다.
      if (rowDatabaseId) {
        throw new Error(
          `frontmatter 를 읽지 못해 행을 옮기지 않음 (${path}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      current = base ?? {};
    }

    await this.relocatePage(record, {
      parentId: rowDatabaseId ? null : this.placement.moveParentOf(path),
      title: titleMayChange(base, current, from, path)
        ? (remoteTitle) => titleAfterMove(base, current, from, path, remoteTitle)
        : null,
      opId: op?.id ?? null,
    });

    if (record.contentHash !== change.currentHash) await this.pushUpdate(path);
  }

  /**
   * 옮기거나 이름을 바꾼 폴더의 페이지(push 가 만든 폴더 페이지)를 Notion 에 반영한다 — 얕은
   * 것부터. 새 부모 폴더에 페이지가 없으면 먼저 만든다. 실패는 폴더마다 이유와 함께 남긴다.
   *
   * @returns 반영한 폴더 수.
   */
  private async pushFolderMoves(
    moves: readonly PendingFolderMove[],
    failed: FailedOperation[],
    onMove?: (to: string) => void,
  ): Promise<number> {
    let moved = 0;
    for (const { record, from, to } of moves) {
      onMove?.(to);
      try {
        const parentFolder = parentFolderOf(to);
        let parentId = this.config.notion.rootPageId;
        if (parentFolder) {
          await this.placement.ensureFolderPage(parentFolder);
          const lookup = this.placement.folderLookup();
          const container = folderContainer(parentFolder, lookup);
          if (container?.kind !== "page") {
            throw new Error(
              this.placement.folderMoveRefusal(to, lookup) ??
                `폴더(${parentFolder})의 Notion 페이지가 없어 옮기지 않음 — 다음 push 가 폴더부터 만든다`,
            );
          }
          parentId = container.pageId;
        }
        await this.relocatePage(record, {
          parentId,
          // 폴더 페이지는 폴더 이름으로 만든다 — 이름이 바뀌면 옛 이름을 따르던 제목만 바꾼다.
          title:
            wikilinkTitleFromPath(from) === wikilinkTitleFromPath(to)
              ? null
              : (remoteTitle) => titleAfterMove(null, {}, from, to, remoteTitle),
          opId: this.stateDb.getIncompleteOpByState(record.id, "move")?.id ?? null,
        });
        moved++;
      } catch (error) {
        failed.push({
          path: to,
          operation: "move",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return moved;
  }

  /**
   * 페이지를 새 부모로 옮기고 제목을 바꾼 뒤 이동 WAL 을 지운다. 바꿀 것이 없으면 요청하지 않는다.
   *
   * @param change.parentId 새 부모 페이지. null 이면 부모는 그대로(행).
   * @param change.title Notion 의 지금 제목을 받아 새 제목을 돌려준다(그대로면 null). 제목이 바뀔
   *   수 없으면 null — 그러면 페이지를 읽지 않는다.
   */
  private async relocatePage(
    record: SyncRecord,
    change: {
      readonly parentId: string | null;
      readonly title: ((remoteTitle: string) => string | null) | null;
      readonly opId: string | null;
    },
  ): Promise<void> {
    const pageId = record.notionPageId!;
    const newParent =
      change.parentId !== null &&
      !(record.notionParentId !== null && notionIdsEqual(change.parentId, record.notionParentId))
        ? change.parentId
        : null;

    let written: RemotePageStamp | null = null;
    let remoteChanged = false;
    if (newParent !== null || change.title) {
      const remote = await this.notionClient.getPage(pageId);
      // 같은 분 안의 편집도 «바뀜» 으로 본다(N-05) — 옮기기와 제목은 그래도 반영한다.
      remoteChanged = this.observation.verdict(record, remote) !== "unchanged";
      const title = change.title ? change.title(this.notionClient.extractTitle(remote)) : null;
      if (newParent !== null) await this.notionClient.movePage(pageId, newParent);
      if (title !== null) {
        written = await this.notionClient.updatePageProperties(pageId, titleProperty(title));
      } else if (newParent !== null) {
        written = await this.notionClient.getPage(pageId);
      }
    }

    this.stateDb.transaction(() => {
      if (newParent !== null) this.stateDb.setNotionParentId(record.id, newParent);
      // Notion 에서도 바뀐 페이지는 기준 시각을 올리지 않는다 — 올리면 다음 pull 이 그 변경을
      // «이미 받은 것» 으로 여긴다. 옮기기와 제목은 본문을 바꾸지 않는다 — 지문은 그대로 둔다.
      if (written !== null && !remoteChanged) this.observation.record(record.id, written);
      if (change.opId !== null) this.stateDb.markPendingCompleted(change.opId);
    });
  }

  private async pullCreate(pageId: string): Promise<string> {
    const page = await this.notionClient.getPage(pageId);
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const parentPath = await this.resolveParentPath(page);

    const hasChildPages = await this.pageHasChildContainers(pageId);

    const {
      content: markdown,
      compact: exportCompact,
      fingerprint,
    } = await this.fetchPageMarkdown(pageId);
    const hasContent = markdown.trim().length > 0;

    let filePath: string;
    let fileType: "file" | "folder-note" | "folder-only";

    if (hasChildPages && hasContent) {
      const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
      filePath = await this.resolveUniqueFilePath(folderPath, safeName, pageId);
      fileType = "folder-note";
      await this.vaultFs.ensureFolder(folderPath);
    } else if (hasChildPages && !hasContent) {
      const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
      filePath = await this.resolveUniqueFilePath(folderPath, safeName, pageId);
      fileType = "folder-only";
      await this.vaultFs.ensureFolder(folderPath);
    } else {
      filePath = await this.resolveUniqueFilePath(parentPath, safeName, pageId);
      fileType = "file";
    }

    let properties: Record<string, unknown>;
    if (isDatabaseMode(this.config)) {
      await this.ensureDbSchema();
      properties = this.propertyMapper.fromNotionProperties(
        (page as unknown as { properties: Record<string, unknown> }).properties,
      );
    } else {
      properties = this.notionClient.extractProperties(page);
    }
    // D2(page 모드): 파일명 stem 으로 복원 가능한 제목은 프론트매터에 주입하지 않는다 —
    // 원본에 없던 `title:` 키가 pull 마다 생기는 가짜 diff 의 원인. sanitize·`(1)` 접미사로
    // 파일명이 제목과 달라진 경우만 보존한다(DB 모드 title 은 Name 컬럼 데이터라 항상 유지).
    if (isDatabaseMode(this.config) || extractTitle(filePath) !== title) {
      properties.title = title;
    }

    let processedMarkdown = await this.imageHandler.restoreUploadedMedia(
      markdown,
      pageId,
      filePath,
    );
    if (this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(
        processedMarkdown,
        title,
        pageId,
      );
      processedMarkdown = imageResult.content;
      this._pullImageCount += imageResult.downloads.length;
    }

    const fileResult = await this.imageHandler.downloadAllFiles(processedMarkdown, title);
    processedMarkdown = fileResult.content;
    this._pullFileCount += fileResult.downloads.length;

    const finalContent = this.pipeline.convertToMarkdown(
      processedMarkdown,
      {
        direction: "pull",
        path: "markdown-api",
        filePath,
        parentMode: this.config.notion.parentMode,
      },
      { properties, notionExportCompact: exportCompact },
    );

    // 부모 해소는 파일 기록 전에 끝낸다. parent 가 block 일 때 resolveBlockToPageId 가
    // API 를 호출(429 가능)하는데, 이를 writeFile 뒤에 두면 기록만 되고 sync_state 등록 전에
    // throw → 재시도 시 같은 페이지가 `(1)` 로 재생성되며 첫 파일이 고아가 된다. 기록↔등록
    // 사이에는 throw 가능한 원격 호출을 두지 않는다(원자적 등록 보장).
    const resolvedParentId = await extractParentId(this.notionClient, page);

    await this.vaultFs.writeFile(filePath, finalContent);

    const hash = computeHash(finalContent);
    const pullStat = await this.vaultFs.getFileStat(filePath);
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: filePath,
        notionPageId: pageId,
        notionParentId: resolvedParentId,
        contentHash: hash,
        ...this.observation.fieldsOf(page, fingerprint),
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType,
        status: "synced",
        baseSnapshot: Buffer.from(finalContent, "utf-8"),
        localMtime: pullStat?.mtime ?? null,
        localFileSize: pullStat?.size ?? null,
      });

      const aliases = extractAliases(properties);
      this.stateDb.upsertWikilink({
        obsidianPath: filePath,
        notionPageId: pageId,
        title,
        aliases,
      });
    });

    return filePath;
  }

  /**
   * 페이지가 폴더(자식 페이지·자식 DB 보유)인지 신뢰성 있게 판정한다.
   *
   * 결함(폴더노트 본문분리)의 근본 원인은 얕은 판정이었다 — 최상위 블록 첫 페이지에서
   * child_page 만 검사하면 callout·column·toggle 안에 중첩된 자식 페이지나 child_database 를
   * 놓쳐 폴더노트가 file 로 오분류되고, 본문이 폴더 밖 최상위로 밀려 resolveUniqueFilePath
   * 충돌(' (1).md')로 쪼개졌다.
   *
   * 1차: 발견 단계(서브트리 순회/증분)에서 전 페이지의 부모를 해소하며 만든
   *      집합({@link RemoteDetector.hasChildPages})으로 O(1) 판정(추가 API 호출 0, 처리 순서 무관) — 전체 pull 경로.
   * 폴백: 집합에 없을 때만(증분 pull 의 신규 폴더 등) fetchAllChildrenDeep 로 컨테이너를
   *       재귀 탐색해 child_page·child_database 를 직접 확인한다.
   */
  private async pageHasChildContainers(pageId: string): Promise<boolean> {
    if (this.detector.hasChildPages(pageId)) return true;
    try {
      const deep = await this.notionClient.fetchAllChildrenDeep(pageId);
      return deep.some((b) => b.type === "child_page" || b.type === "child_database");
    } catch {
      return false;
    }
  }

  /**
   * 이 제목을 파일 이름으로 되살릴 수 있는가 — 그러면 frontmatter 에 `title` 을 적지 않는다(D2).
   *
   * 옮기고 아직 Notion 에 반영하지 않은 노트는 Notion 제목이 옛 파일 이름을 따른다. 그 제목을
   * 새 파일의 `title` 로 적으면 push 가 그것을 «사용자가 정한 제목» 으로 보고, 이름 변경을
   * 제목에 반영하지 않는다(S-11).
   */
  private titleFollowsName(record: SyncRecord, title: string): boolean {
    if (extractTitle(record.obsidianPath) === title) return true;
    const op = this.stateDb.getIncompleteOpByState(record.id, "move");
    const origin = moveOrigin(op?.payload ?? null);
    return origin !== null && followsFileName(title, origin);
  }

  /**
   * 원격 페이지를 **pull 과 동일한 파이프라인**으로 볼트에 쓸 수 있는 본문까지 렌더한다.
   * (본문 변환 → 이미지/첨부 내려받기 → 속성 주입 → preserve marker → 압축형 간격 판정)
   *
   * pull 경로와 충돌 해소 경로가 이 한 곳을 공유해야 한다. 예전엔 충돌 목록만
   * {@link fetchPageMarkdown} 원문을 그대로 담아, `nobsi resolve` 에서 "원격 유지"를 고르면
   * 프론트매터도 첨부도 없는 반쪽 본문이 볼트에 덮여 썼다 — 해소가 곧 손실이었다.
   *
   * @returns 렌더된 본문과 함께, 호출자가 위키링크 레지스트리 등에 쓰는 제목·속성.
   *          여기서 이미 읽은 값을 되돌려 줘야 호출자가 같은 페이지를 다시 파싱하지 않는다.
   */
  private async renderRemotePage(
    record: SyncRecord,
    pageId: string,
    page: Awaited<ReturnType<NotionClient["getPage"]>>,
    options?: { downloadMedia?: boolean },
  ): Promise<{
    content: string;
    title: string;
    properties: Record<string, unknown>;
    /** 받은 원격 본문의 지문 — 모르면 null. */
    bodyFingerprint: string | null;
  }> {
    // 표시 전용 호출(diff)은 첨부를 내려받지 않는다 — 비교를 보려다 볼트에 파일이 생기면
    // 안 된다. 이때 새 미디어는 원격 URL 그대로 남지만, 비교 화면에서만 보이는 차이다.
    const downloadMedia = options?.downloadMedia !== false;
    if (record.fileType === "db-row") {
      // 행은 pull 과 같은 렌더러로 — 페이지처럼 렌더하면 본문 첫머리의 옛 속성 블록이
      // 실제 속성 값을 덮는다(S-02). 충돌 «원격 선택» 은 이 렌더를 파일에 그대로 쓴다.
      return this.databaseSyncer.renderRow(page, record.obsidianPath, { downloadMedia });
    }
    const fetched = await this.fetchPageMarkdown(pageId);
    let markdown = fetched.content;

    const title = this.notionClient.extractTitle(page);

    let properties: Record<string, unknown>;
    if (isDatabaseMode(this.config)) {
      await this.ensureDbSchema();
      properties = this.propertyMapper.fromNotionProperties(
        (page as unknown as { properties: Record<string, unknown> }).properties,
      );
    } else {
      properties = this.notionClient.extractProperties(page);
    }
    // D2: pullCreate 와 동일 — 파일명으로 복원 가능한 제목은 주입하지 않는다.
    if (isDatabaseMode(this.config) || !this.titleFollowsName(record, title)) {
      properties.title = title;
    }

    // 이 노트가 올린 미디어는 내려받지 않고 원래 임베드로 되돌린다 — 표시 전용 렌더도 같다.
    markdown = await this.imageHandler.restoreUploadedMedia(markdown, pageId, record.obsidianPath);

    if (downloadMedia && this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title, pageId);
      markdown = imageResult.content;
      this._pullImageCount += imageResult.downloads.length;
    }

    if (downloadMedia) {
      const fileResult = await this.imageHandler.downloadAllFiles(markdown, title);
      markdown = fileResult.content;
      this._pullFileCount += fileResult.downloads.length;
    }

    const savedMarkers = this.stateDb.getPreserveMarkers(record.obsidianPath);
    const content = this.pipeline.convertToMarkdown(
      markdown,
      {
        direction: "pull",
        path: "markdown-api",
        filePath: record.obsidianPath,
        parentMode: this.config.notion.parentMode,
      },
      {
        properties,
        preserveMarkers: savedMarkers.length > 0 ? savedMarkers : undefined,
        notionExportCompact: fetched.compact,
        localContent: await readLocalNote(this.vaultFs, record.obsidianPath),
      },
    );
    return { content, title, properties, bodyFingerprint: fetched.fingerprint };
  }

  private async pullUpdate(change: RemoteChange): Promise<PullOutcome> {
    let record = this.stateDb.getByNotionId(change.pageId);
    if (!record) return { action: "unchanged" };

    const page = await this.notionClient.getPage(change.pageId);

    // push 가 만든 폴더 페이지에는 볼트 파일이 없다 — 폴더로 받는다(S-17).
    if (isFolderRecord(record)) {
      const folderNote = await this.pullFolderRecord(record, page);
      if (!folderNote) return { action: "unchanged", path: record.obsidianPath };
      record = folderNote;
    }

    // 리모트가 휴지통/보관 상태인데 로컬 파일도 없다면 양쪽 다 없는 것이다 — 복원 스캔이
    // 올린 항목이라도 되살릴 원본이 없으므로 빈 껍데기를 만들지 않고 무동작으로 끝낸다.
    // (deleteSync 가 켜져 있으면 전체 스캔이 이 페이지를 deleted 로 따로 처리한다.)
    const remoteGone =
      (page as { in_trash?: boolean }).in_trash === true ||
      (page as { archived?: boolean }).archived === true;
    if (remoteGone && !(await this.vaultFs.exists(record.obsidianPath))) {
      return { action: "unchanged", path: record.obsidianPath };
    }

    const rendered = await this.renderRemotePage(record, change.pageId, page);
    const remoteContent = rendered.content;

    let localContent: string;
    // 읽기 실패를 곧바로 "파일 없음"으로 단정하지 않는다 — 권한 오류로 못 읽은 파일까지
    // 복원 대상으로 삼으면 멀쩡한 로컬 편집을 덮어쓴다. 실패 경로에서만 존재 여부를
    // 한 번 더 물어 '없음'과 '못 읽음'을 가른다.
    let localExists = true;
    try {
      localContent = await this.vaultFs.readFile(record.obsidianPath);
    } catch {
      localContent = "";
      localExists = await this.vaultFs.exists(record.obsidianPath);
    }

    // 받은 원격이 지난 사본 그대로인지 내용으로 가른다 — push 와 같은 규칙(N-05). 렌더한 글이
    // 달라도 받을 것이 없으면, 그 사이 로컬 편집을 충돌로 올리지 않는다. 사라진 파일은 되살린다.
    const remoteUnchanged =
      localExists && (await this.drift.unchangedSinceSync(record, page, rendered.bodyFingerprint));

    const resolution = resolvePullConflict({
      record,
      localContent,
      localExists,
      remoteContent,
      remoteUnchanged,
      remoteChange: change,
      strategy: this.config.sync.conflictStrategy,
    });

    if (resolution.action === "skip") {
      // 원격이 지난 사본 그대로다 — 본 것만 적는다. 로컬 편집은 이어지는 push 가 올린다.
      if (resolution.remoteUnchanged) {
        this.observation.record(record.id, page, rendered.bodyFingerprint);
        return { action: "unchanged", path: record.obsidianPath };
      }
      // local-first: 로컬을 지키고 원격 변경은 받지 않는다. 본 것도 적지 않는다 — 로컬을 올려
      // 원격을 맞출 때까지 다음 pull 이 다시 본다.
      return { action: "skipped", path: record.obsidianPath };
    }
    if (resolution.action === "conflict") {
      this.stateDb.updateStatus(record.id, "conflict");
      return { action: "conflict", path: record.obsidianPath, conflict: resolution.conflict! };
    }

    // I5 false-churn 차단: 리모트 변환 결과가 디스크 내용과 바이트 동일하면 Notion 이
    // last_edited 만 갱신한 '가짜 수정'이다. 파일을 재기록하면 mtime 이 바뀌어 다음 push 가
    // 로컬 수정으로 오인 → push↔pull 무한 churn. 파일은 건드리지 않고 추적 메타
    // (notionLastEdited)만 현재 원격값으로 정렬해 재감지를 멈춘다. content_hash 비교로
    // 진짜 변경과 가짜 변경을 구분하는 핵심 멱등 지점이다.
    // localExists 를 반드시 함께 본다: 파일이 사라졌고 원격도 빈 페이지면 둘 다 "" 라
    // 동일 판정이 나면서 파일을 되쓰지 않고 synced 로 마감돼 삭제가 굳는다.
    // 파일 끝 개행만 다르면 로컬을 그대로 두고 로컬을 사본으로 적는다(sameNoteContent).
    if (localExists && sameNoteContent(remoteContent, localContent)) {
      const stat = await this.vaultFs.getFileStat(record.obsidianPath);
      this.stateDb.upsert({
        obsidianPath: record.obsidianPath,
        notionPageId: change.pageId,
        notionParentId: record.notionParentId,
        contentHash: computeHash(localContent),
        ...this.observation.fieldsOf(page, rendered.bodyFingerprint),
        localLastModified: record.localLastModified,
        syncDirection: record.syncDirection,
        fileType: record.fileType,
        status: "synced",
        baseSnapshot: Buffer.from(localContent, "utf-8"),
        localMtime: stat?.mtime ?? record.localMtime ?? null,
        localFileSize: stat?.size ?? record.localFileSize ?? null,
      });
      return { action: "unchanged", path: record.obsidianPath };
    }

    await this.vaultFs.writeFile(record.obsidianPath, remoteContent);

    const updateStat = await this.vaultFs.getFileStat(record.obsidianPath);
    const newHash = computeHash(remoteContent);
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: record.obsidianPath,
        notionPageId: change.pageId,
        notionParentId: record.notionParentId,
        contentHash: newHash,
        ...this.observation.fieldsOf(page, rendered.bodyFingerprint),
        localLastModified: new Date().toISOString(),
        syncDirection: record.syncDirection,
        fileType: record.fileType,
        status: "synced",
        baseSnapshot: Buffer.from(remoteContent, "utf-8"),
        localMtime: updateStat?.mtime ?? null,
        localFileSize: updateStat?.size ?? null,
      });

      const aliases = extractAliases(rendered.properties);
      this.stateDb.upsertWikilink({
        obsidianPath: record.obsidianPath,
        notionPageId: change.pageId,
        title: rendered.title,
        aliases,
      });
    });

    return { action: "written", path: record.obsidianPath };
  }

  /**
   * push 가 만든 폴더 페이지(폴더 레코드)의 원격 변경을 받는다(S-17). 폴더 레코드에는 볼트 파일이
   * 없다 — 예전에는 폴더 경로를 파일로 읽어 «빈 로컬 파일» 과 원격 본문의 충돌로 남겼다.
   *
   * - 자식 말고 본문이 없으면 받을 것이 없다. 그 아래에 페이지가 생겨도 Notion 이 수정 시각을
   *   올린다 — 시각만 맞춰 다음 pull 이 다시 읽지 않게 한다.
   * - 본문이 생겼으면 그 페이지는 이제 폴더 노트다(ADR-012) — 레코드를 폴더 노트 경로로 옮겨 적고
   *   돌려준다. 호출자가 보통 노트처럼 받는다: 로컬 폴더 노트가 없으면 쓰고, 올리지 않은 로컬
   *   폴더 노트가 있으면 그 노트와의 충돌이 된다.
   * - 폴더 노트를 둘 자리가 없으면 본문은 Notion 에만 둔다 — 시각만 맞추고 알린다. DB 모드는
   *   노트가 행이고, v0.3 이 DB 폴더 자리에 만든 폴더 페이지는 그 폴더가 DB 라 행만 든다.
   *
   * @returns 폴더 노트로 옮겨 적은 레코드. 받을 것이 없으면 null.
   * @throws 받을 자리가 없을 때 — 이유와 함께 실패로 남고, 다음 pull 이 다시 본다(기준 시각이
   *         이 변경 앞에 묶인다).
   */
  private async pullFolderRecord(
    record: SyncRecord,
    page: PageObjectResponse,
  ): Promise<SyncRecord | null> {
    const folder = record.obsidianPath;
    const remoteGone =
      (page as { in_trash?: boolean }).in_trash === true ||
      (page as { archived?: boolean }).archived === true;
    if (remoteGone) return null;

    const { markdown } = await this.notionClient.getPageMarkdown(page.id);
    if (!hasBodyBesidesChildren(markdown)) {
      this.observation.record(record.id, page, remoteBodyFingerprint(markdown));
      return null;
    }
    const noPlace = isDatabaseMode(this.config)
      ? "DB 모드는 폴더 노트를 받지 않음"
      : this.placement.folderLookup().databaseAt(folder)
        ? "그 폴더는 DB 라 폴더 노트를 둘 수 없음"
        : null;
    if (noPlace) {
      getLogger().warn(
        `[Im-Nobsidian] 폴더(${folder})의 Notion 페이지에 본문이 있지만 ${noPlace} — Notion 에만 있다`,
      );
      this.observation.record(record.id, page, remoteBodyFingerprint(markdown));
      return null;
    }

    if (this.stateDb.getIncompleteOpByState(record.id, "move")) {
      throw new Error(
        `폴더(${folder})의 이동을 Notion 에 반영하기 전이라 폴더 페이지의 본문을 받지 않음 — ` +
          `push 뒤 pull 이 받는다`,
      );
    }
    const notePath = folderNoteOf(folder);
    if (this.stateDb.getByPath(notePath)) {
      // 두 겹으로 생긴 폴더(S-15 이전 push) — 폴더 노트가 다른 페이지다.
      throw new Error(
        `폴더(${folder})의 Notion 페이지에 본문이 생겼지만 폴더 노트(${notePath})가 다른 ` +
          `페이지라 받지 않음 — 두 페이지 중 하나를 정리해야 한다`,
      );
    }

    this.stateDb.transaction(() => {
      this.stateDb.updatePath(record.id, notePath);
      this.stateDb.deleteWikilink(folder);
    });
    getLogger().info(
      `[Im-Nobsidian] 폴더 페이지에 Notion 에서 쓴 본문을 폴더 노트로 받음: ${folder} → ${notePath}`,
    );
    return this.stateDb.getByPath(notePath);
  }

  /**
   * pull 할 것을 세기만 한다(dry-run) — 볼트 · 상태 DB · Notion 을 바꾸지 않는다. 페이지와 DB 행을
   * 같이 센다. DB 는 설정한 DB 와 이미 발견해 둔 DB 가운데 실제 pull 이 조회할 것(`ledger`)만 센다 —
   * 이번 pull 이 새로 발견할 DB 는 받아 봐야 안다. 세지 못한 DB 는 이유와 함께 `failed` 에 싣는다
   * (세지 못한 것을 없다고 하지 않는다).
   */
  private async planPull(
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

  /** 원격에서 지운 페이지를 실제 pull 이 볼트에서 지우는가 — {@link pullDelete} 와 같게 가른다. */
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
   * ({@link DatabaseDiscovery.pullDiscoveredDatabases})를 같은 규칙으로 고른다. 세지 못한 DB 는 이유와 함께 `failed`
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

  /**
   * Notion 에서 사라진 페이지를 볼트에 반영한다. 올리지 않은 로컬 편집이 있으면 전략을 따른다
   * ({@link applyRemoteDeletion}) — 지우지 않고 충돌로 남기거나(manual · duplicate) 파일을 둔다
   * (local-first).
   *
   * @returns `path` 는 진행 표시용 — 추적하지 않던 페이지면 없다.
   */
  private async pullDelete(
    change: RemoteChange,
  ): Promise<(RemoteDeletionOutcome | { readonly action: "untracked" }) & { path?: string }> {
    const record = this.stateDb.getByNotionId(change.pageId);
    if (!record) return { action: "untracked" };

    // push 가 만든 폴더 페이지는 추적만 놓는다 — 볼트에서는 폴더다. 안의 노트는 각자의 레코드가
    // 지운다. 예전에는 폴더 경로를 파일처럼 지워, Obsidian 에서는 올리지 않은 노트까지 폴더째
    // 휴지통으로 갔다(S-17).
    if (isFolderRecord(record)) {
      this.stateDb.transaction(() => {
        this.stateDb.delete(record.id);
        this.stateDb.deleteWikilink(record.obsidianPath);
      });
      return { action: "untracked", path: record.obsidianPath };
    }

    const outcome = await applyRemoteDeletion(this.stateDb, this.vaultFs, record, {
      deleteFile: this.config.sync.deleteSync,
      strategy: this.config.sync.conflictStrategy,
      remoteChange: change,
    });
    return { ...outcome, path: record.obsidianPath };
  }

  private async resolveParentPath(page: PageObjectResponse): Promise<string> {
    const parentId = await extractParentId(this.notionClient, page);
    if (!parentId || notionIdsEqual(parentId, this.config.notion.rootPageId)) return "";

    const parentRecord = this.stateDb.getByNotionId(parentId);
    if (parentRecord) {
      // push 가 만든 폴더 페이지는 폴더 경로 자체로 추적한다 — 그 폴더가 자식의 자리다. 예전에는
      // 폴더 노트 파일처럼 마지막 조각을 떼어 한 층 위에 받았다(S-16). v0.3 이 DB 폴더 자리에 만든
      // 폴더 페이지는 빼고 예전 자리에 둔다 — DB 폴더에는 행만 든다.
      if (
        isFolderRecord(parentRecord) &&
        !this.placement.folderLookup().databaseAt(parentRecord.obsidianPath)
      ) {
        return parentRecord.obsidianPath;
      }
      if (parentRecord.fileType === "folder-note" || parentRecord.fileType === "folder-only") {
        const pathParts = parentRecord.obsidianPath.split("/");
        pathParts.pop();
        return pathParts.join("/");
      }
      const pathParts = parentRecord.obsidianPath.split("/");
      pathParts.pop();
      const parentDir = pathParts.join("/");
      return (
        parentDir ||
        sanitizeFileName(this.notionClient.extractTitle(await this.notionClient.getPage(parentId)))
      );
    }

    try {
      const parentPage = await this.notionClient.getPage(parentId);
      const parentTitle = this.notionClient.extractTitle(parentPage);
      const grandparentPath = await this.resolveParentPath(parentPage);
      const safeName = sanitizeFileName(parentTitle);
      return grandparentPath ? `${grandparentPath}/${safeName}` : safeName;
    } catch {
      return "";
    }
  }

  /**
   * 페이지 · 행을 만든다. 본문을 markdown 으로 보냈으면 그 markdown 도 돌려준다 — Notion 이 만들며
   * 버린 맨 앞 `# H1` 을 호출측이 매핑을 적은 뒤 되살린다({@link restoreCreatedHeading}). 블록으로
   * 보냈으면 null 이다 — 블록은 보낸 그대로 생긴다.
   */
  private async pushCreatePage(
    parentId: string,
    parentType: "page" | "database",
    title: string,
    markdownContent: string,
    properties?: Record<string, unknown>,
  ): Promise<CreatedPage> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      const markdown = obsidianToNotionEnhanced(markdownContent);
      const page = await this.notionClient.createPageWithMarkdown({
        parentId,
        parentType,
        title,
        markdown,
        properties,
      });
      return { page, markdown };
    }

    const blocks = this.blockConverter.markdownToNotionBlocks(markdownContent);
    const page = await this.notionClient.createPage({
      parentId,
      parentType,
      title,
      properties,
    });
    if (blocks.length > 0) {
      await this.notionClient.appendChildren(page.id, blocks);
    }
    return { page, markdown: null };
  }

  /**
   * 만든 페이지를 마저 채운다 — 버려진 맨 앞 제목을 되살리고 첨부를 올린다. 호출측이 매핑을 먼저
   * 적은 뒤 부른다.
   *
   * @returns 적을 원격 페이지와 본문 지문. 폴더 노트만 지문을 받는다 — 곧 그 아래에 노트가 생겨
   *   수정 시각이 바뀌므로, 다음 push 가 본문이 그대로임을 지문으로 확인한다(자식은 지문에 들지
   *   않는다). 다른 노트의 페이지는 이 도구가 쓰는 한 편집자가 봇으로 남아 지문 없이 가른다.
   */
  private async finishCreatedPage(
    created: CreatedPage,
    conversionResult: ConversionResult,
    path: string,
  ): Promise<{ page: RemotePageStamp; bodyFingerprint: string | null }> {
    let page = await this.restoreCreatedHeading(created, path);
    if (await this.syncEmbeddedMedia(created.page.id, conversionResult, path)) {
      // 첨부가 본문을 고쳤다 — 수정 시각을 다시 받는다(I5). 옛 시각을 적으면 다음 push 가 이
      // 변경을 원격 편집으로 본다.
      page = await this.notionClient.getPage(created.page.id);
    }
    const bodyFingerprint = isFolderNotePath(path)
      ? await this.drift.remoteBodyFingerprintOf(created.page.id)
      : null;
    return { page, bodyFingerprint };
  }

  /**
   * 만들며 버려진 맨 앞 `# H1` 을 되살리고(N-04) 적을 원격 페이지를 돌려준다. 되살렸으면 서버가
   * 다시 준 페이지다 — 만들 때의 시각을 적으면 다음 pull 이 이 교체를 원격 수정으로 본다(I5).
   *
   * 호출측이 매핑을 먼저 적고, 첨부를 올리기 전에 부른다 — 교체가 자리표시자를 첨부로 바꾼 본문을
   * 되돌리지 않는다. 여기서 던지면 그 항목만 실패하고, 다음 push 는 새로 만들지 않고 갱신으로 본문을
   * 다시 보낸다(본문 교체는 맨 앞 H1 을 남긴다).
   */
  private async restoreCreatedHeading(
    created: CreatedPage,
    path: string,
  ): Promise<RemotePageStamp> {
    const { page, markdown } = created;
    if (markdown === null) return page;
    try {
      if (!(await this.notionClient.restoreLeadingHeading(page.id, markdown))) {
        return page;
      }
      return await this.notionClient.getPage(page.id);
    } catch (error) {
      throw new Error(
        `맨 앞 제목을 Notion 에 되살리지 못함 — 다음 push 가 본문을 다시 보낸다 (${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * `.base` 가 나타내는 Notion DB id 들 — 옆 사이드카(`<이름>.notion.json`)의 DB 와, 그 DB 를
   * 원본으로 둔 링크드 뷰 컨테이너(pull 이 `.base` 를 원본 DB 로 몰아 만든다). 사이드카가
   * 없거나 읽지 못하면 빈 목록 — 호출측이 제목으로 맞춘다.
   */
  private async databaseIdsOfBase(basePath: string): Promise<string[]> {
    const sidecarPath = basePath.replace(/\.base$/i, ".notion.json");
    let databaseId: unknown;
    try {
      databaseId = (
        JSON.parse(await this.vaultFs.readFile(sidecarPath)) as { databaseId?: unknown }
      ).databaseId;
    } catch {
      return [];
    }
    if (typeof databaseId !== "string") return [];
    const own = compactNotionId(databaseId);
    const linked = [...loadLinkedDbMap(this.stateDb)]
      .filter(([, original]) => original === own)
      .map(([container]) => container);
    return [own, ...linked];
  }

  /**
   * 페이지 본문을 로컬 본문으로 바꾼다. 자식 페이지 · 자식 DB 는 지우지 않는다(S-03).
   *
   * Markdown API 경로는 {@link replacePageBody} 가 자식을 제자리에 두고 바꾼다. 블록 경로는
   * 기존 블록을 모두 지우고 새로 붙이므로 자식까지 지우게 된다 — 자식이 있으면 보내지 않고
   * 실패로 알린다. 예전처럼 조용히 건너뛰면 동기화됨으로 기록돼 편집이 영영 가지 않는다.
   *
   * @returns 바꾼 뒤 원격 본문의 지문({@link remoteBodyFingerprint}). 블록 방식으로 보냈으면 null.
   */
  private async pushUpdatePage(
    pageId: string,
    markdownContent: string,
    _baseSnapshot?: Buffer | null,
  ): Promise<string | null> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      const enhanced = obsidianToNotionEnhanced(markdownContent);
      const written = await replacePageBody(this.notionClient, pageId, enhanced, {
        databaseIdsOfBase: (basePath) => this.databaseIdsOfBase(basePath),
      });
      // 응답의 본문은 다시 받은 본문과 같다 — 잘렸으면 온전한 본문을 다시 받는다.
      return written.truncated || (written.unknown_block_ids ?? []).length > 0
        ? this.drift.remoteBodyFingerprintOf(pageId)
        : remoteBodyFingerprint(written.markdown);
    }

    // 휴지통 자식은 children.list 에 잡히지 않으므로 여기 보이는 자식은 모두 살아 있다.
    const existingBlocks = await this.notionClient.fetchAllChildren(pageId);
    if (existingBlocks.some((b) => b.type === "child_page" || b.type === "child_database")) {
      throw new Error(
        "자식 페이지 · DB 가 있는 페이지는 블록 방식으로 본문을 보내면 자식까지 지워져 보내지 않음 — " +
          "설정 conversion.preferMarkdownApi 를 기본값(true)으로 두고 다시 push 하세요",
      );
    }

    const blocks = this.blockConverter.markdownToNotionBlocks(markdownContent);
    if (blocks.length > 0) {
      await this.notionClient.appendChildren(pageId, blocks);
    }
    const deleteSema = new Sema(this.config.advanced.concurrency);
    await Promise.all(
      existingBlocks.map(async (block) => {
        await deleteSema.acquire();
        try {
          await this.notionClient.deleteBlock(block.id);
        } finally {
          deleteSema.release();
        }
      }),
    );
    return null;
  }

  /**
   * 페이지 본문을 볼트 쪽 markdown 으로 받는다.
   *
   * @returns `fingerprint` 는 받은 원격 본문의 지문({@link remoteBodyFingerprint}). 블록 API 로
   *   받았으면 null — 지문은 Markdown API 의 본문으로만 견준다.
   */
  private async fetchPageMarkdown(
    pageId: string,
  ): Promise<{ content: string; compact: boolean; fingerprint: string | null }> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      try {
        const result = await this.notionClient.getPageMarkdown(pageId);
        this.discovery.collectInlineDbRefs(pageId, result.markdown);
        return {
          content: this.resolveNotionIdWikilinks(notionEnhancedToObsidian(result.markdown)),
          // 압축형 판정은 반드시 원시 export 기준 — enhanced 변환이 <empty-block/> 을
          // 빈 줄로 바꾼 뒤에는 BlockSpacer 가 저작형과 구분할 수 없다(D1).
          compact: isCompactExport(result.markdown),
          fingerprint: remoteBodyFingerprint(result.markdown),
        };
      } catch (error) {
        // Markdown API 실패 시 blocks API fallback — 잘린 블록이 상한보다 많을 때(S-06)도 여기로 온다.
        getLogger().warn(
          `[Im-Nobsidian] Markdown API 로 받지 못해 블록 API 로 받음 (${pageId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // blocks-API 폴백 산출물은 이미 표준 간격 — 재간격 불필요.
    // 폴백 변환기도 child-database 보존 마커를 발행하므로 인라인 DB 수집을 이어간다.
    const fallback = await this.blockConverter.notionBlocksToMarkdown(pageId);
    this.discovery.collectInlineDbRefs(pageId, fallback);
    return { content: fallback, compact: false, fingerprint: null };
  }

  // pull 시 url 기반 page mention 은 `[[notion:<id>]]` 로 1차 변환된다(notionEnhancedToObsidian).
  // 이를 state DB 역조회로 원래 `[[제목]]` 위키링크로 복원해 push↔pull 라운드트립을 수렴시킨다.
  // 볼트 밖/미추적 페이지면 `[[notion:<id>]]` 를 그대로 두어 정보 손실을 막는다.
  private resolveNotionIdWikilinks(markdown: string): string {
    return resolveNotionIdWikilinks(
      markdown,
      (id) => this.stateDb.getByNotionId(normalizeNotionId(id))?.obsidianPath ?? null,
    ).markdown;
  }

  /**
   * 신규 pull 페이지가 쓸 파일 경로를 충돌 없이 결정하고 **그 자리에서 선점**한다.
   *
   * DB 행과 **같은 규칙**({@link pagePathCandidates})을 쓴다. 예전에는 `(1)`, `(2)` …
   * 순번을 99 까지 훑고 고갈되면 **원본 경로를 그대로 돌려줬는데**, 그러면 남의 노트를
   * 조용히 덮어써 내용이 사라진다. 순번은 그때의 볼트 상태로 정해져 실행마다 페이지끼리
   * 접미사가 뒤바뀔 수도 있었다(pull 마다 파일이 갈아엎히는 churn).
   *
   * 점유 판정은 세 가지를 모두 본다:
   *   · 이번 실행의 선점 장부 — 아래 참조.
   *   · 추적 레코드 — 다른 페이지가 소유한 경로면 피하고, 자기 소유면 그대로 재사용한다.
   *   · 볼트 파일 — 추적되지 않는 사용자 노트가 놓여 있으면 피한다.
   *
   * 선점 장부가 필요한 이유는 pull 이 워커 풀로 **동시 실행**되기 때문이다. 조회와 기록
   * 사이에 await 가 끼면 동명 페이지 여럿이 나란히 "비어 있음"을 보고 같은 경로를 고른다.
   * 그러면 마지막에 쓴 페이지만 남고 나머지 본문이 사라진다(실측 재현: 동명 3페이지 →
   * 파일 1개·레코드 1건). 그래서 마지막 확인과 등록을 **await 없는 동기 구간**에 묶는다 —
   * 그 사이에는 다른 작업이 끼어들 수 없으므로 두 페이지가 같은 경로를 얻는 일이 없다.
   */
  private async resolveUniqueFilePath(
    dir: string,
    safeName: string,
    pageId: string,
  ): Promise<string> {
    const candidates = pagePathCandidates(dir, safeName, pageId);

    for (const candidate of candidates) {
      if (this.claimedPaths.has(candidate)) continue;

      const owner = this.stateDb.getByPath(candidate);
      if (owner) {
        // 자기 소유면 재사용해야 멱등하다(레코드가 남은 채 파일만 지워진 복원 시나리오).
        if (owner.notionPageId != null && notionIdsEqual(owner.notionPageId, pageId)) {
          this.claimedPaths.add(candidate);
          return candidate;
        }
        continue;
      }

      if (await this.vaultFs.exists(candidate)) continue;

      // ── 여기부터 동기 구간(await 금지) ── 위 await 동안 다른 작업이 선점했을 수 있다.
      if (this.claimedPaths.has(candidate)) continue;
      this.claimedPaths.add(candidate);
      return candidate;
    }

    // 전체 ID(32 글자) 후보는 전역 유일하므로 위 루프에서 반드시 반환된다.
    // 도달 불가 경로이나 방어적으로 가장 유일한 후보를 돌려준다.
    const fallback = candidates[candidates.length - 1]!;
    this.claimedPaths.add(fallback);
    return fallback;
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

function extractTitle(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1] ?? "";
  return filename.replace(/\.md$/, "");
}

/** 페이지 · 행 제목만 바꾸는 속성 — 제목 속성의 id 는 페이지 · 행 모두 `title` 이다. */
function titleProperty(title: string): Record<string, unknown> {
  return { title: { title: [{ text: { content: title } }] } };
}

function extractAliases(properties: Record<string, unknown>): string[] {
  const raw = properties.aliases ?? properties.alias;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === "string");
  if (typeof raw === "string")
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}
