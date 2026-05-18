import type { Config, DatabaseSyncConfig } from "../types/config.js";
import type { StateDB } from "../state/state-db.js";
import type { NotionClient } from "../notion/client.js";
import type { VaultFS } from "./vault-fs.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import type { FailedOperation } from "../types/sync.js";
import type { DatabaseViewsConfig } from "../types/view.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { PropertyMapper } from "../notion/property-mapper.js";
import type { ImageHandler } from "./image-handler.js";
import { computeHash } from "../utils/hash.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { getLogger } from "../utils/logger.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../converter/enhanced-md-converter.js";
import matter from "gray-matter";

export interface DatabaseSyncResult {
  created: number;
  updated: number;
  failed: FailedOperation[];
}

export class DatabaseSyncer {
  private readonly propertyMapper = new PropertyMapper();

  constructor(
    private readonly config: Config,
    private readonly stateDb: StateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
    private readonly pipeline: ConversionPipeline,
    private readonly imageHandler: ImageHandler,
  ) {
    this.propertyMapper.setWikilinkResolver({
      resolve: (title: string) => stateDb.resolveWikilink(title)?.notionPageId ?? null,
      resolvePageId: (pageId: string) => stateDb.resolvePageId(pageId)?.title ?? null,
    });
  }

  async pullAll(): Promise<DatabaseSyncResult> {
    const databases = this.config.notion.databases;
    if (!databases || databases.length === 0) {
      return { created: 0, updated: 0, failed: [] };
    }

    let created = 0;
    let updated = 0;
    const failed: FailedOperation[] = [];

    for (const dbConfig of databases) {
      try {
        const result = await this.pullDatabase(dbConfig);
        created += result.created;
        updated += result.updated;
        failed.push(...result.failed);
      } catch (error) {
        getLogger().warn(`[DB Sync] DB ${dbConfig.databaseId} pull 실패:`, error);
        failed.push({
          path: dbConfig.localFolder,
          operation: "create",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { created, updated, failed };
  }

  async pushAll(): Promise<DatabaseSyncResult> {
    const databases = this.config.notion.databases;
    if (!databases || databases.length === 0) {
      return { created: 0, updated: 0, failed: [] };
    }

    let created = 0;
    let updated = 0;
    const failed: FailedOperation[] = [];

    for (const dbConfig of databases) {
      try {
        const result = await this.pushDatabase(dbConfig);
        created += result.created;
        updated += result.updated;
        failed.push(...result.failed);
      } catch (error) {
        getLogger().warn(`[DB Sync] DB ${dbConfig.databaseId} push 실패:`, error);
        failed.push({
          path: dbConfig.localFolder,
          operation: "create",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { created, updated, failed };
  }

  private async pullDatabase(dbConfig: DatabaseSyncConfig): Promise<DatabaseSyncResult> {
    const schema = await this.notionClient.getDatabaseSchema(dbConfig.databaseId);
    this.propertyMapper.loadSchema(schema);

    await this.vaultFs.ensureFolder(dbConfig.localFolder);

    await this.pullDatabaseViews(dbConfig);

    const pages = await this.notionClient.queryAllDatabasePages(
      dbConfig.databaseId,
      dbConfig.pullFilter,
    );

    let created = 0;
    let updated = 0;
    const failed: FailedOperation[] = [];

    for (const page of pages) {
      try {
        const record = this.stateDb.getByNotionId(page.id);

        if (record) {
          if (page.last_edited_time === record.notionLastEdited) continue;
          await this.pullDatabasePage(page, dbConfig);
          updated++;
        } else {
          await this.pullDatabasePage(page, dbConfig);
          created++;
        }
      } catch (error) {
        failed.push({
          path: `${dbConfig.localFolder}/${page.id}`,
          operation: "create",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    getLogger().info(`[DB Sync] ${dbConfig.localFolder}: ${created} 생성, ${updated} 업데이트`);
    return { created, updated, failed };
  }

  private async pullDatabaseViews(dbConfig: DatabaseSyncConfig): Promise<void> {
    try {
      const viewsConfig = await this.notionClient.getDatabaseViewsConfig(dbConfig.databaseId);
      const configPath = ".im-nobsidian/db-views.json";
      await this.vaultFs.ensureFolder(".im-nobsidian");

      let allViewsConfigs: Record<string, DatabaseViewsConfig> = {};
      try {
        const existing = await this.vaultFs.readFile(configPath);
        allViewsConfigs = JSON.parse(existing) as Record<string, DatabaseViewsConfig>;
      } catch {
        // 파일 없으면 빈 객체
      }

      allViewsConfigs[dbConfig.databaseId] = viewsConfig;
      await this.vaultFs.writeFile(configPath, JSON.stringify(allViewsConfigs, null, 2));
      getLogger().info(
        `[DB Sync] 뷰 설정 ${viewsConfig.views.length}개 저장: ${dbConfig.databaseId}`,
      );
    } catch (error) {
      getLogger().warn(`[DB Sync] 뷰 설정 Pull 실패 (계속 진행):`, error);
    }
  }

  private async pullDatabasePage(
    page: PageObjectResponse,
    dbConfig: DatabaseSyncConfig,
  ): Promise<string> {
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const properties = this.propertyMapper.fromNotionProperties(
      (page as unknown as { properties: Record<string, unknown> }).properties,
    );
    properties.title = title;

    const cover = this.notionClient.extractCover(page);
    const icon = this.notionClient.extractIcon(page);

    if (cover) {
      try {
        const coverResult = await this.imageHandler.downloadAllImages(
          `![cover](${cover.url})`,
          `${safeName}-cover`,
        );
        const localUrlMatch = coverResult.content.match(/!\[cover\]\((.+?)\)/);
        if (localUrlMatch?.[1]) {
          properties.cover = localUrlMatch[1];
        } else {
          properties.cover = cover.url;
        }
      } catch {
        properties.cover = cover.url;
      }
    }

    if (icon) {
      properties.icon = icon.value;
    }

    let markdown = "";
    try {
      const mdResult = await this.notionClient.getPageMarkdown(page.id);
      markdown = notionEnhancedToObsidian(mdResult.markdown);
    } catch {
      // Markdown API 실패 시 빈 내용
    }

    if (this.config.conversion.imageDownload === "immediate" && markdown) {
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title);
      markdown = imageResult.content;
    }

    const existingRecord = this.stateDb.getByNotionId(page.id);
    const filePath = existingRecord?.obsidianPath ?? `${dbConfig.localFolder}/${safeName}.md`;

    const finalContent = this.pipeline.convertToMarkdown(
      markdown,
      {
        direction: "pull",
        path: "markdown-api",
        filePath,
        parentMode: "database",
      },
      { properties },
    );

    await this.vaultFs.ensureFolder(dbConfig.localFolder);
    await this.vaultFs.writeFile(filePath, finalContent);

    const hash = computeHash(finalContent);
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: filePath,
        notionPageId: page.id,
        notionParentId: dbConfig.databaseId,
        contentHash: hash,
        notionLastEdited: page.last_edited_time,
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType: "db-row",
        status: "synced",
        baseSnapshot: Buffer.from(finalContent, "utf-8"),
      });

      this.stateDb.upsertWikilink({
        obsidianPath: filePath,
        notionPageId: page.id,
        title,
        aliases: extractAliases(properties),
      });
    });

    return filePath;
  }

  private async pushDatabase(dbConfig: DatabaseSyncConfig): Promise<DatabaseSyncResult> {
    const schema = await this.notionClient.getDatabaseSchema(dbConfig.databaseId);
    this.propertyMapper.loadSchema(schema);

    const allFiles = await this.vaultFs.listMarkdownFiles();
    const prefix = dbConfig.localFolder.endsWith("/")
      ? dbConfig.localFolder
      : dbConfig.localFolder + "/";
    const dbFiles = allFiles.filter((f) => f.path.startsWith(prefix));

    let created = 0;
    let updated = 0;
    const failed: FailedOperation[] = [];

    for (const file of dbFiles) {
      try {
        const content = await this.vaultFs.readFile(file.path);
        const hash = computeHash(content);

        const record = this.stateDb.getByPath(file.path);
        if (record?.contentHash === hash) continue;

        const parsed = matter(content);
        const frontmatter = parsed.data as Record<string, unknown>;
        const body = parsed.content;

        const title = (frontmatter.title as string) ?? extractTitleFromPath(file.path);
        delete frontmatter.title;

        const notionProps = this.propertyMapper.toNotionProperties(frontmatter, title);
        const enhanced = obsidianToNotionEnhanced(body.trim());

        if (record?.notionPageId) {
          await this.notionClient.updatePageProperties(record.notionPageId, notionProps);

          try {
            await this.notionClient.replacePageMarkdown(record.notionPageId, enhanced);
          } catch {
            // Markdown API 실패 시 무시
          }

          const updatedPage = await this.notionClient.getPage(record.notionPageId);
          this.stateDb.transaction(() => {
            this.stateDb.updateHash(record.id, hash, Buffer.from(content, "utf-8"));
            this.stateDb.updateStatus(record.id, "synced");
            this.stateDb.setNotionLastEdited(record.id, updatedPage.last_edited_time);
          });
          updated++;
        } else {
          const page = await this.notionClient.createPageWithMarkdown({
            parentId: dbConfig.databaseId,
            parentType: "database",
            title,
            markdown: enhanced,
            properties: notionProps,
          });

          this.stateDb.transaction(() => {
            this.stateDb.upsert({
              obsidianPath: file.path,
              notionPageId: page.id,
              notionParentId: dbConfig.databaseId,
              contentHash: hash,
              notionLastEdited: page.last_edited_time,
              localLastModified: new Date().toISOString(),
              syncDirection: "both",
              fileType: "db-row",
              status: "synced",
              baseSnapshot: Buffer.from(content, "utf-8"),
            });

            this.stateDb.upsertWikilink({
              obsidianPath: file.path,
              notionPageId: page.id,
              title,
              aliases: extractAliases(frontmatter),
            });
          });
          created++;
        }
      } catch (error) {
        failed.push({
          path: file.path,
          operation: "create",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    getLogger().info(`[DB Sync] ${dbConfig.localFolder}: ${created} 생성, ${updated} 업데이트`);
    return { created, updated, failed };
  }
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

function extractTitleFromPath(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1] ?? "";
  return filename.replace(/\.md$/, "");
}
