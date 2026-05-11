import type {
  PushOptions,
  PushResult,
  PullOptions,
  PullResult,
  SyncOptions,
  SyncResult,
  StatusResult,
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
import { ConversionPipeline } from "../converter/pipeline.js";
import { FrontmatterExtractor } from "../converter/pre-processors/frontmatter.js";
import { WikilinkResolver } from "../converter/pre-processors/wikilink.js";
import { CalloutTransformer } from "../converter/pre-processors/callout.js";
import { MathNormalizer } from "../converter/pre-processors/math.js";
import { EmbedResolver } from "../converter/pre-processors/embed.js";
import { PreserveMarkerCollector } from "../converter/pre-processors/preserve-marker.js";
import { MentionToWikilink } from "../converter/post-processors/mention-to-wikilink.js";
import { PreserveMarkerInjector } from "../converter/post-processors/preserve-marker-injector.js";
import { CalloutRestorer } from "../converter/post-processors/callout-restorer.js";
import { ColorAnnotator } from "../converter/post-processors/color-annotator.js";
import { FrontmatterGenerator } from "../converter/post-processors/frontmatter-generator.js";
import { LocalImageRestorer } from "../converter/post-processors/local-image-restorer.js";
import { BlockConverter } from "../converter/block-converter.js";
import { ImageHandler } from "./image-handler.js";
import { computeHash } from "../utils/hash.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { notionIdsEqual } from "../utils/id.js";
import type { VaultFS } from "./vault-fs.js";

export class SyncOrchestrator {
  private readonly changeDetector: ChangeDetector;
  private readonly pipeline: ConversionPipeline;
  private readonly blockConverter: BlockConverter;
  private readonly imageHandler: ImageHandler;

  constructor(
    private readonly config: Config,
    private readonly stateDb: StateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
  ) {
    this.changeDetector = new ChangeDetector(stateDb);
    this.pipeline = new ConversionPipeline();
    this.blockConverter = new BlockConverter();
    this.imageHandler = new ImageHandler(vaultFs, config.paths.attachments);

    this.pipeline.registerPreProcessor(new FrontmatterExtractor());
    this.pipeline.registerPreProcessor(new WikilinkResolver());
    this.pipeline.registerPreProcessor(new CalloutTransformer());
    this.pipeline.registerPreProcessor(new MathNormalizer());
    this.pipeline.registerPreProcessor(new EmbedResolver());
    this.pipeline.registerPreProcessor(new PreserveMarkerCollector());

    this.pipeline.registerPostProcessor(new LocalImageRestorer());
    this.pipeline.registerPostProcessor(new PreserveMarkerInjector());
    this.pipeline.registerPostProcessor(new MentionToWikilink());
    this.pipeline.registerPostProcessor(new CalloutRestorer());
    this.pipeline.registerPostProcessor(new ColorAnnotator());
    this.pipeline.registerPostProcessor(new FrontmatterGenerator());

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

    return {
      localChanges,
      remoteChanges,
      conflicts: [],
      conflictRecords,
      pendingOperations: conflictRecords.length,
      lastSyncAt,
    };
  }

  private async pushCreate(path: string): Promise<void> {
    const content = await this.vaultFs.readFile(path);
    const title = extractTitle(path);
    const parentId = await this.resolveNotionParent(path);

    const selectedPath = this.pipeline.selectPath(content);
    if (selectedPath === "block-api") {
      console.warn(
        `[ObsiNotion] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
      );
    }

    const conversionResult = this.pipeline.convertToNotion(content, {
      direction: "push",
      path: selectedPath,
      filePath: path,
    });

    const blocks = this.blockConverter.markdownToNotionBlocks(conversionResult.content);

    const page = await this.notionClient.createPage({
      parentId,
      parentType: "page",
      title,
      properties: conversionResult.properties,
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
      console.warn(
        `[ObsiNotion] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
      );
    }

    const conversionResult = this.pipeline.convertToNotion(content, {
      direction: "push",
      path: updatePath,
      filePath: path,
    });

    const blocks = this.blockConverter.markdownToNotionBlocks(conversionResult.content);

    const existingBlocks = await this.notionClient.fetchAllChildren(record.notionPageId);

    if (blocks.length > 0) {
      await this.notionClient.appendChildren(record.notionPageId, blocks);
    }

    for (const block of existingBlocks) {
      await this.notionClient.deleteBlock(block.id);
    }

    if (conversionResult.properties && Object.keys(conversionResult.properties).length > 0) {
      await this.notionClient.updatePageProperties(
        record.notionPageId,
        conversionResult.properties,
      );
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

    const remotePages = await this.notionClient.getChildPagesRecursive(
      this.config.notion.rootPageId,
    );

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

    const properties = this.notionClient.extractProperties(page);

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
    const properties = this.notionClient.extractProperties(page);

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

  private async resolveNotionParent(filePath: string): Promise<string> {
    const parts = filePath.split("/");
    if (parts.length <= 1) return this.config.notion.rootPageId;

    const folderParts = parts.slice(0, -1);

    for (let i = folderParts.length; i > 0; i--) {
      const folderPath = folderParts.slice(0, i).join("/");
      const folderName = folderParts[i - 1]!;

      const folderNotePath = `${folderPath}/${folderName}.md`;
      const folderRecord = this.stateDb.getByPath(folderNotePath);
      if (folderRecord?.notionPageId) return folderRecord.notionPageId;

      const records = this.stateDb.getAll();
      const parentRecord = records.find(
        (r) =>
          r.notionPageId &&
          r.obsidianPath.startsWith(folderPath + "/") &&
          r.fileType === "folder-note",
      );
      if (parentRecord?.notionPageId) return parentRecord.notionPageId;
    }

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
