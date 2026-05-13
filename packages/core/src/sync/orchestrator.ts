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
import type { StateDB } from "../state/state-db.js";
import type { NotionClient } from "../notion/client.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { Sema } from "async-sema";
import { ChangeDetector } from "./change-detector.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import { createDefaultPipeline } from "../converter/pipeline-factory.js";
import { BlockConverter } from "../converter/block-converter.js";
import { ImageHandler } from "./image-handler.js";
import { PropertyMapper } from "../notion/property-mapper.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { notionIdsEqual } from "../utils/id.js";
import type { VaultFS } from "./vault-fs.js";

export class SyncOrchestrator {
  private readonly changeDetector: ChangeDetector;
  private readonly pipeline: ConversionPipeline;
  private readonly blockConverter: BlockConverter;
  private readonly imageHandler: ImageHandler;
  private readonly propertyMapper: PropertyMapper;
  private dbSchemaLoaded = false;

  constructor(
    private readonly config: Config,
    private readonly stateDb: StateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
  ) {
    this.changeDetector = new ChangeDetector(stateDb);
    this.pipeline = createDefaultPipeline();
    this.blockConverter = new BlockConverter();
    this.imageHandler = new ImageHandler(vaultFs, config.paths.attachments);
    this.propertyMapper = new PropertyMapper();

    this.blockConverter.initNotionToMd(this.notionClient.getInternalClient());
  }

  async push(options?: PushOptions): Promise<PushResult> {
    const startTime = Date.now();
    const files = await this.vaultFs.listMarkdownFiles();
    const changes = this.changeDetector.detectLocalChanges(files);

    const conflictPaths = new Set(this.stateDb.getByStatus("conflict").map((r) => r.obsidianPath));
    const nonConflict = changes.filter((c) => !conflictPaths.has(c.path));

    const filtered = options?.paths
      ? nonConflict.filter((c) => options.paths!.some((p) => c.path.startsWith(p)))
      : nonConflict;

    if (filtered.length === 0) {
      return { created: 0, updated: 0, deleted: 0, failed: [], duration: Date.now() - startTime };
    }

    if (options?.dryRun) {
      return { created: 0, updated: 0, deleted: 0, failed: [], duration: Date.now() - startTime };
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
        options?.onProgress?.(++completed, total, change.path);
        switch (change.type) {
          case "created":
            await this.pushCreate(change.path);
            created++;
            break;
          case "modified":
          case "moved":
            await this.pushUpdate(change.path);
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

    this.stateDb.setMeta("last_push_at", new Date().toISOString());
    this.stateDb.setMeta("last_sync_at", new Date().toISOString());
    this.stateDb.setMeta("push_in_progress", "");

    return { created, updated, deleted, failed, duration: Date.now() - startTime };
  }

  async pull(options?: PullOptions): Promise<PullResult> {
    const startTime = Date.now();
    let created = 0;
    let updated = 0;
    let deleted = 0;
    const conflicts: Conflict[] = [];
    const writtenPaths: string[] = [];
    const failed: FailedOperation[] = [];

    const remoteChanges = await this.detectRemoteChanges();

    const filtered = options?.paths
      ? remoteChanges.filter((c) => {
          const record = this.stateDb.getByNotionId(c.pageId);
          return record && options.paths!.some((p) => record.obsidianPath.startsWith(p));
        })
      : remoteChanges;

    if (options?.dryRun || filtered.length === 0) {
      return {
        created: 0,
        updated: 0,
        deleted: 0,
        conflicts: [],
        writtenPaths: [],
        failed: [],
        duration: Date.now() - startTime,
      };
    }

    this.stateDb.setMeta("pull_in_progress", "true");

    const sema = new Sema(this.config.advanced.concurrency);

    let pullCompleted = 0;
    const pullTotal = filtered.length;

    const tasks = filtered.map((change) => async () => {
      await sema.acquire();
      try {
        options?.onProgress?.(++pullCompleted, pullTotal, change.pageId);
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
            if (path) {
              deleted++;
            }
            break;
          }
        }
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
    };
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const pullResult = await this.pull(options);
    const pushResult = await this.push({
      ...options,
      paths: options?.paths,
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
    const remoteChanges = await this.detectRemoteChanges();
    const conflictRecords = this.stateDb.getByStatus("conflict");
    const lastSyncAt = this.stateDb.getMeta("last_sync_at");

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

      conflicts.push({
        syncRecord: record,
        localChange,
        remoteChange,
        baseContent: record.baseSnapshot?.toString("utf-8") ?? null,
        localContent,
        remoteContent: "",
      });
    }

    return conflicts;
  }

  private get isDatabaseMode(): boolean {
    return this.config.notion.parentMode === "database" && !!this.config.notion.databaseId;
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

    const blocks = this.blockConverter.markdownToNotionBlocks(conversionResult.content);

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

    const page = await this.notionClient.createPage({
      parentId: effectiveParentId,
      parentType: effectiveParentType,
      title,
      properties: effectiveProperties,
    });

    if (blocks.length > 0) {
      await this.notionClient.appendChildren(page.id, blocks);
    }

    const hash = computeHash(content);

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
      });

      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: page.id,
        title,
        aliases: [],
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

    const blocks = this.blockConverter.markdownToNotionBlocks(conversionResult.content);

    const existingBlocks = await this.notionClient.fetchAllChildren(record.notionPageId);

    if (blocks.length > 0) {
      await this.notionClient.appendChildren(record.notionPageId, blocks);
    }

    for (const block of existingBlocks) {
      await this.notionClient.deleteBlock(block.id);
    }

    let propsToUpdate = conversionResult.properties;
    if (this.isDatabaseMode && propsToUpdate && Object.keys(propsToUpdate).length > 0) {
      await this.ensureDbSchema();
      const title = extractTitle(path);
      propsToUpdate = this.propertyMapper.toNotionProperties(propsToUpdate, title);
    }

    if (propsToUpdate && Object.keys(propsToUpdate).length > 0) {
      await this.notionClient.updatePageProperties(record.notionPageId, propsToUpdate);
    }

    const hash = computeHash(content);
    this.stateDb.transaction(() => {
      this.stateDb.updateHash(record.id, hash, Buffer.from(content, "utf-8"));
      this.stateDb.updateStatus(record.id, "synced");
      this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
    });
  }

  private async pushDelete(path: string): Promise<void> {
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return;

    if (this.config.sync.deleteSync) {
      await this.notionClient.archivePage(record.notionPageId);
    }

    this.stateDb.delete(record.id);
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

  private async pullCreate(pageId: string): Promise<string> {
    const page = await this.notionClient.getPage(pageId);
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const parentPath = await this.resolveParentPath(page);

    const children = await this.notionClient.listChildren(pageId, { pageSize: 1 });
    const hasChildPages = children.results.some((b) => "type" in b && b.type === "child_page");

    const markdown = await this.blockConverter.notionBlocksToMarkdown(pageId);
    const hasContent = markdown.trim().length > 0;

    let filePath: string;
    let fileType: "file" | "folder-note" | "folder-only";

    if (hasChildPages && hasContent) {
      const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
      filePath = `${folderPath}/${safeName}.md`;
      fileType = "folder-note";
      await this.vaultFs.ensureFolder(folderPath);
    } else if (hasChildPages && !hasContent) {
      const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
      filePath = `${folderPath}/${safeName}.md`;
      fileType = "folder-only";
      await this.vaultFs.ensureFolder(folderPath);
    } else {
      filePath = parentPath ? `${parentPath}/${safeName}.md` : `${safeName}.md`;
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

    let processedMarkdown = markdown;
    if (this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title);
      processedMarkdown = imageResult.content;
    }

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
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: filePath,
        notionPageId: pageId,
        notionParentId: this.extractParentId(page),
        contentHash: hash,
        notionLastEdited: page.last_edited_time,
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType,
        status: "synced",
        baseSnapshot: Buffer.from(finalContent, "utf-8"),
      });

      this.stateDb.upsertWikilink({
        obsidianPath: filePath,
        notionPageId: pageId,
        title,
        aliases: [],
      });
    });

    return filePath;
  }

  private async pullUpdate(change: RemoteChange): Promise<{ path?: string; conflict?: Conflict }> {
    const record = this.stateDb.getByNotionId(change.pageId);
    if (!record) return {};

    const page = await this.notionClient.getPage(change.pageId);
    let markdown = await this.blockConverter.notionBlocksToMarkdown(change.pageId);

    let properties: Record<string, unknown>;
    if (this.isDatabaseMode) {
      await this.ensureDbSchema();
      properties = this.propertyMapper.fromNotionProperties(
        (page as unknown as { properties: Record<string, unknown> }).properties,
      );
    } else {
      properties = this.notionClient.extractProperties(page);
    }

    if (this.config.conversion.imageDownload === "immediate") {
      const title = this.notionClient.extractTitle(page);
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title);
      markdown = imageResult.content;
    }

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

    await this.vaultFs.writeFile(record.obsidianPath, remoteContent);

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
    const existing = this.stateDb.getByPath(folderPath);
    if (existing?.notionPageId) return;

    const parts = folderPath.split("/");
    const folderName = parts[parts.length - 1]!;

    let parentId = this.config.notion.rootPageId;
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join("/");
      const parentRecord = this.stateDb.getByPath(parentPath);
      if (parentRecord?.notionPageId) {
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

    return this.config.notion.rootPageId;
  }

  private isFolderNote(filePath: string): boolean {
    const parts = filePath.split("/");
    if (parts.length < 2) return false;
    const fileName = parts[parts.length - 1]!.replace(/\.md$/, "");
    const folderName = parts[parts.length - 2]!;
    return fileName === folderName;
  }

  private async resolveParentPath(page: PageObjectResponse): Promise<string> {
    const parentId = this.extractParentId(page);
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
      return sanitizeFileName(parentTitle);
    } catch {
      return "";
    }
  }

  private extractParentId(page: PageObjectResponse): string | null {
    const parent = page.parent as { type: string; page_id?: string; database_id?: string };
    if (parent.type === "page_id") return parent.page_id ?? null;
    if (parent.type === "database_id") return parent.database_id ?? null;
    return null;
  }
}

function extractTitle(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1] ?? "";
  return filename.replace(/\.md$/, "");
}
