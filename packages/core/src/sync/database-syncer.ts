import type { Config, DatabaseSyncConfig } from "../types/config.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { NotionClient } from "../notion/client.js";
import type { VaultFS } from "./vault-fs.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import type { Conflict, FailedOperation, SyncRecord } from "../types/sync.js";
import type { DatabaseViewsConfig } from "../types/view.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { PropertyMapper } from "../notion/property-mapper.js";
import type { ImageHandler } from "./image-handler.js";
import { resolvePullConflict } from "./conflict-detector.js";
import { computeHash } from "../utils/hash.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { resolveDbRowPath, selectDbRowFiles } from "../utils/db-row-path.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { getLogger } from "../utils/logger.js";
import { BaseFileGenerator } from "../view/base-file-generator.js";
import { SidecarGenerator } from "../view/sidecar-generator.js";
import { selectStaleDbArtifacts } from "./stale-db-artifacts.js";
import { INTERNAL_DIR, DB_VIEWS_PATH } from "../constants/paths.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../converter/enhanced-md-converter.js";
import { isCompactExport } from "../converter/post-processors/block-spacer.js";
import matter from "gray-matter";

export interface DatabaseSyncResult {
  created: number;
  updated: number;
  /** Pull 시 로컬·리모트 동시 수정으로 발생한 충돌 (push 는 항상 빈 배열). */
  conflicts: Conflict[];
  failed: FailedOperation[];
  /**
   * 이번 pull 에서 실제로 디스크에 기록한 db-row 파일 경로(SSOT).
   * 오케스트레이터의 링크 해소(resolveNotionLinks) 대상은 반드시 이 목록으로 정한다 —
   * 과거의 `getByStatus("synced").slice(-N)` 휴리스틱은 ORDER BY 가 없어 증분 pull 에서
   * 엉뚱한 행을 골라 정작 바뀐 행의 relation UUID 를 영영 해소하지 못했다(M3). push 경로는 항상 빈 배열.
   */
  writtenPaths: string[];
}

/** {@link DatabaseSyncer.pullDatabasePage} 의 처리 결과. */
type PullPageOutcome =
  | { action: "written"; path: string }
  | { action: "skipped"; path: string }
  | { action: "conflict"; path: string; conflict: Conflict };

export class DatabaseSyncer {
  private readonly propertyMapper = new PropertyMapper();
  private readonly baseFileGenerator = new BaseFileGenerator();
  private readonly sidecarGenerator = new SidecarGenerator();

  /**
   * 이번 프로세스가 실제로 기록한 .base 경로/DB 제목 (databaseId nohyph → info).
   * placeholder 임베드 재작성(F22)의 SSOT — 폴더명(하이픈 새니타이즈)과 .base 파일명
   * (sanitizeFileName: 공백·점 보존)은 규칙이 달라 localFolder 로 추측한 경로는 깨진
   * 임베드가 된다. generateBaseFile 은 매 pull 모든 DB 에 대해 실행되므로 pull 종료
   * 시점에는 성공한 DB 전체가 채워져 있다.
   */
  readonly baseFileInfo = new Map<string, { basePath: string; title: string }>();

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
    private readonly pipeline: ConversionPipeline,
    private readonly imageHandler: ImageHandler,
  ) {
    this.propertyMapper.setWikilinkResolver({
      resolve: (title: string) => stateDb.resolveWikilink(title)?.notionPageId ?? null,
      // M4: 후처리 패스(resolveNotionLinks)와 동일하게 파일 basename 으로 해소 — 원시 제목과
      // sanitize 된 파일명의 불일치로 인한 깨진/이중 위키링크 차단.
      resolvePageId: (pageId: string) => {
        const entry = stateDb.resolvePageId(pageId);
        return entry ? wikilinkTitleFromPath(entry.obsidianPath) : null;
      },
    });
  }

  async pullAll(): Promise<DatabaseSyncResult> {
    const databases = this.config.notion.databases;
    if (!databases || databases.length === 0) {
      return { created: 0, updated: 0, conflicts: [], failed: [], writtenPaths: [] };
    }

    let created = 0;
    let updated = 0;
    const conflicts: Conflict[] = [];
    const failed: FailedOperation[] = [];
    const writtenPaths: string[] = [];

    for (const dbConfig of databases) {
      try {
        const result = await this.pullDatabase(dbConfig);
        created += result.created;
        updated += result.updated;
        conflicts.push(...result.conflicts);
        failed.push(...result.failed);
        writtenPaths.push(...result.writtenPaths);
      } catch (error) {
        getLogger().warn(`[DB Sync] DB ${dbConfig.databaseId} pull 실패:`, error);
        failed.push({
          path: dbConfig.localFolder,
          operation: "create",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { created, updated, conflicts, failed, writtenPaths };
  }

  async pushAll(): Promise<DatabaseSyncResult> {
    const databases = this.config.notion.databases;
    if (!databases || databases.length === 0) {
      return { created: 0, updated: 0, conflicts: [], failed: [], writtenPaths: [] };
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

    return { created, updated, conflicts: [], failed, writtenPaths: [] };
  }

  async pullDatabase(dbConfig: DatabaseSyncConfig): Promise<DatabaseSyncResult> {
    const schema = await this.notionClient.getDatabaseSchema(dbConfig.databaseId);
    this.propertyMapper.loadSchema(schema);

    await this.vaultFs.ensureFolder(dbConfig.localFolder);

    const viewsConfig = await this.pullDatabaseViews(dbConfig);
    await this.generateBaseFile(dbConfig, viewsConfig);

    const pages = await this.notionClient.queryAllDatabasePages(
      dbConfig.databaseId,
      dbConfig.pullFilter,
    );

    let created = 0;
    let updated = 0;
    const conflicts: Conflict[] = [];
    const failed: FailedOperation[] = [];
    // M3: 실제로 디스크에 기록된 DB 행 경로 — 후처리 링크 해소(resolveNotionLinks)가
    // 정확히 이 파일들만 재방문하도록 슬라이스 추정 대신 실측 수집한다.
    const writtenPaths: string[] = [];

    for (const page of pages) {
      try {
        const record = this.stateDb.getByNotionId(page.id);

        if (record) {
          // 리모트가 마지막 동기화 시점과 동일하면 건너뜀.
          if (page.last_edited_time === record.notionLastEdited) continue;
          const outcome = await this.pullDatabasePage(page, dbConfig);
          if (outcome.action === "written") {
            updated++;
            writtenPaths.push(outcome.path);
          } else if (outcome.action === "conflict") {
            conflicts.push(outcome.conflict);
          }
          // skipped(local-first): 카운트하지 않음
        } else {
          const outcome = await this.pullDatabasePage(page, dbConfig);
          created++;
          if (outcome.action === "written") {
            writtenPaths.push(outcome.path);
          }
        }
      } catch (error) {
        failed.push({
          path: `${dbConfig.localFolder}/${page.id}`,
          operation: "create",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    getLogger().debug(
      `[DB Sync] ${dbConfig.localFolder}: ${created} 생성, ${updated} 업데이트, ${conflicts.length} 충돌`,
    );
    return { created, updated, conflicts, failed, writtenPaths };
  }

  private async pullDatabaseViews(
    dbConfig: DatabaseSyncConfig,
    force = false,
  ): Promise<DatabaseViewsConfig | null> {
    try {
      const configPath = DB_VIEWS_PATH;

      if (!force) {
        try {
          const existing = await this.vaultFs.readFile(configPath);
          const parsed = JSON.parse(existing) as Record<string, DatabaseViewsConfig>;
          if (parsed[dbConfig.databaseId]) return parsed[dbConfig.databaseId]!;
        } catch {
          // 파일 없으면 계속 진행
        }
      }

      const viewsConfig = await this.notionClient.getDatabaseViewsConfig(dbConfig.databaseId);
      await this.vaultFs.ensureFolder(INTERNAL_DIR);

      let allViewsConfigs: Record<string, DatabaseViewsConfig> = {};
      try {
        const existing = await this.vaultFs.readFile(configPath);
        allViewsConfigs = JSON.parse(existing) as Record<string, DatabaseViewsConfig>;
      } catch {
        // 파일 없으면 빈 객체
      }

      allViewsConfigs[dbConfig.databaseId] = viewsConfig;
      await this.vaultFs.writeFile(configPath, JSON.stringify(allViewsConfigs, null, 2));
      getLogger().debug(
        `[DB Sync] 뷰 설정 ${viewsConfig.views.length}개 저장: ${dbConfig.databaseId}`,
      );
      return viewsConfig;
    } catch (error) {
      getLogger().warn(`[DB Sync] 뷰 설정 Pull 실패 (계속 진행):`, error);
      return null;
    }
  }

  private async generateBaseFile(
    dbConfig: DatabaseSyncConfig,
    viewsConfig: DatabaseViewsConfig | null,
  ): Promise<void> {
    try {
      const schemaFull = await this.notionClient.getDatabaseSchemaFull(dbConfig.databaseId);
      const dbName =
        viewsConfig?.databaseName ||
        (await this.notionClient.getDatabaseTitle(dbConfig.databaseId)) ||
        dbConfig.localFolder.split("/").pop() ||
        "Database";

      const resolvedViews: DatabaseViewsConfig = viewsConfig ?? {
        databaseId: dbConfig.databaseId,
        databaseName: dbName,
        lastSynced: new Date().toISOString(),
        views: [{ id: "default", name: "Table", type: "table" }],
      };

      const baseContent = this.baseFileGenerator.generate({
        databaseId: dbConfig.databaseId,
        databaseName: dbName,
        schema: schemaFull,
        viewsConfig: resolvedViews,
        folderPath: dbConfig.localFolder,
      });

      const safeName = sanitizeFileName(dbName);
      const basePath = `${dbConfig.localFolder}/${safeName}.base`;
      await this.vaultFs.writeFile(basePath, baseContent);
      this.baseFileInfo.set(dbConfig.databaseId.replace(/-/g, ""), { basePath, title: dbName });
      getLogger().debug(`[DB Sync] .base 파일 생성: ${basePath}`);

      await this.generateSidecar(dbConfig, dbName, safeName, schemaFull, resolvedViews);
      await this.cleanupStaleDbArtifacts(dbConfig.localFolder, safeName);
    } catch (error) {
      getLogger().warn(`[DB Sync] .base 파일 생성 실패 (계속 진행):`, error);
    }
  }

  /**
   * DB 제목이 바뀌면 `.base`/`.notion.json` 파일명(safeName)이 바뀌어 옛 이름의 산출물이
   * 같은 폴더에 고아로 잔존한다(drift·부활 원인). DB 폴더 **직속**의 산출물 중 현재 이름이
   * 아닌 것을 삭제해 멱등을 보장한다. 하위 폴더(중첩 DB)의 산출물은 보호한다.
   */
  private async cleanupStaleDbArtifacts(localFolder: string, safeName: string): Promise<void> {
    try {
      const keep = new Set([
        `${localFolder}/${safeName}.base`,
        `${localFolder}/${safeName}.notion.json`,
      ]);
      const files = await this.vaultFs.listNonMarkdownFiles();
      const stale = selectStaleDbArtifacts(files, localFolder, keep);
      for (const path of stale) {
        await this.vaultFs.deleteFile(path);
        getLogger().info(`[DB Sync] 고아 DB 산출물 삭제(rename): ${path}`);
      }
    } catch (error) {
      getLogger().warn(`[DB Sync] 고아 .base/.notion.json 정리 실패 (계속 진행):`, error);
    }
  }

  /**
   * `.base` 가 표현하지 못하는 Notion DB 메타데이터(미지원 뷰·필터식·커버크기 등)를
   * 사이드카 `<db>.notion.json` 으로 무손실 보존하고, degrade 된 항목을 정직하게 로그한다.
   * 결정적 직렬화라 동일 DB 상태 → 동일 바이트 → 멱등(drift/churn 0).
   */
  private async generateSidecar(
    dbConfig: DatabaseSyncConfig,
    dbName: string,
    safeName: string,
    schemaFull: Record<string, { id: string; type: string; options?: Array<{ name: string }> }>,
    resolvedViews: DatabaseViewsConfig,
  ): Promise<void> {
    try {
      const sidecar = this.sidecarGenerator.build({
        databaseId: dbConfig.databaseId,
        databaseName: dbName,
        schema: schemaFull,
        viewsConfig: resolvedViews,
      });
      const sidecarPath = `${dbConfig.localFolder}/${safeName}.notion.json`;
      await this.vaultFs.writeFile(sidecarPath, this.sidecarGenerator.serialize(sidecar));

      if (sidecar.degraded.length > 0) {
        const unrep = sidecar.degraded.filter((d) => d.kind === "view-unrepresentable").length;
        const dropped = sidecar.degraded.length - unrep;
        getLogger().info(
          `[DB Sync] '${dbName}' degrade ${sidecar.degraded.length}건` +
            ` (미표현 뷰 ${unrep} · 미표현 설정 ${dropped}) → ${safeName}.notion.json 보존`,
        );
      }
    } catch (error) {
      getLogger().warn(`[DB Sync] 사이드카 생성 실패 (계속 진행):`, error);
    }
  }

  /**
   * DB 행 `files` 속성의 notion-hosted 서명 URL 을 로컬 첨부로 로컬라이즈한다(P3-A).
   * 서명 URL 은 약 1시간 뒤 만료되어 frontmatter 에 남으면 깨진 링크가 되고, push 로
   * 되밀면 Notion 원본이 만료 URL 의 external 파일로 오염된다(실측). 다운로드 성공분은
   * `[[attachments/..]]` 위키링크로 대체한다 — Bases 카드 `image:` 는 위키링크 스칼라를
   * 렌더하므로 갤러리 커버도 유지된다. 원본 파일명은 raw 속성의 `name` 에서 취한다
   * (extractValue 는 URL 만 남긴다). 사용자가 넣은 진짜 외부 URL 은 그대로 둔다.
   */
  private async localizeFileProperties(
    rawProps: Record<string, unknown>,
    properties: Record<string, unknown>,
    safeName: string,
  ): Promise<void> {
    for (const [key, rawProp] of Object.entries(rawProps)) {
      const prop = rawProp as {
        type?: string;
        files?: Array<{
          name?: string;
          type?: string;
          file?: { url?: string };
          external?: { url?: string };
        }>;
      };
      if (prop?.type !== "files" || !Array.isArray(prop.files) || prop.files.length === 0) {
        continue;
      }

      const localized: string[] = [];
      let changed = false;
      for (const f of prop.files) {
        const url = f.type === "file" ? f.file?.url : f.external?.url;
        if (!url) continue;
        const caption = f.name?.trim() || `${safeName}-${key}`;
        try {
          const localPath = await this.imageHandler.localizeNotionFileUrl(url, caption);
          if (localPath) {
            localized.push(`[[${localPath}]]`);
            changed = true;
          } else {
            localized.push(url);
          }
        } catch {
          localized.push(url);
        }
      }
      // extractValue 와 동일한 스칼라/배열 규약(단일=스칼라)으로 덮어써 라운드트립을 유지한다.
      if (!changed || localized.length === 0) continue;
      properties[key] = localized.length === 1 ? localized[0] : localized;
    }
  }

  private async pullDatabasePage(
    page: PageObjectResponse,
    dbConfig: DatabaseSyncConfig,
  ): Promise<PullPageOutcome> {
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const properties = this.propertyMapper.fromNotionProperties(
      (page as unknown as { properties: Record<string, unknown> }).properties,
    );
    properties.title = title;

    await this.localizeFileProperties(
      (page as unknown as { properties: Record<string, unknown> }).properties,
      properties,
      safeName,
    );

    const cover = this.notionClient.extractCover(page);
    const icon = this.notionClient.extractIcon(page);

    if (cover) {
      try {
        const coverResult = await this.imageHandler.downloadAllImages(
          `![cover](${cover.url})`,
          `${safeName}-cover`,
        );
        // 이미지 핸들러가 실제 로컬 첨부 경로로 치환했을 때만 위키링크로 감싼다.
        // 다운로드 비활성/실패 시엔 원격 URL이 그대로 돌아오는데, 이를 `[[..]]` 로
        // 감싸면 존재하지 않는 `[[https://..]]` 파일을 가리키는 깨진 링크가 된다(cover-URL).
        const resolved = coverResult.content.match(/!\[cover\]\((.+?)\)/)?.[1];
        if (resolved && !/^https?:\/\//i.test(resolved)) {
          properties.cover = `[[${resolved}]]`;
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
    let exportCompact = false;
    try {
      const mdResult = await this.notionClient.getPageMarkdown(page.id);
      // 압축형 판정은 원시 export 기준(D1) — enhanced 변환 후에는 판정 불가
      exportCompact = isCompactExport(mdResult.markdown);
      markdown = notionEnhancedToObsidian(mdResult.markdown);
    } catch {
      // Markdown API 실패 시 빈 내용
    }

    if (this.config.conversion.imageDownload === "immediate" && markdown) {
      try {
        const imageResult = await this.imageHandler.downloadAllImages(markdown, title);
        markdown = imageResult.content;
      } catch (error) {
        getLogger().warn(`[DB Sync] 이미지 다운로드 실패 (${title}):`, error);
      }
    }

    if (markdown) {
      try {
        const fileResult = await this.imageHandler.downloadAllFiles(markdown, title);
        markdown = fileResult.content;
      } catch (error) {
        getLogger().warn(`[DB Sync] 파일 다운로드 실패 (${title}):`, error);
      }
    }

    const existingRecord = this.stateDb.getByNotionId(page.id);
    let filePath: string;
    if (existingRecord?.obsidianPath) {
      filePath = existingRecord.obsidianPath;
    } else {
      filePath = resolveDbRowPath(dbConfig.localFolder, safeName, page.id, (p) =>
        this.stateDb.getByPath(p),
      );
    }

    const finalContent = this.pipeline.convertToMarkdown(
      markdown,
      {
        direction: "pull",
        path: "markdown-api",
        filePath,
        parentMode: "database",
      },
      { properties, notionExportCompact: exportCompact },
    );

    // 기존 추적 레코드가 있으면 무조건 덮어쓰기 전에 로컬 수정 여부를 검사한다.
    // (신규 페이지는 existingRecord 가 없으므로 충돌 검사 없이 바로 기록 — 로컬 파일 미존재)
    if (existingRecord) {
      let localContent = "";
      try {
        localContent = await this.vaultFs.readFile(filePath);
      } catch {
        localContent = "";
      }

      const resolution = resolvePullConflict({
        record: existingRecord,
        localContent,
        remoteContent: finalContent,
        remoteChange: {
          pageId: page.id,
          type: "modified",
          lastEdited: page.last_edited_time,
          previousEdited: existingRecord.notionLastEdited,
        },
        strategy: this.config.sync.conflictStrategy,
      });

      if (resolution.action === "skip") {
        // local-first: 로컬 보존, 리모트 변경 무시
        return { action: "skipped", path: filePath };
      }
      if (resolution.action === "conflict") {
        // 양쪽 모두 수정됨 → 충돌로 표시하고 로컬 보존 (사용자 해소 대기)
        this.stateDb.updateStatus(existingRecord.id, "conflict");
        return { action: "conflict", path: filePath, conflict: resolution.conflict! };
      }
      // resolution.action === "write" → 아래로 진행하여 덮어쓰기
    }

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

    return { action: "written", path: filePath };
  }

  private async pushDatabase(dbConfig: DatabaseSyncConfig): Promise<DatabaseSyncResult> {
    const schema = await this.notionClient.getDatabaseSchema(dbConfig.databaseId);
    this.propertyMapper.loadSchema(schema);

    const allFiles = await this.vaultFs.listMarkdownFiles();
    // 직속 행 파일만 — 중첩 하위 폴더(별도 child_database)의 행은 각자의 DB push 가 관리하므로
    // 부모 DB 로 잘못 밀어 중복·오배치하지 않는다(오포함 차단).
    const dbFiles = selectDbRowFiles(allFiles, dbConfig.localFolder);

    // rename 감지용 고아 레코드(로컬 파일이 사라진 추적 레코드) 인덱스.
    // 새 경로의 파일이 어떤 고아의 내용 해시와 일치하면 신규 페이지 생성이 아니라 rename 으로 처리.
    const livePaths = new Set(dbFiles.map((f) => f.path));
    const orphanByHash = this.buildOrphanHashIndex(dbConfig.databaseId, livePaths);

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
          try {
            await this.notionClient.updatePageProperties(record.notionPageId, notionProps);
            await this.notionClient.replacePageMarkdown(record.notionPageId, enhanced);
          } catch (error) {
            // push 실패: 본문/속성이 Notion 에 반영되지 않았으므로 해시를 전진시키거나
            // synced 로 표시하지 않는다. (과거: 본문 실패를 삼키고 synced 처리 → 거짓 동기화·
            // 본문 영구 유실. 해시 전진 탓에 다음 push 에서 스킵되어 변경이 영원히 전달 안 됨)
            this.stateDb.updateStatus(record.id, "error");
            failed.push({
              path: file.path,
              operation: "update",
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }

          const updatedPage = await this.notionClient.getPage(record.notionPageId);
          this.stateDb.transaction(() => {
            this.stateDb.updateHash(record.id, hash, Buffer.from(content, "utf-8"));
            this.stateDb.updateStatus(record.id, "synced");
            this.stateDb.setNotionLastEdited(record.id, updatedPage.last_edited_time);
            // 제목/별칭이 바뀌었을 수 있으므로 wikilink 도 함께 갱신해 최신성을 보장한다.
            this.stateDb.upsertWikilink({
              obsidianPath: file.path,
              notionPageId: record.notionPageId!,
              title,
              aliases: extractAliases(frontmatter),
            });
          });
          updated++;
        } else {
          // rename 감지: 내용이 동일한 고아 레코드가 있으면 신규 페이지 생성 대신 경로만 재매핑.
          // (과거: getByPath(newPath)=null → 무조건 신규 생성 → Notion 중복 페이지 + 고아 레코드.
          //  db-row 프론트매터엔 Notion page id 가 없어 내용 해시로 동일 행을 식별한다.)
          const renamed = orphanByHash.get(hash);
          if (renamed?.notionPageId) {
            const movedPageId = renamed.notionPageId;
            orphanByHash.delete(hash); // 같은 고아를 두 번 매칭하지 않도록 제거
            this.stateDb.transaction(() => {
              this.stateDb.updatePath(renamed.id, file.path);
              this.stateDb.updateHash(renamed.id, hash, Buffer.from(content, "utf-8"));
              this.stateDb.updateStatus(renamed.id, "synced");
              // 새 경로로 wikilink 갱신 — INSERT OR REPLACE 가 notion_page_id UNIQUE 충돌로
              // 이전 경로의 wikilink 행을 자동 정리한다.
              this.stateDb.upsertWikilink({
                obsidianPath: file.path,
                notionPageId: movedPageId,
                title,
                aliases: extractAliases(frontmatter),
              });
            });
            updated++;
            continue;
          }

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

    getLogger().debug(`[DB Sync] ${dbConfig.localFolder}: ${created} 생성, ${updated} 업데이트`);
    return { created, updated, conflicts: [], failed, writtenPaths: [] };
  }

  /**
   * rename 감지를 위한 고아 레코드 인덱스(내용 해시 → 레코드)를 만든다.
   * 고아 = 해당 DB 소속 db-row 레코드 중 로컬 파일이 더 이상 존재하지 않는(livePaths 에 없는) 것.
   * 같은 해시가 여러 고아에 걸리면 첫 항목을 유지한다(희박한 케이스).
   */
  private buildOrphanHashIndex(
    databaseId: string,
    livePaths: Set<string>,
  ): Map<string, SyncRecord> {
    const index = new Map<string, SyncRecord>();
    for (const record of this.stateDb.getAll()) {
      if (
        record.fileType === "db-row" &&
        record.notionParentId === databaseId &&
        record.notionPageId &&
        !livePaths.has(record.obsidianPath) &&
        !index.has(record.contentHash)
      ) {
        index.set(record.contentHash, record);
      }
    }
    return index;
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
