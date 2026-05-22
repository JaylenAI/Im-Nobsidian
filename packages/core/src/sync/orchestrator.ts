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
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { Sema } from "async-sema";
import { ChangeDetector } from "./change-detector.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import { createDefaultPipeline } from "../converter/pipeline-factory.js";
import { BlockConverter } from "../converter/block-converter.js";
import { ImageHandler } from "./image-handler.js";
import { FileHandler } from "./file-handler.js";
import { DatabaseSyncer } from "./database-syncer.js";
import { PropertyMapper } from "../notion/property-mapper.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { notionIdsEqual } from "../utils/id.js";
import type { VaultFS } from "./vault-fs.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../converter/enhanced-md-converter.js";

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
    );
    this.fileHandler = new FileHandler(vaultFs, notionClient, stateDb);
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

    const sema = new Sema(this.config.advanced.concurrency);
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const failed: FailedOperation[] = [];

    let completed = 0;
    const total = filtered.length;

    const tasks = filtered.map((change) => async () => {
      await sema.acquire();
      try {
        if (options?.signal?.aborted) return;
        const op =
          change.type === "created"
            ? ("create" as const)
            : change.type === "deleted"
              ? ("delete" as const)
              : ("update" as const);
        options?.onProgress?.(++completed, total, { path: change.path, operation: op });
        switch (change.type) {
          case "created":
            await this.pushCreate(change.path);
            created++;
            break;
          case "modified":
            await this.pushUpdate(change.path);
            updated++;
            break;
          case "moved":
            await this.pushMove(change.path);
            updated++;
            break;
          case "deleted":
            await this.pushDelete(change.path);
            deleted++;
            break;
        }
      } catch (error) {
        failed.push({
          path: change.path,
          operation:
            change.type === "created" ? "create" : change.type === "deleted" ? "delete" : "update",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        sema.release();
      }
    });

    await Promise.all(tasks.map((t) => t()));

    if (failed.length > 0) {
      const retryTargets = failed.splice(0, failed.length);
      getLogger().info(`[Im-Nobsidian] Push ${retryTargets.length}건 재시도 (2초 후)`);
      await new Promise((r) => setTimeout(r, 2000));

      for (const target of retryTargets) {
        const change = filtered.find((c) => c.path === target.path);
        if (!change) {
          failed.push(target);
          continue;
        }
        try {
          switch (change.type) {
            case "created":
              await this.pushCreate(change.path);
              created++;
              break;
            case "modified":
              await this.pushUpdate(change.path);
              updated++;
              break;
            case "moved":
              await this.pushMove(change.path);
              updated++;
              break;
            case "deleted":
              await this.pushDelete(change.path);
              deleted++;
              break;
          }
          getLogger().info(`[Im-Nobsidian] 재시도 성공: ${change.path}`);
        } catch (error) {
          failed.push({
            path: change.path,
            operation: target.operation,
            error: error instanceof Error ? error.message : String(error),
          });
          getLogger().warn(`[Im-Nobsidian] 재시도 실패: ${change.path}`);
        }
      }
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
        created += dbResult.created;
        updated += dbResult.updated;
        failed.push(...dbResult.failed);
      } catch (error) {
        getLogger().warn("[Im-Nobsidian] DB Push 중 오류:", error);
      }
    }

    this.stateDb.setMeta("last_push_at", new Date().toISOString());
    this.stateDb.setMeta("last_sync_at", new Date().toISOString());
    this.stateDb.setMeta("push_in_progress", "");

    return { created, updated, deleted, failed, duration: Date.now() - startTime };
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

    let created = 0;
    let updated = 0;
    let deleted = 0;
    this._pullImageCount = 0;
    this._pullFileCount = 0;
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
      const hasDbResults = await this.pullDiscoveredDatabases(writtenPaths, failed);
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
        conflicts: [],
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

    const sema = new Sema(this.config.advanced.concurrency);

    let pullCompleted = 0;
    const pullTotal = filtered.length;

    const tasks = filtered.map((change) => async () => {
      await sema.acquire();
      try {
        if (options?.signal?.aborted) return;
        let resultPath: string | undefined;
        switch (change.type) {
          case "created": {
            const path = await this.pullCreate(change.pageId);
            writtenPaths.push(path);
            created++;
            resultPath = path;
            break;
          }
          case "modified": {
            const result = await this.pullUpdate(change);
            if (result.conflict) {
              conflicts.push(result.conflict);
            } else if (result.path) {
              writtenPaths.push(result.path);
              updated++;
            }
            resultPath = result.path;
            break;
          }
          case "deleted": {
            const record = this.stateDb.getByNotionId(change.pageId);
            resultPath = record?.obsidianPath;
            const path = await this.pullDelete(change.pageId);
            if (path) {
              deleted++;
              resultPath = path;
            }
            break;
          }
        }
        const record = this.stateDb.getByNotionId(change.pageId);
        const displayPath = resultPath ?? record?.obsidianPath ?? change.pageId;
        const op =
          change.type === "created"
            ? ("create" as const)
            : change.type === "deleted"
              ? ("delete" as const)
              : ("update" as const);
        options?.onProgress?.(++pullCompleted, pullTotal, { path: displayPath, operation: op });
      } catch (error) {
        const record = this.stateDb.getByNotionId(change.pageId);
        failed.push({
          path: record?.obsidianPath ?? change.pageId,
          operation:
            change.type === "created" ? "create" : change.type === "deleted" ? "delete" : "update",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        sema.release();
      }
    });

    await Promise.all(tasks.map((t) => t()));

    if (failed.length > 0) {
      const retryTargets = failed.splice(0, failed.length);
      getLogger().info(`[Im-Nobsidian] Pull ${retryTargets.length}건 재시도 (2초 후)`);
      await new Promise((r) => setTimeout(r, 2000));

      for (const target of retryTargets) {
        const change = filtered.find((c) => {
          const record = this.stateDb.getByNotionId(c.pageId);
          return (record?.obsidianPath ?? c.pageId) === target.path;
        });
        if (!change) {
          failed.push(target);
          continue;
        }
        try {
          switch (change.type) {
            case "created": {
              const path = await this.pullCreate(change.pageId);
              writtenPaths.push(path);
              created++;
              break;
            }
            case "modified": {
              const result = await this.pullUpdate(change);
              if (result.conflict) {
                conflicts.push(result.conflict);
              } else if (result.path) {
                writtenPaths.push(result.path);
                updated++;
              }
              break;
            }
            case "deleted": {
              const path = await this.pullDelete(change.pageId);
              if (path) deleted++;
              break;
            }
          }
          getLogger().info(`[Im-Nobsidian] 재시도 성공: ${target.path}`);
        } catch (error) {
          failed.push({
            path: target.path,
            operation: target.operation,
            error: error instanceof Error ? error.message : String(error),
          });
          getLogger().warn(`[Im-Nobsidian] 재시도 실패: ${target.path}`);
        }
      }
    }

    if ((this.config.notion.databases?.length ?? 0) > 0) {
      try {
        const dbResult = await this.databaseSyncer.pullAll();
        created += dbResult.created;
        updated += dbResult.updated;
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
      const dbDiscovery = await this.pullDiscoveredDatabases(writtenPaths, failed);
      created += dbDiscovery.created;
      updated += dbDiscovery.updated;
    }

    const linkTargetPaths = writtenPaths.length > 0 ? writtenPaths : [];
    const linkCount =
      linkTargetPaths.length > 0 ? await this.resolveNotionLinks(linkTargetPaths) : 0;

    this.stateDb.setMeta("last_pull_at", new Date().toISOString());
    this.stateDb.setMeta("last_sync_at", new Date().toISOString());
    this.stateDb.setMeta("pull_in_progress", "");

    return {
      created,
      updated,
      deleted,
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

  private async pullDiscoveredDatabases(
    writtenPaths: string[],
    failed: FailedOperation[],
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

      if (dbConfigs.length === 0) {
        const discoveredDbs = await this.discoverChildDatabases();
        const configuredIds = new Set(
          (this.config.notion.databases ?? []).map((d) => d.databaseId.replace(/-/g, "")),
        );
        const newDbs = discoveredDbs.filter((db) => !configuredIds.has(db.dbId.replace(/-/g, "")));
        for (const { dbId, parentPageId } of newDbs) {
          try {
            const dbTitle = await this.notionClient.getDatabaseTitle(dbId);
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
              safeName = parentName ? `${parentName}-DB` : `db-${dbId.slice(0, 8)}`;
            }
            if (!parentFolder) parentFolder = "databases";
            dbConfigs.push({
              databaseId: dbId,
              localFolder: `${parentFolder}/${safeName}`,
              titleProperty: "Name",
            });
          } catch (error) {
            getLogger().warn(`[Im-Nobsidian] 자동 발견 DB ${dbId} 동기화 실패:`, error);
          }
        }
        if (dbConfigs.length > 0) {
          this.stateDb.setMeta("discovered_dbs", JSON.stringify(dbConfigs));
        }
      }

      for (const dbConfig of dbConfigs) {
        try {
          const dbResult = await this.databaseSyncer.pullDatabase(dbConfig);
          created += dbResult.created;
          updated += dbResult.updated;
          failed.push(...dbResult.failed);
          if (dbResult.created + dbResult.updated > 0) {
            const dbPaths = this.stateDb
              .getByStatus("synced")
              .filter((r) => r.fileType === "db-row")
              .map((r) => r.obsidianPath);
            writtenPaths.push(...dbPaths.slice(-dbResult.created - dbResult.updated));
          }
        } catch (error) {
          getLogger().warn(`[Im-Nobsidian] DB ${dbConfig.databaseId} 동기화 실패:`, error);
        }
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

        const resolved2 = content.replace(
          /\[([^\]]+)\]\(\/([a-f0-9]{32})\?pvs=\d+\)/g,
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

    const page = await this.pushCreatePage(
      effectiveParentId,
      effectiveParentType,
      title,
      conversionResult.content,
      effectiveProperties,
    );

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

  private async pushDelete(path: string): Promise<void> {
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return;

    if (this.config.sync.deleteSync) {
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
      this.stateDb.delete(record.id);
    } else {
      this.stateDb.updateStatus(record.id, "pending");
    }
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
      remotePages = await this.notionClient.getChildPagesRecursive(this.config.notion.rootPageId);
    }

    for (const page of remotePages) {
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
    const recentPages = await this.notionClient.searchRecentPages(since);

    for (const page of recentPages) {
      const record = this.stateDb.getByNotionId(page.id);
      if (!record) {
        try {
          const fullPage = await this.notionClient.getPage(page.id);
          const parentId = await this.extractParentId(fullPage);
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

  private async pullCreate(pageId: string): Promise<string> {
    const page = await this.notionClient.getPage(pageId);
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const parentPath = await this.resolveParentPath(page);

    const firstChildren = await this.notionClient.listChildren(pageId, { pageSize: 100 });
    const hasChildPages = firstChildren.results.some((b) => "type" in b && b.type === "child_page");

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

    await this.vaultFs.writeFile(filePath, finalContent);

    const hash = computeHash(finalContent);
    const pullStat = await this.vaultFs.getFileStat(filePath);
    const resolvedParentId = await this.extractParentId(page);
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

    const localHash = computeHash(localContent);
    const localModified = localHash !== record.contentHash;

    if (localModified) {
      const strategy = this.config.sync.conflictStrategy;

      if (strategy === "remote-first") {
        // 리모트 우선: 로컬 변경 무시, 리모트 내용으로 덮어쓰기
      } else if (strategy === "local-first") {
        return { path: record.obsidianPath };
      } else {
        const conflict: Conflict = {
          syncRecord: record,
          localChange: {
            path: record.obsidianPath,
            type: "modified",
            currentHash: localHash,
            previousHash: record.contentHash,
          },
          remoteChange: change,
          baseContent: record.baseSnapshot?.toString("utf-8") ?? null,
          localContent,
          remoteContent,
        };

        this.stateDb.updateStatus(record.id, "conflict");
        return { conflict };
      }
    }

    await this.vaultFs.writeFile(record.obsidianPath, remoteContent);

    const updateStat = await this.vaultFs.getFileStat(record.obsidianPath);
    const newHash = computeHash(remoteContent);
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

    this.stateDb.delete(record.id);
    return record.obsidianPath;
  }

  private async ensureFolderPage(folderPath: string): Promise<void> {
    const folderNotePath = `${folderPath}/${folderPath.split("/").pop()}.md`;
    const folderNoteRecord = this.stateDb.getByPath(folderNotePath);

    if (folderNoteRecord?.notionPageId) {
      const existing = this.stateDb.getByPath(folderPath);
      if (existing) this.stateDb.delete(existing.id);
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
        this.stateDb.delete(folder.id);
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

  private async pushUpdatePage(
    pageId: string,
    markdownContent: string,
    _baseSnapshot?: Buffer | null,
  ): Promise<void> {
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
        return notionEnhancedToObsidian(result.markdown);
      } catch {
        // Markdown API 실패 시 blocks API fallback
      }
    }
    return this.blockConverter.notionBlocksToMarkdown(pageId);
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
