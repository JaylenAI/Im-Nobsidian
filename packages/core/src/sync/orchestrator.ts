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
  FailedOperation,
} from "../types/sync.js";
import type { Config } from "../types/config.js";
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
import { DatabaseSyncer } from "./database-syncer.js";
import { resolvePullConflict } from "./conflict-detector.js";
import { PropertyMapper } from "../notion/property-mapper.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { notionIdsEqual, normalizeNotionId } from "../utils/id.js";
import { runPool } from "../utils/pool.js";
import type { VaultFS } from "./vault-fs.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../converter/enhanced-md-converter.js";

/** 자동 발견된 DB 설정 빌드 결과 — 동기화 가능/접근 불가/일시 오류를 명시적으로 구분한다. */
type DiscoveredDbOutcome =
  | { kind: "ok"; config: { databaseId: string; localFolder: string; titleProperty: string } }
  | { kind: "inaccessible" }
  | { kind: "error" };

/** 접근 불가 DB denylist 를 보존하는 상태 메타 키. */
const INACCESSIBLE_DBS_META_KEY = "inaccessible_dbs";

export class SyncOrchestrator {
  private readonly changeDetector: ChangeDetector;
  private readonly pipeline: ConversionPipeline;
  private readonly blockConverter: BlockConverter;
  private readonly imageHandler: ImageHandler;
  private readonly fileHandler: FileHandler;
  private readonly databaseSyncer: DatabaseSyncer;
  private readonly propertyMapper: PropertyMapper;
  private dbSchemaLoaded = false;
  private _pullImageCount = 0;
  private _pullFileCount = 0;
  // pull 중 각 페이지 markdown(<database url=.../>)에서 추출한 인라인 DB 참조.
  // key: 하이픈 제거 databaseId, value: 그 DB가 박힌 부모 페이지 id.
  // 블록 트리 재귀 없이 markdown 신호만으로 컬럼/synced_block 등 깊이 중첩된
  // child_database 까지 발견해 폴더+.base 동기화 대상으로 등록한다.
  private _inlineDbRefs = new Map<string, string>();
  // pull 발견 단계에서 모든 페이지의 부모를 해소하며 채우는 "자식을 가진 페이지" 집합
  // (정규화된 page id). 폴더노트/폴더 판정의 단일 신뢰 원천 — 얕은 블록 검사로 callout·
  // column 등 컨테이너에 중첩된 자식 페이지를 놓쳐 폴더노트를 file 로 오분류하던 결함
  // (본문이 최상위로 밀려 ' (1).md' 로 분리)을 차단한다. detectRemoteChanges* 진입 시 재구성.
  private _childParentIds = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
    customFetch?: typeof globalThis.fetch,
  ) {
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
      },
      stateDb,
    );
    this.fileHandler = new FileHandler(
      vaultFs,
      notionClient,
      stateDb,
      config.advanced.fileConcurrency,
    );
    this.propertyMapper = new PropertyMapper();
    this.databaseSyncer = new DatabaseSyncer(
      config,
      stateDb,
      notionClient,
      vaultFs,
      this.pipeline,
      this.imageHandler,
    );
    this.propertyMapper.setWikilinkResolver({
      resolve: (title: string) => stateDb.resolveWikilink(title)?.notionPageId ?? null,
      resolvePageId: (pageId: string) => stateDb.resolvePageId(pageId)?.title ?? null,
    });

    this.blockConverter.initNotionToMd(this.notionClient.getInternalClient());
  }

  async push(options?: PushOptions): Promise<PushResult> {
    const startTime = Date.now();

    if (this.config.sync.direction === "pull") {
      return { created: 0, updated: 0, deleted: 0, failed: [], duration: Date.now() - startTime };
    }

    this.cleanupInterruptedSync();
    this.repairFolderRecords();
    await this.recoverInterruptedPushOps();

    const stats = await this.vaultFs.listMarkdownFileStats();
    const changes = await this.changeDetector.detectLocalChangesFast(stats, (path) =>
      this.vaultFs.readFile(path),
    );

    const conflictPaths = new Set(this.stateDb.getByStatus("conflict").map((r) => r.obsidianPath));
    const eligible = options?.force ? changes : changes.filter((c) => !conflictPaths.has(c.path));

    const dbFolders = (this.config.notion.databases ?? []).map((d) =>
      d.localFolder.endsWith("/") ? d.localFolder : d.localFolder + "/",
    );
    const isDbPath = (path: string) => dbFolders.some((prefix) => path.startsWith(prefix));

    const excludeSet = options?.excludePaths ? new Set(options.excludePaths) : null;
    const filtered = (
      options?.paths
        ? eligible.filter((c) => options.paths!.some((p) => c.path.startsWith(p)))
        : eligible
    ).filter((c) => !isDbPath(c.path) && (!excludeSet || !excludeSet.has(c.path)));

    const hasDbConfigs = (this.config.notion.databases?.length ?? 0) > 0;
    if (filtered.length === 0 && !hasDbConfigs) {
      return { created: 0, updated: 0, deleted: 0, failed: [], duration: Date.now() - startTime };
    }

    if (options?.dryRun) {
      const dryCreated = filtered.filter((c) => c.type === "created").length;
      const dryUpdated = filtered.filter((c) => c.type === "modified" || c.type === "moved").length;
      const dryDeleted = filtered.filter((c) => c.type === "deleted").length;
      let dryProgress = 0;
      const dryTotal = filtered.length;
      for (const change of filtered) {
        const op =
          change.type === "created"
            ? ("create" as const)
            : change.type === "deleted"
              ? ("delete" as const)
              : ("update" as const);
        options?.onProgress?.(++dryProgress, dryTotal, { path: change.path, operation: op });
      }
      return {
        created: dryCreated,
        updated: dryUpdated,
        deleted: dryDeleted,
        failed: [],
        duration: Date.now() - startTime,
      };
    }

    this.stateDb.setMeta("push_in_progress", "true");

    const folderPaths = new Set<string>();
    for (const change of filtered) {
      const parts = change.path.split("/");
      if (parts.length > 1) {
        for (let i = 1; i < parts.length; i++) {
          folderPaths.add(parts.slice(0, i).join("/"));
        }
      }
    }

    const sortedFolders = [...folderPaths].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );
    for (const folderPath of sortedFolders) {
      await this.ensureFolderPage(folderPath);
    }

    const counts = { created: 0, updated: 0, deleted: 0 };
    const failed: FailedOperation[] = [];

    let completed = 0;
    const total = filtered.length;

    const opOf = (change: LocalChange): "create" | "update" | "delete" =>
      change.type === "created" ? "create" : change.type === "deleted" ? "delete" : "update";

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
          await this.pushMove(change.path);
          counts.updated++;
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
    await runPool(
      filtered,
      async (change) => {
        if (options?.signal?.aborted) return;
        options?.onProgress?.(++completed, total, { path: change.path, operation: opOf(change) });
        try {
          await applyPushChange(change);
        } catch {
          retryQueue.push(change);
        }
      },
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

      await runPool(
        retryQueue,
        async (change) => {
          try {
            await applyPushChange(change);
            getLogger().info(`[Im-Nobsidian] 재시도 성공: ${change.path}`);
          } catch (error) {
            failed.push({
              path: change.path,
              operation: opOf(change),
              error: error instanceof Error ? error.message : String(error),
            });
            getLogger().warn(`[Im-Nobsidian] 재시도 실패: ${change.path}`);
          }
        },
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

    if ((this.config.notion.databases?.length ?? 0) > 0) {
      try {
        const dbResult = await this.databaseSyncer.pushAll();
        counts.created += dbResult.created;
        counts.updated += dbResult.updated;
        failed.push(...dbResult.failed);
      } catch (error) {
        getLogger().warn("[Im-Nobsidian] DB Push 중 오류:", error);
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
      failed,
      duration: Date.now() - startTime,
    };
  }

  async pull(options?: PullOptions): Promise<PullResult> {
    const startTime = Date.now();
    const emptyResult: PullResult = {
      created: 0,
      updated: 0,
      deleted: 0,
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

    this.cleanupInterruptedSync();

    const counts = { created: 0, updated: 0, deleted: 0 };
    this._pullImageCount = 0;
    this._pullFileCount = 0;
    this._inlineDbRefs.clear();
    const conflicts: Conflict[] = [];
    const writtenPaths: string[] = [];
    const failed: FailedOperation[] = [];

    const lastPull = this.stateDb.getMeta("last_pull_at") ?? this.stateDb.getMeta("last_sync_at");
    const trackedCount = this.stateDb.getAll().length;
    const remoteChanges =
      !this.isDatabaseMode && lastPull && trackedCount > 0 && !options?.force
        ? await this.detectRemoteChangesIncremental(lastPull)
        : await this.detectRemoteChanges();

    const filtered = options?.paths
      ? remoteChanges.filter((c) => {
          const record = this.stateDb.getByNotionId(c.pageId);
          return record && options.paths!.some((p) => record.obsidianPath.startsWith(p));
        })
      : remoteChanges;

    if (filtered.length === 0 && (this.config.notion.databases?.length ?? 0) === 0) {
      const hasDbResults = await this.pullDiscoveredDatabases(writtenPaths, failed, conflicts);
      if (!hasDbResults.created && !hasDbResults.updated) {
        this.stateDb.setMeta("last_pull_at", new Date().toISOString());
        this.stateDb.setMeta("last_sync_at", new Date().toISOString());
        this.stateDb.setMeta("pull_in_progress", "");
        return emptyResult;
      }
      this.stateDb.setMeta("last_pull_at", new Date().toISOString());
      this.stateDb.setMeta("last_sync_at", new Date().toISOString());
      this.stateDb.setMeta("pull_in_progress", "");
      return {
        created: hasDbResults.created,
        updated: hasDbResults.updated,
        deleted: 0,
        conflicts,
        writtenPaths,
        failed,
        duration: Date.now() - startTime,
        imageCount: 0,
        fileCount: 0,
        linkCount: 0,
      };
    }
    if (filtered.length === 0) {
      return emptyResult;
    }

    if (options?.dryRun) {
      const dryCreated = filtered.filter((c) => c.type === "created").length;
      const dryUpdated = filtered.filter((c) => c.type === "modified").length;
      const dryDeleted = filtered.filter((c) => c.type === "deleted").length;
      let dryProgress = 0;
      const dryTotal = filtered.length;
      for (const change of filtered) {
        const op =
          change.type === "created"
            ? ("create" as const)
            : change.type === "deleted"
              ? ("delete" as const)
              : ("update" as const);
        const record = this.stateDb.getByNotionId(change.pageId);
        const displayPath = record?.obsidianPath ?? change.pageId;
        options?.onProgress?.(++dryProgress, dryTotal, { path: displayPath, operation: op });
      }
      return {
        created: dryCreated,
        updated: dryUpdated,
        deleted: dryDeleted,
        conflicts: [],
        writtenPaths: [],
        failed: [],
        duration: Date.now() - startTime,
        imageCount: 0,
        fileCount: 0,
        linkCount: 0,
      };
    }

    this.stateDb.setMeta("pull_in_progress", "true");

    const pullTotal = filtered.length;
    let pullCompleted = 0;

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
          const result = await this.pullUpdate(change);
          if (result.conflict) {
            conflicts.push(result.conflict);
          } else if (result.path) {
            writtenPaths.push(result.path);
            counts.updated++;
          }
          return result.path;
        }
        case "deleted": {
          const record = this.stateDb.getByNotionId(change.pageId);
          const path = await this.pullDelete(change.pageId);
          if (path) {
            counts.deleted++;
            return path;
          }
          return record?.obsidianPath;
        }
        default:
          return undefined;
      }
    };

    // 1차 처리 — 고정 크기 워커 풀(백프레셔). 실패한 변경은 재시도 큐로 모은다.
    const retryQueue: RemoteChange[] = [];
    await runPool(
      filtered,
      async (change) => {
        if (options?.signal?.aborted) return;
        try {
          const resultPath = await applyChange(change);
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
            await applyChange(change);
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

    if ((this.config.notion.databases?.length ?? 0) > 0) {
      try {
        const dbResult = await this.databaseSyncer.pullAll();
        counts.created += dbResult.created;
        counts.updated += dbResult.updated;
        conflicts.push(...dbResult.conflicts);
        failed.push(...dbResult.failed);
        if (dbResult.created + dbResult.updated > 0) {
          const dbPaths = this.stateDb
            .getByStatus("synced")
            .filter((r) => r.fileType === "db-row")
            .map((r) => r.obsidianPath);
          writtenPaths.push(...dbPaths.slice(-dbResult.created - dbResult.updated));
        }
      } catch (error) {
        getLogger().warn("[Im-Nobsidian] DB Pull 중 오류:", error);
      }
    }

    {
      const dbDiscovery = await this.pullDiscoveredDatabases(writtenPaths, failed, conflicts);
      counts.created += dbDiscovery.created;
      counts.updated += dbDiscovery.updated;
    }

    const linkTargetPaths = writtenPaths.length > 0 ? writtenPaths : [];
    const linkCount =
      linkTargetPaths.length > 0 ? await this.resolveNotionLinks(linkTargetPaths) : 0;

    this.stateDb.setMeta("last_pull_at", new Date().toISOString());
    this.stateDb.setMeta("last_sync_at", new Date().toISOString());
    this.stateDb.setMeta("pull_in_progress", "");

    return {
      created: counts.created,
      updated: counts.updated,
      deleted: counts.deleted,
      conflicts,
      writtenPaths,
      failed,
      duration: Date.now() - startTime,
      imageCount: this._pullImageCount,
      fileCount: this._pullFileCount,
      linkCount,
    };
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const pullResult = await this.pull(options);
    const pushResult = await this.push({
      ...options,
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

  async status(): Promise<StatusResult> {
    const files = await this.vaultFs.listMarkdownFiles();
    const localChanges = this.changeDetector.detectLocalChanges(files);
    const lastSyncAt = this.stateDb.getMeta("last_sync_at");
    const remoteChanges = lastSyncAt
      ? await this.detectRemoteChangesIncremental(lastSyncAt)
      : await this.detectRemoteChanges();
    const conflictRecords = this.stateDb.getByStatus("conflict");

    const conflicts: Conflict[] = await this.buildConflictsFromRecords(
      conflictRecords,
      localChanges,
      remoteChanges,
    );

    return {
      localChanges,
      remoteChanges,
      conflicts,
      conflictRecords,
      pendingOperations: conflictRecords.length,
      lastSyncAt,
    };
  }

  async statusLocal(): Promise<StatusResult> {
    const stats = await this.vaultFs.listMarkdownFileStats();
    const localChanges = await this.changeDetector.detectLocalChangesFast(stats, (path) =>
      this.vaultFs.readFile(path),
    );
    const conflictRecords = this.stateDb.getByStatus("conflict");
    const lastSyncAt = this.stateDb.getMeta("last_sync_at");

    return {
      localChanges,
      remoteChanges: [],
      conflicts: [],
      conflictRecords,
      pendingOperations: conflictRecords.length,
      lastSyncAt,
    };
  }

  async fetch(): Promise<{
    newPages: number;
    deletedPages: number;
    modifiedPages: number;
    duration: number;
  }> {
    const startTime = Date.now();
    const changes = await this.detectRemoteChanges();
    this.stateDb.setMeta("last_fetch_at", new Date().toISOString());
    return {
      newPages: changes.filter((c) => c.type === "created").length,
      modifiedPages: changes.filter((c) => c.type === "modified").length,
      deletedPages: changes.filter((c) => c.type === "deleted").length,
      duration: Date.now() - startTime,
    };
  }

  private async buildConflictsFromRecords(
    records: SyncRecord[],
    localChanges: LocalChange[],
    remoteChanges: RemoteChange[],
  ): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];

    for (const record of records) {
      const localChange = localChanges.find((c) => c.path === record.obsidianPath) ?? {
        path: record.obsidianPath,
        type: "modified" as const,
        currentHash: record.contentHash,
        previousHash: record.contentHash,
      };

      const remoteChange = remoteChanges.find((c) => c.pageId === record.notionPageId) ?? {
        pageId: record.notionPageId ?? "",
        type: "modified" as const,
        lastEdited: record.notionLastEdited ?? "",
        previousEdited: null,
      };

      let localContent = "";
      try {
        localContent = await this.vaultFs.readFile(record.obsidianPath);
      } catch {
        // 파일이 삭제된 경우
      }

      let remoteContent = "";
      if (record.notionPageId) {
        try {
          remoteContent = await this.fetchPageMarkdown(record.notionPageId);
        } catch {
          // 페이지가 삭제된 경우
        }
      }

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

  private get isDatabaseMode(): boolean {
    return this.config.notion.parentMode === "database" && !!this.config.notion.databaseId;
  }

  private async discoverChildDatabases(): Promise<Array<{ dbId: string; parentPageId: string }>> {
    const allDbs: Array<{ dbId: string; parentPageId: string }> = [];
    const trackedPages = this.stateDb.getAll().filter((r) => r.notionPageId);
    const pageIds = [this.config.notion.rootPageId, ...trackedPages.map((r) => r.notionPageId!)];
    const seen = new Set<string>();

    for (const parentId of pageIds) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      try {
        const dbIds = await this.notionClient.getChildDatabaseIds(parentId);
        for (const dbId of dbIds) {
          allDbs.push({ dbId, parentPageId: parentId });
        }
      } catch {
        // 접근 권한 없는 블록 무시
      }
    }

    return allDbs;
  }

  /**
   * 자동 발견된 child_database 1개를 DatabaseSyncer 설정으로 변환한다.
   * 블록 스캔/markdown 양쪽 발견 경로에서 공통으로 사용한다.
   * - localFolder: 부모 페이지의 obsidianPath 기준으로 폴더를 잡아 원본 중첩 구조를 보존
   *   (예: 부모 "AI Engineer (1).md" + DB "Minirecord Project" → "AI Engineer (1)/Minirecord-Project")
   * - 제목 취득 실패 시 부모 폴더명 기반 안전 이름으로 폴백
   */
  private async buildDiscoveredDbConfig(
    dbId: string,
    parentPageId: string,
  ): Promise<DiscoveredDbOutcome> {
    let dbTitle: string;
    try {
      // 제목 + 접근 가능한 data source 유무를 1회 호출로 확인한다. data source 가 없으면
      // 행 조회가 404 로 실패하고 빈 폴더/.base 만 남기므로, 발견 단계에서 미리 제외한다.
      const info = await this.notionClient.getDatabaseSyncability(dbId);
      if (!info.queryable) {
        return { kind: "inaccessible" };
      }
      dbTitle = info.title;
    } catch (error) {
      // 삭제된 DB 도 404 → 접근 불가로 강등(재시도하지 않음). 그 외는 일시 오류로 본다.
      if (isNotionObjectNotFound(error)) return { kind: "inaccessible" };
      getLogger().warn(`[Im-Nobsidian] 자동 발견 DB ${dbId} 설정 생성 실패:`, error);
      return { kind: "error" };
    }

    const parentEntry = parentPageId ? this.stateDb.getByNotionId(parentPageId) : null;
    let parentFolder = "";
    if (parentEntry?.obsidianPath) {
      const obsPath = parentEntry.obsidianPath;
      if (obsPath.endsWith(".md")) {
        const parts = obsPath.split("/");
        parts.pop();
        parentFolder = parts.length > 0 ? parts.join("/") : obsPath.replace(/\.md$/, "");
      } else {
        parentFolder = obsPath;
      }
    }
    let safeName: string;
    if (dbTitle) {
      safeName = dbTitle.replace(/[^a-zA-Z0-9가-힣\s_-]/g, "").replace(/\s+/g, "-");
    } else {
      const parentName = parentFolder.split("/").pop() || "";
      safeName = parentName ? `${parentName}-DB` : `db-${dbId.replace(/-/g, "").slice(0, 8)}`;
    }
    if (!safeName) safeName = `db-${dbId.replace(/-/g, "").slice(0, 8)}`;
    if (!parentFolder) parentFolder = "databases";
    return {
      kind: "ok",
      config: {
        databaseId: dbId,
        localFolder: `${parentFolder}/${safeName}`,
        titleProperty: "Name",
      },
    };
  }

  /** 접근 불가 DB denylist 를 상태 메타에서 로드한다(하이픈 정규화). */
  private loadInaccessibleDbIds(): Set<string> {
    const raw = this.stateDb.getMeta(INACCESSIBLE_DBS_META_KEY);
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw) as string[];
      return new Set(arr.map((id) => id.replace(/-/g, "")));
    } catch {
      return new Set();
    }
  }

  private async pullDiscoveredDatabases(
    writtenPaths: string[],
    failed: FailedOperation[],
    conflicts: Conflict[],
  ): Promise<{ created: number; updated: number }> {
    if (this.isDatabaseMode) return { created: 0, updated: 0 };

    let created = 0;
    let updated = 0;

    try {
      const cachedRaw = this.stateDb.getMeta("discovered_dbs");
      let dbConfigs: Array<{ databaseId: string; localFolder: string; titleProperty: string }> = [];

      if (cachedRaw) {
        try {
          dbConfigs = JSON.parse(cachedRaw);
        } catch {
          dbConfigs = [];
        }
      }

      const configuredIds = new Set(
        (this.config.notion.databases ?? []).map((d) => d.databaseId.replace(/-/g, "")),
      );
      const knownIds = new Set<string>([
        ...configuredIds,
        ...dbConfigs.map((c) => c.databaseId.replace(/-/g, "")),
      ]);
      let changed = false;

      // 접근 불가(링크드/미공유/삭제) DB denylist — 매 pull 마다 doomed 404 재시도 +
      // 스택트레이스 노이즈를 차단한다. 발견 단계에서 걸러 빈 폴더/.base 오염도 막는다.
      const inaccessibleIds = this.loadInaccessibleDbIds();
      let inaccessibleChanged = false;
      const degrade = (rawId: string): void => {
        const nohyph = rawId.replace(/-/g, "");
        if (!inaccessibleIds.has(nohyph)) {
          inaccessibleIds.add(nohyph);
          inaccessibleChanged = true;
        }
        getLogger().info(
          `[Im-Nobsidian] DB ${rawId}: 접근 가능한 data source 없음(링크드/미공유/삭제 추정) — 동기화 대상에서 제외(제목은 부모 페이지에 보존)`,
        );
      };

      // (1) 블록 스캔 기반 발견 — 추적 페이지마다 직속 children 1회 조회로 비용이 크므로
      //     캐시가 비었을 때(최초 full pull)만 수행한다.
      if (dbConfigs.length === 0) {
        const discovered = await this.discoverChildDatabases();
        for (const { dbId, parentPageId } of discovered) {
          const nohyph = dbId.replace(/-/g, "");
          if (knownIds.has(nohyph) || inaccessibleIds.has(nohyph)) continue;
          const outcome = await this.buildDiscoveredDbConfig(dbId, parentPageId);
          knownIds.add(nohyph);
          if (outcome.kind === "ok") {
            dbConfigs.push(outcome.config);
            changed = true;
          } else if (outcome.kind === "inaccessible") {
            degrade(dbId);
          }
        }
      }

      // (2) markdown 기반 발견 — 추가 API 호출 없이 컬럼/synced_block 내부 깊이 중첩된
      //     child_database 까지 포착한다. 이번 pull 에서 재취득된 페이지에 한해 채워지므로
      //     캐시 유무와 무관하게 항상 병합한다(증분 pull·업그레이드 시 신규 DB 흡수).
      for (const [nohyph, parentPageId] of this._inlineDbRefs) {
        if (knownIds.has(nohyph) || inaccessibleIds.has(nohyph)) continue;
        const dbId = normalizeNotionId(nohyph);
        const outcome = await this.buildDiscoveredDbConfig(dbId, parentPageId);
        knownIds.add(nohyph);
        if (outcome.kind === "ok") {
          dbConfigs.push(outcome.config);
          changed = true;
        } else if (outcome.kind === "inaccessible") {
          degrade(dbId);
        }
      }

      // 동기화 가능한 DB 만 처리하고, 캐시에 잔존하던 접근 불가 DB 는 건너뛴다.
      // 처리에 성공/일시실패한 DB 만 stillSyncable 로 모아 캐시의 권위적 스냅샷으로 삼는다.
      const stillSyncable: typeof dbConfigs = [];
      for (const dbConfig of dbConfigs) {
        if (inaccessibleIds.has(dbConfig.databaseId.replace(/-/g, ""))) continue;
        try {
          const dbResult = await this.databaseSyncer.pullDatabase(dbConfig);
          created += dbResult.created;
          updated += dbResult.updated;
          conflicts.push(...dbResult.conflicts);
          failed.push(...dbResult.failed);
          if (dbResult.created + dbResult.updated > 0) {
            const dbPaths = this.stateDb
              .getByStatus("synced")
              .filter((r) => r.fileType === "db-row")
              .map((r) => r.obsidianPath);
            writtenPaths.push(...dbPaths.slice(-dbResult.created - dbResult.updated));
          }
          stillSyncable.push(dbConfig);
        } catch (error) {
          if (isNotionObjectNotFound(error)) {
            // 캐시에 있었지만 이제 행 조회가 404 — 링크드/미공유/삭제로 강등(스택트레이스 억제).
            degrade(dbConfig.databaseId);
          } else {
            // 일시적/실제 오류 — 캐시에 유지해 다음 pull 에 재시도한다.
            getLogger().warn(`[Im-Nobsidian] DB ${dbConfig.databaseId} 동기화 실패:`, error);
            stillSyncable.push(dbConfig);
          }
        }
      }

      // 발견·강등·정리 결과를 캐시에 1회 반영(접근 불가 DB 는 stillSyncable 에서 빠져 제거됨).
      if (changed || inaccessibleChanged || stillSyncable.length !== dbConfigs.length) {
        this.stateDb.setMeta("discovered_dbs", JSON.stringify(stillSyncable));
      }
      if (inaccessibleChanged) {
        this.stateDb.setMeta(INACCESSIBLE_DBS_META_KEY, JSON.stringify([...inaccessibleIds]));
      }
    } catch (error) {
      getLogger().warn("[Im-Nobsidian] child_database 자동 발견 실패:", error);
    }

    return { created, updated };
  }

  private async resolveNotionLinks(paths: string[]): Promise<number> {
    let totalResolved = 0;
    const allRecords = this.stateDb.getAll();
    const idToTitle = new Map<string, string>();
    for (const r of allRecords) {
      if (r.notionPageId && r.obsidianPath) {
        const title = r.obsidianPath.replace(/\.md$/, "").split("/").pop() ?? "";
        const cleanId = r.notionPageId.replace(/-/g, "");
        idToTitle.set(cleanId, title);
        idToTitle.set(r.notionPageId, title);
      }
    }
    if (idToTitle.size === 0) return 0;

    for (const filePath of paths) {
      if (!filePath.endsWith(".md")) continue;
      try {
        let content = await this.vaultFs.readFile(filePath);
        let changed = false;

        const resolved = content.replace(/\[\[notion:([a-f0-9-]+)\]\]/g, (_match, id: string) => {
          const title = idToTitle.get(id.replace(/-/g, ""));
          if (title) {
            totalResolved++;
            changed = true;
            return `[[${title}]]`;
          }
          return _match;
        });
        content = resolved;

        // Notion 내부 페이지 링크는 `/<id>?pvs=N` 또는 `/p/<id>?...`(신형) 형태로 온다.
        // 선택적 `p/` 접두사와 임의 쿼리스트링(또는 쿼리 없음)을 모두 허용한다.
        const resolved2 = content.replace(
          /\[([^\]]+)\]\(\/(?:p\/)?([a-f0-9]{32})(?:\?[^)]*)?\)/g,
          (_match, text: string, id: string) => {
            const title = idToTitle.get(id);
            if (title) {
              totalResolved++;
              changed = true;
              return `[[${title}|${text}]]`;
            }
            return _match;
          },
        );
        content = resolved2;

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
    return totalResolved;
  }

  private async ensureDbSchema(): Promise<void> {
    if (this.dbSchemaLoaded || !this.isDatabaseMode) return;
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

    const content = await this.vaultFs.readFile(path);
    const title = extractTitle(path);
    const parentId = await this.resolveNotionParent(path);

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

    let effectiveParentId = parentId;
    let effectiveParentType: "page" | "database" = "page";
    let effectiveProperties = conversionResult.properties;

    if (this.isDatabaseMode) {
      await this.ensureDbSchema();
      effectiveParentId = this.config.notion.databaseId!;
      effectiveParentType = "database";
      effectiveProperties = this.propertyMapper.toNotionProperties(
        conversionResult.properties,
        title,
      );
    }

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
      fileType: this.isFolderNote(path) ? "folder-note" : "file",
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });
    // 인-런 재시도 시 같은 state 에 대한 op 중복 기록을 막는다(기존 미완료 op 재사용).
    const existingOp = this.stateDb.getIncompleteOpByState(placeholder.id, "create");
    const walOpId =
      existingOp?.id ??
      this.stateDb.recordPendingOperation({
        syncStateId: placeholder.id,
        operation: "create",
        direction: "push",
        payload: JSON.stringify({ path, parentId, title }),
      });

    const page = await this.pushCreatePage(
      effectiveParentId,
      effectiveParentType,
      title,
      conversionResult.content,
      effectiveProperties,
    );

    // 페이지 생성 직후 매핑을 먼저 기록(전이 상태 pending). 이후 이미지 업로드 등이
    // 실패해도 이 레코드 덕에 다음 시도는 pushCreate(중복) 가 아니라 pushUpdate 로
    // 이어진다. contentHash 를 비워 변경감지가 "미완료 → 재푸시 필요"로 인식하게 한다.
    this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: page.id,
      notionParentId: parentId,
      contentHash: "",
      notionLastEdited: page.last_edited_time,
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: this.isFolderNote(path) ? "folder-note" : "file",
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    await this.imageHandler.uploadAndAppendImages(page.id, conversionResult.images);

    const hash = computeHash(content);
    const fileStat = await this.vaultFs.getFileStat(path);

    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: path,
        notionPageId: page.id,
        notionParentId: parentId,
        contentHash: hash,
        notionLastEdited: page.last_edited_time,
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType: this.isFolderNote(path) ? "folder-note" : "file",
        status: "synced",
        baseSnapshot: Buffer.from(content, "utf-8"),
        localMtime: fileStat?.mtime ?? null,
        localFileSize: fileStat?.size ?? null,
      });

      const aliases = extractAliases(conversionResult.properties);
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: page.id,
        title,
        aliases,
      });

      this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
    });

    // 생성·매핑·이미지·최종 synced 까지 모두 끝났으므로 WAL 을 완료 처리한다.
    this.stateDb.markPendingCompleted(walOpId);
  }

  private async pushUpdate(path: string): Promise<void> {
    const content = await this.vaultFs.readFile(path);
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return;

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

    await this.pushUpdatePage(record.notionPageId, conversionResult.content, record.baseSnapshot);

    await this.imageHandler.uploadAndAppendImages(record.notionPageId, conversionResult.images);

    let propsToUpdate: Record<string, unknown> | undefined;
    if (
      this.isDatabaseMode &&
      conversionResult.properties &&
      Object.keys(conversionResult.properties).length > 0
    ) {
      await this.ensureDbSchema();
      const title = extractTitle(path);
      propsToUpdate = this.propertyMapper.toNotionProperties(conversionResult.properties, title);
    } else if (conversionResult.properties?.title) {
      const titleStr = String(conversionResult.properties.title);
      propsToUpdate = {
        title: { title: [{ text: { content: titleStr } }] },
      };
    }

    let lastEditedTime = new Date().toISOString();
    if (propsToUpdate && Object.keys(propsToUpdate).length > 0) {
      const updatedPage = await this.notionClient.updatePageProperties(
        record.notionPageId,
        propsToUpdate,
      );
      lastEditedTime = updatedPage.last_edited_time;
    }

    const hash = computeHash(content);
    const fileStat = await this.vaultFs.getFileStat(path);
    const title = extractTitle(path);
    const aliases = extractAliases(conversionResult.properties);
    this.stateDb.transaction(() => {
      this.stateDb.updateHash(record.id, hash, Buffer.from(content, "utf-8"));
      this.stateDb.updateStatus(record.id, "synced");
      this.stateDb.setNotionLastEdited(record.id, lastEditedTime);
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

  // 반환값: 실제로 원격(Notion) 삭제가 전파되었는지 여부.
  // deleteSync=false 면 로컬 삭제를 pending 으로만 기록하고 Notion 은 보존하므로
  // false 를 돌려준다 → 호출부가 deleted 카운트를 올리지 않아 보고가 정직해진다.
  private async pushDelete(path: string): Promise<boolean> {
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return false;

    if (!this.config.sync.deleteSync) {
      this.stateDb.updateStatus(record.id, "pending");
      return false;
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
    this.stateDb.transaction(() => {
      this.stateDb.delete(record.id);
      this.stateDb.deleteWikilink(record.obsidianPath);
    });
    return true;
  }

  private async pushMove(path: string): Promise<void> {
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return;

    const newParentId = await this.resolveNotionParent(path);
    const currentParentId = record.notionParentId;

    if (currentParentId && !notionIdsEqual(newParentId, currentParentId)) {
      try {
        const parentType = this.isDatabaseMode ? "database" : "page";
        await this.notionClient.movePage(record.notionPageId, newParentId, parentType);
        this.stateDb.setNotionParentId(record.id, newParentId);
      } catch {
        getLogger().warn(`[Im-Nobsidian] Move API 실패 — "${path}" 내용만 업데이트합니다`);
      }
    }

    await this.pushUpdate(path);
  }

  private async detectRemoteChanges(): Promise<RemoteChange[]> {
    const changes: RemoteChange[] = [];
    this._childParentIds.clear();
    const lastPull = this.stateDb.getMeta("last_pull_at");
    const syncedRecords = this.stateDb.getAll();
    const trackedPageIds = new Set(
      syncedRecords.filter((r) => r.notionPageId).map((r) => r.notionPageId!),
    );

    let remotePages: Array<{ id: string; last_edited_time: string }>;
    if (this.isDatabaseMode) {
      const allPages: Array<{ id: string; last_edited_time: string }> = [];
      let cursor: string | undefined;
      do {
        const result = await this.notionClient.queryDatabase(this.config.notion.databaseId!, {
          startCursor: cursor,
        });
        allPages.push(
          ...result.results.map((p) => ({ id: p.id, last_edited_time: p.last_edited_time })),
        );
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      remotePages = allPages;
    } else {
      // search API로 접근 가능한 전체 페이지를 일괄 조회한 뒤 root subtree만 ancestry 필터링.
      // 블록 트리를 페이지별로 직렬 재귀하던 getChildPagesRecursive(호출 수가 페이지 수의
      // 수십 배) 대비 API 호출 수를 페이지 수/100 수준으로 줄여 첫 pull/전체 스캔을 가속한다.
      const allAccessible = await this.notionClient.searchAllPages();
      const underRoot = await this.filterPagesUnderRoot(allAccessible);
      remotePages = underRoot.map((p) => ({ id: p.id, last_edited_time: p.last_edited_time }));
    }

    // 원격 페이지 목록을 page_id 로 디듀프한다. search API(페이지 모드)·queryDatabase(DB 모드)
    // 모두 페이지네이션 사이 재정렬로 같은 페이지를 중복 반환할 수 있고, 중복이 changes 로
    // 새면 같은 page_id 가 두 번 create 되어 동일 콘텐츠가 클린·`(1)` 두 경로에 기록(첫 파일
    // 고아화)된다. 여기가 페이지·DB 양 모드를 함께 막는 단일 차단점이다.
    const seenRemoteIds = new Set<string>();
    for (const page of remotePages) {
      const key = normalizeNotionId(page.id);
      if (seenRemoteIds.has(key)) continue;
      seenRemoteIds.add(key);

      const record = this.stateDb.getByNotionId(page.id);

      if (!record) {
        changes.push({
          pageId: page.id,
          type: "created",
          lastEdited: page.last_edited_time,
          previousEdited: null,
        });
      } else if (page.last_edited_time !== record.notionLastEdited) {
        changes.push({
          pageId: page.id,
          type: "modified",
          lastEdited: page.last_edited_time,
          previousEdited: record.notionLastEdited,
        });
      }

      trackedPageIds.delete(page.id);
    }

    if (this.config.sync.deleteSync && lastPull) {
      for (const orphanId of trackedPageIds) {
        const record = syncedRecords.find((r) => r.notionPageId === orphanId);
        if (record) {
          changes.push({
            pageId: orphanId,
            type: "deleted",
            lastEdited: new Date().toISOString(),
            previousEdited: record.notionLastEdited,
          });
        }
      }
    }

    return changes;
  }

  private async detectRemoteChangesIncremental(since: string): Promise<RemoteChange[]> {
    const changes: RemoteChange[] = [];
    this._childParentIds.clear();
    const recentPages = await this.notionClient.searchRecentPages(since);

    for (const page of recentPages) {
      const record = this.stateDb.getByNotionId(page.id);
      if (!record) {
        try {
          const fullPage = await this.notionClient.getPage(page.id);
          const parentId = await this.extractParentId(fullPage);
          if (parentId) this._childParentIds.add(normalizeNotionId(parentId));
          if (parentId && this.isTrackedParent(parentId)) {
            changes.push({
              pageId: page.id,
              type: "created",
              lastEdited: page.last_edited_time,
              previousEdited: null,
            });
          }
        } catch {
          // inaccessible page
        }
        continue;
      }
      if (page.last_edited_time !== record.notionLastEdited) {
        changes.push({
          pageId: page.id,
          type: "modified",
          lastEdited: page.last_edited_time,
          previousEdited: record.notionLastEdited,
        });
      }
    }

    return changes;
  }

  private isTrackedParent(parentId: string): boolean {
    if (notionIdsEqual(parentId, this.config.notion.rootPageId)) return true;
    return !!this.stateDb.getByNotionId(parentId);
  }

  /**
   * search API로 받은 전체 접근 가능 페이지 중 rootPageId 하위(자손)만 남긴다.
   * 각 페이지의 parent 체인을 root에 닿을 때까지 거슬러 올라가며 판정한다.
   * - 부모가 이미 받은 페이지면 추가 API 호출 없이 메모리에서 해석(공통 경로)
   * - 부모가 검색 결과에 없으면(데이터베이스·미공유 조상 등) getPage로 1회 조회 후 캐시
   * - 조회 불가/순환/깊이 초과 시 보수적으로 root 하위가 아님으로 판정
   * 판정 결과는 체인 전체에 메모이즈해 형제 페이지 처리 시 재사용한다.
   */
  private async filterPagesUnderRoot(
    allPages: PageObjectResponse[],
  ): Promise<PageObjectResponse[]> {
    const root = normalizeNotionId(this.config.notion.rootPageId);
    const byId = new Map<string, PageObjectResponse>();
    for (const p of allPages) byId.set(normalizeNotionId(p.id), p);

    const verdict = new Map<string, boolean>();

    const isUnderRoot = async (start: PageObjectResponse): Promise<boolean> => {
      const chain: string[] = [];
      let current: PageObjectResponse | null = start;
      let result = false;

      while (current) {
        const id = normalizeNotionId(current.id);
        if (id === root) {
          result = true;
          break;
        }
        const memo = verdict.get(id);
        if (memo !== undefined) {
          result = memo;
          break;
        }
        if (chain.includes(id)) {
          result = false; // 순환 방지
          break;
        }
        chain.push(id);

        const parentId = await this.extractParentId(current);
        if (!parentId) {
          result = false;
          break;
        }
        const pid = normalizeNotionId(parentId);
        // current(id) 는 pid 의 자식 → pid 는 "자식을 가진 페이지"(폴더). 발견 단계에서
        // 전 페이지의 직속 부모를 해소하므로, 이 집합은 폴더 판정의 단일 신뢰 원천이 된다.
        this._childParentIds.add(pid);
        if (pid === root) {
          result = true;
          break;
        }
        const memoParent = verdict.get(pid);
        if (memoParent !== undefined) {
          result = memoParent;
          break;
        }

        let parentPage = byId.get(pid) ?? null;
        if (!parentPage) {
          try {
            parentPage = await this.notionClient.getPage(parentId);
            byId.set(pid, parentPage);
          } catch {
            // 부모가 데이터베이스이거나 미공유 → root 도달 불가로 간주(보수적)
            result = false;
            break;
          }
        }
        current = parentPage;
      }

      for (const id of chain) verdict.set(id, result);
      return result;
    };

    const out: PageObjectResponse[] = [];
    for (const p of allPages) {
      // 루트 페이지 자체는 볼트 컨테이너이므로 콘텐츠 파일로 동기화하지 않는다(자손만 대상).
      if (normalizeNotionId(p.id) === root) continue;
      if (await isUnderRoot(p)) out.push(p);
    }
    return out;
  }

  private async pullCreate(pageId: string): Promise<string> {
    const page = await this.notionClient.getPage(pageId);
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const parentPath = await this.resolveParentPath(page);

    const hasChildPages = await this.pageHasChildContainers(pageId);

    const markdown = await this.fetchPageMarkdown(pageId);
    const hasContent = markdown.trim().length > 0;

    let filePath: string;
    let fileType: "file" | "folder-note" | "folder-only";

    if (hasChildPages && hasContent) {
      const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
      filePath = await this.resolveUniqueFilePath(`${folderPath}/${safeName}.md`);
      fileType = "folder-note";
      await this.vaultFs.ensureFolder(folderPath);
    } else if (hasChildPages && !hasContent) {
      const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
      filePath = await this.resolveUniqueFilePath(`${folderPath}/${safeName}.md`);
      fileType = "folder-only";
      await this.vaultFs.ensureFolder(folderPath);
    } else {
      const basePath = parentPath ? `${parentPath}/${safeName}.md` : `${safeName}.md`;
      filePath = await this.resolveUniqueFilePath(basePath);
      fileType = "file";
    }

    let properties: Record<string, unknown>;
    if (this.isDatabaseMode) {
      await this.ensureDbSchema();
      properties = this.propertyMapper.fromNotionProperties(
        (page as unknown as { properties: Record<string, unknown> }).properties,
      );
    } else {
      properties = this.notionClient.extractProperties(page);
    }
    properties.title = title;

    let processedMarkdown = markdown;
    if (this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title);
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
      { properties },
    );

    // 부모 해소는 파일 기록 전에 끝낸다. parent 가 block 일 때 resolveBlockToPageId 가
    // API 를 호출(429 가능)하는데, 이를 writeFile 뒤에 두면 기록만 되고 sync_state 등록 전에
    // throw → 재시도 시 같은 페이지가 `(1)` 로 재생성되며 첫 파일이 고아가 된다. 기록↔등록
    // 사이에는 throw 가능한 원격 호출을 두지 않는다(원자적 등록 보장).
    const resolvedParentId = await this.extractParentId(page);

    await this.vaultFs.writeFile(filePath, finalContent);

    const hash = computeHash(finalContent);
    const pullStat = await this.vaultFs.getFileStat(filePath);
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: filePath,
        notionPageId: pageId,
        notionParentId: resolvedParentId,
        contentHash: hash,
        notionLastEdited: page.last_edited_time,
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
   * 1차: 발견 단계(filterPagesUnderRoot/증분)에서 전 페이지의 부모를 해소하며 만든
   *      _childParentIds 집합으로 O(1) 판정(추가 API 호출 0, 처리 순서 무관) — 전체 pull 경로.
   * 폴백: 집합에 없을 때만(증분 pull 의 신규 폴더 등) fetchAllChildrenDeep 로 컨테이너를
   *       재귀 탐색해 child_page·child_database 를 직접 확인한다.
   */
  private async pageHasChildContainers(pageId: string): Promise<boolean> {
    if (this._childParentIds.has(normalizeNotionId(pageId))) return true;
    try {
      const deep = await this.notionClient.fetchAllChildrenDeep(pageId);
      return deep.some((b) => b.type === "child_page" || b.type === "child_database");
    } catch {
      return false;
    }
  }

  private async pullUpdate(change: RemoteChange): Promise<{ path?: string; conflict?: Conflict }> {
    const record = this.stateDb.getByNotionId(change.pageId);
    if (!record) return {};

    const page = await this.notionClient.getPage(change.pageId);
    let markdown = await this.fetchPageMarkdown(change.pageId);

    const title = this.notionClient.extractTitle(page);

    let properties: Record<string, unknown>;
    if (this.isDatabaseMode) {
      await this.ensureDbSchema();
      properties = this.propertyMapper.fromNotionProperties(
        (page as unknown as { properties: Record<string, unknown> }).properties,
      );
    } else {
      properties = this.notionClient.extractProperties(page);
    }
    properties.title = title;

    if (this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title);
      markdown = imageResult.content;
      this._pullImageCount += imageResult.downloads.length;
    }

    const fileResult = await this.imageHandler.downloadAllFiles(markdown, title);
    markdown = fileResult.content;
    this._pullFileCount += fileResult.downloads.length;

    const savedMarkers = this.stateDb.getPreserveMarkers(record.obsidianPath);
    const remoteContent = this.pipeline.convertToMarkdown(
      markdown,
      {
        direction: "pull",
        path: "markdown-api",
        filePath: record.obsidianPath,
        parentMode: this.config.notion.parentMode,
      },
      { properties, preserveMarkers: savedMarkers.length > 0 ? savedMarkers : undefined },
    );

    let localContent: string;
    try {
      localContent = await this.vaultFs.readFile(record.obsidianPath);
    } catch {
      localContent = "";
    }

    const resolution = resolvePullConflict({
      record,
      localContent,
      remoteContent,
      remoteChange: change,
      strategy: this.config.sync.conflictStrategy,
    });

    if (resolution.action === "skip") {
      // local-first: 로컬 보존, 리모트 변경 무시
      return { path: record.obsidianPath };
    }
    if (resolution.action === "conflict") {
      this.stateDb.updateStatus(record.id, "conflict");
      return { conflict: resolution.conflict };
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
        notionLastEdited: page.last_edited_time,
        localLastModified: new Date().toISOString(),
        syncDirection: record.syncDirection,
        fileType: record.fileType,
        status: "synced",
        baseSnapshot: Buffer.from(remoteContent, "utf-8"),
        localMtime: updateStat?.mtime ?? null,
        localFileSize: updateStat?.size ?? null,
      });

      const aliases = extractAliases(properties);
      this.stateDb.upsertWikilink({
        obsidianPath: record.obsidianPath,
        notionPageId: change.pageId,
        title,
        aliases,
      });
    });

    return { path: record.obsidianPath };
  }

  private async pullDelete(pageId: string): Promise<string | null> {
    const record = this.stateDb.getByNotionId(pageId);
    if (!record) return null;

    if (this.config.sync.deleteSync) {
      try {
        await this.vaultFs.deleteFile(record.obsidianPath);
      } catch {
        // 이미 삭제된 경우 무시
      }
    }

    this.stateDb.transaction(() => {
      this.stateDb.delete(record.id);
      this.stateDb.deleteWikilink(record.obsidianPath);
    });
    return record.obsidianPath;
  }

  private async ensureFolderPage(folderPath: string): Promise<void> {
    const folderNotePath = `${folderPath}/${folderPath.split("/").pop()}.md`;
    const folderNoteRecord = this.stateDb.getByPath(folderNotePath);

    if (folderNoteRecord?.notionPageId) {
      const existing = this.stateDb.getByPath(folderPath);
      if (existing) {
        this.stateDb.transaction(() => {
          this.stateDb.delete(existing.id);
          this.stateDb.deleteWikilink(existing.obsidianPath);
        });
      }
      return;
    }

    const existing = this.stateDb.getByPath(folderPath);
    if (existing?.notionPageId) return;

    const parts = folderPath.split("/");
    const folderName = parts[parts.length - 1]!;

    let parentId = this.config.notion.rootPageId;
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join("/");
      await this.ensureFolderPage(parentPath);
      const parentNotePath = `${parentPath}/${parentPath.split("/").pop()}.md`;
      const parentNote = this.stateDb.getByPath(parentNotePath);
      const parentRecord = this.stateDb.getByPath(parentPath);
      if (parentNote?.notionPageId) {
        parentId = parentNote.notionPageId;
      } else if (parentRecord?.notionPageId) {
        parentId = parentRecord.notionPageId;
      }
    }

    const folderPage = await this.notionClient.createPage({
      parentId,
      parentType: "page",
      title: folderName,
    });

    this.stateDb.upsert({
      obsidianPath: folderPath,
      notionPageId: folderPage.id,
      notionParentId: parentId,
      contentHash: "",
      notionLastEdited: folderPage.last_edited_time,
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: "folder-note",
      status: "synced",
    });
  }

  private async resolveNotionParent(filePath: string): Promise<string> {
    const parts = filePath.split("/");
    if (parts.length <= 1) return this.config.notion.rootPageId;

    const folderPath = parts.slice(0, -1).join("/");
    const folderRecord = this.stateDb.getByPath(folderPath);
    if (folderRecord?.notionPageId) return folderRecord.notionPageId;

    const folderName = parts[parts.length - 2]!;
    const folderNotePath = `${folderPath}/${folderName}.md`;
    const folderNoteRecord = this.stateDb.getByPath(folderNotePath);
    if (folderNoteRecord?.notionPageId) return folderNoteRecord.notionPageId;

    return this.config.notion.rootPageId;
  }

  private repairFolderRecords(): void {
    const allRecords = this.stateDb.getAll();
    const folderRecords = allRecords.filter(
      (r) => r.fileType === "folder-note" && !r.obsidianPath.endsWith(".md"),
    );
    for (const folder of folderRecords) {
      const folderName = folder.obsidianPath.split("/").pop()!;
      const folderNotePath = `${folder.obsidianPath}/${folderName}.md`;
      const noteRecord = this.stateDb.getByPath(folderNotePath);
      if (noteRecord?.notionPageId) {
        this.stateDb.transaction(() => {
          this.stateDb.delete(folder.id);
          this.stateDb.deleteWikilink(folder.obsidianPath);
        });
      }
    }
  }

  private isFolderNote(filePath: string): boolean {
    const parts = filePath.split("/");
    if (parts.length < 2) return false;
    const fileName = parts[parts.length - 1]!.replace(/\.md$/, "");
    const folderName = parts[parts.length - 2]!;
    return fileName === folderName;
  }

  private async resolveParentPath(page: PageObjectResponse): Promise<string> {
    const parentId = await this.extractParentId(page);
    if (!parentId || notionIdsEqual(parentId, this.config.notion.rootPageId)) return "";

    const parentRecord = this.stateDb.getByNotionId(parentId);
    if (parentRecord) {
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

  private async pushCreatePage(
    parentId: string,
    parentType: "page" | "database",
    title: string,
    markdownContent: string,
    properties?: Record<string, unknown>,
  ): Promise<PageObjectResponse> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      const enhanced = obsidianToNotionEnhanced(markdownContent);
      return await this.notionClient.createPageWithMarkdown({
        parentId,
        parentType,
        title,
        markdown: enhanced,
        properties,
      });
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
    return page;
  }

  // 페이지에 살아있는(휴지통 아님) child page/database 가 직속 블록으로 존재하는가.
  // 휴지통(in_trash) 자식은 children.list 에 잡히지 않으므로 "live" 는 암묵적이다.
  private async pageHasLiveChildren(pageId: string): Promise<boolean> {
    try {
      const children = await this.notionClient.fetchAllChildren(pageId);
      return children.some((b) => b.type === "child_page" || b.type === "child_database");
    } catch (error) {
      // 조회 실패 시 안전측: 자식이 있을 수 있다고 보고 파괴적 replace 를 막는다.
      getLogger().warn(
        `[Im-Nobsidian] 자식 페이지 조회 실패 — 본문 push 보수적 생략(자식 보호): ${pageId} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return true;
    }
  }

  private async pushUpdatePage(
    pageId: string,
    markdownContent: string,
    _baseSnapshot?: Buffer | null,
  ): Promise<void> {
    // 데이터 손실 가드: 이 페이지가 살아있는 child page/database 를 가지면 두 push 경로
    // (replace_content[allow_deleting_content] · block 삭제-후-append)가 모두 자식을
    // 삭제한다. 실Notion probe 확인: replace_content 는 새 마크다운에 없는 child page 를
    // in_trash 로 삭제하고, child page 를 mention 으로 표현하려 하면 거부한다.
    // 자식 페이지는 각자 자기 sync record 로 독립 동기화되므로, 여기서는 본문 갱신을
    // 건너뛰고 자식을 보존한다(무손실). 폴더노트 본문 편집의 Notion 반영은 의도적 degrade.
    if (await this.pageHasLiveChildren(pageId)) {
      getLogger().warn(
        `[Im-Nobsidian] 자식 페이지 보유 — 본문 push 생략(자식 삭제 방지): ${pageId}. ` +
          `자식 페이지는 각자 동기화되며, 이 페이지 본문 편집은 Notion 에 반영되지 않습니다.`,
      );
      return;
    }

    if (this.config.conversion.preferMarkdownApi !== false) {
      const enhanced = obsidianToNotionEnhanced(markdownContent);
      await this.notionClient.replacePageMarkdown(pageId, enhanced);
      return;
    }

    const blocks = this.blockConverter.markdownToNotionBlocks(markdownContent);
    const existingBlocks = await this.notionClient.fetchAllChildren(pageId);

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
  }

  private async fetchPageMarkdown(pageId: string): Promise<string> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      try {
        const result = await this.notionClient.getPageMarkdown(pageId);
        this.collectInlineDbRefs(pageId, result.markdown);
        return this.resolveNotionIdWikilinks(notionEnhancedToObsidian(result.markdown));
      } catch {
        // Markdown API 실패 시 blocks API fallback
      }
    }
    return this.blockConverter.notionBlocksToMarkdown(pageId);
  }

  // Markdown API는 인라인 데이터베이스를 다음처럼 렌더한다(컬럼/synced_block 내부 포함):
  //   <database url="https://www.notion.so/<id-nohyph>" inline="true"
  //             data-source-url="collection://<ds-id>">Title</database>
  // url 안의 32자리 hex 가 databaseId 이므로, 별도 블록 트리 재귀 없이 이 태그만 파싱해
  // 깊이 중첩된 child_database 까지 폴더+.base 동기화 대상으로 등록한다.
  private collectInlineDbRefs(parentPageId: string, rawMarkdown: string): void {
    const re = /<database\b[^>]*\burl="https:\/\/www\.notion\.so\/([a-f0-9]{32})"[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawMarkdown)) !== null) {
      const dbId = m[1];
      if (dbId) this._inlineDbRefs.set(dbId, parentPageId);
    }
  }

  // pull 시 url 기반 page mention 은 `[[notion:<id>]]` 로 1차 변환된다(notionEnhancedToObsidian).
  // 이를 state DB 역조회로 원래 `[[제목]]` 위키링크로 복원해 push↔pull 라운드트립을 수렴시킨다.
  // 볼트 밖/미추적 페이지면 `[[notion:<id>]]` 를 그대로 두어 정보 손실을 막는다.
  private resolveNotionIdWikilinks(markdown: string): string {
    return markdown.replace(/\[\[notion:([a-f0-9]{32})\]\]/g, (match, id: string) => {
      const record = this.stateDb.getByNotionId(normalizeNotionId(id));
      if (!record?.obsidianPath) return match;
      const base = record.obsidianPath.split("/").pop() ?? record.obsidianPath;
      const title = base.replace(/\.md$/, "");
      return `[[${title}]]`;
    });
  }

  private async extractParentId(page: PageObjectResponse): Promise<string | null> {
    const parent = page.parent as {
      type: string;
      page_id?: string;
      database_id?: string;
      block_id?: string;
    };
    if (parent.type === "page_id") return parent.page_id ?? null;
    if (parent.type === "database_id") return parent.database_id ?? null;
    if (parent.type === "block_id" && parent.block_id) {
      return this.resolveBlockToPageId(parent.block_id);
    }
    return null;
  }

  private async resolveBlockToPageId(blockId: string): Promise<string | null> {
    for (let i = 0; i < 10; i++) {
      try {
        const block = await this.notionClient.getBlock(blockId);
        const bp = (
          block as unknown as { parent: { type: string; page_id?: string; block_id?: string } }
        ).parent;
        if (bp.type === "page_id") return bp.page_id ?? null;
        if (bp.type === "block_id" && bp.block_id) {
          blockId = bp.block_id;
          continue;
        }
        return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private cleanupInterruptedSync(): void {
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
   * 한계(문서화): Notion 은 idempotency key 가 없어 "생성 요청 적용 직후 같은 호출 내 재시도"
   * 로 인한 중복은 완전히 차단하지 못한다. 429 는 적용 전 거절이라 안전하고, 프로세스 재시작
   * 후 재개는 본 검색-입양으로 중복을 막는다. DB 모드(부모가 database)는 child_page 검색이
   * 불가하므로 자리표시 제거 후 재생성으로 폴백한다.
   */
  private async recoverInterruptedPushOps(): Promise<void> {
    const ops = this.stateDb.getIncompletePendingOperations();
    if (ops.length === 0) return;

    for (const op of ops) {
      if (op.direction !== "push" || op.operation !== "create") {
        // 현재 WAL 재개는 create·push 만 대상. 그 외는 정리만 한다.
        this.stateDb.markPendingFailed(op.id, "unsupported resume op");
        continue;
      }

      let payload: { path?: string; parentId?: string; title?: string } = {};
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
      const adopted = parentId && title ? await this.findChildPageByTitle(parentId, title) : null;

      if (adopted) {
        // 고아 페이지 입양: 매핑만 채우고 pending 유지 → 다음 변경감지가 본문·이미지 마무리.
        this.stateDb.upsert({
          obsidianPath: path,
          notionPageId: adopted,
          notionParentId: parentId ?? null,
          contentHash: "",
          notionLastEdited: state?.notionLastEdited ?? null,
          localLastModified: new Date().toISOString(),
          syncDirection: state?.syncDirection ?? "both",
          fileType: state?.fileType ?? (this.isFolderNote(path) ? "folder-note" : "file"),
          status: "pending",
          baseSnapshot: null,
          localMtime: null,
          localFileSize: null,
        });
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

  /** 부모 페이지의 직속 자식 중 제목이 일치하는(보관/휴지통 제외) child_page id 를 찾는다. */
  private async findChildPageByTitle(parentId: string, title: string): Promise<string | null> {
    try {
      const children = await this.notionClient.fetchAllChildren(parentId);
      for (const b of children) {
        if (b.type !== "child_page") continue;
        const childTitle = (b as { child_page?: { title?: string } }).child_page?.title;
        if (childTitle !== title) continue;
        try {
          const page = await this.notionClient.getPage(b.id);
          const inTrash = (page as { in_trash?: boolean }).in_trash === true;
          if (inTrash || page.archived) continue;
        } catch {
          continue;
        }
        return b.id;
      }
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 고아 페이지 검색 실패 (${parentId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return null;
  }

  private async resolveUniqueFilePath(basePath: string): Promise<string> {
    if (!(await this.vaultFs.exists(basePath))) return basePath;

    const dir = basePath.lastIndexOf("/") >= 0 ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
    const ext = ".md";
    const name = basePath.slice(dir ? dir.length + 1 : 0, -ext.length);

    for (let i = 1; i <= 99; i++) {
      const candidate = dir ? `${dir}/${name} (${i})${ext}` : `${name} (${i})${ext}`;
      if (!(await this.vaultFs.exists(candidate))) return candidate;
    }

    return basePath;
  }
}

function extractTitle(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1] ?? "";
  return filename.replace(/\.md$/, "");
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
