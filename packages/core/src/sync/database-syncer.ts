import type { Config, DatabaseSyncConfig } from "../types/config.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { NotionClient } from "../notion/client.js";
import { readLocalNote, type VaultFS } from "./vault-fs.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import type { Conflict, FailedOperation, SyncRecord } from "../types/sync.js";
import type { DatabaseViewsConfig } from "../types/view.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { PropertyMapper } from "../notion/property-mapper.js";
import type { ImageHandler } from "./image-handler.js";
import { resolvePullConflict, sameNoteContent } from "./conflict-detector.js";
import type { PullOutcome } from "./pull-outcome.js";
import { applyRemoteDeletion, remoteDeletionChange, remotePresence } from "./remote-deletion.js";
import { diffRowProperties } from "./row-properties.js";
import { noteTitle } from "./note-title.js";
import { computeHash } from "../utils/hash.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { resolveDbRowPath } from "../utils/db-row-path.js";
import { isDirectDbRowPath } from "../utils/db-folder-path.js";
import { normalizeNotionId, notionIdsEqual } from "../utils/id.js";
import { inAnyPathScope } from "../utils/path-scope.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { getLogger } from "../utils/logger.js";
import { withDeadline } from "../utils/deadline.js";
import { snapshotFrontmatter } from "../utils/frontmatter.js";
import { BaseFileGenerator } from "../view/base-file-generator.js";
import { SidecarGenerator } from "../view/sidecar-generator.js";
import { selectStaleDbArtifacts } from "./stale-db-artifacts.js";
import { INTERNAL_DIR, DB_VIEWS_PATH } from "../constants/paths.js";
import { notionEnhancedToObsidian } from "../converter/enhanced-md-converter.js";
import { isCompactExport } from "../converter/post-processors/block-spacer.js";
import {
  compareRemote,
  NO_OBSERVATION,
  observationOf,
  observedRecordFields,
  remoteBodyFingerprint,
  type ObservationContext,
  type RemoteVerdict,
} from "./remote-observation.js";

export interface DatabaseSyncResult {
  created: number;
  updated: number;
  /**
   * Notion 에서 지워져 볼트에서도 지운 행 수(deleteSync). 행은 DB 조회로만 보여, 행의 삭제는 전체
   * 대조가 아니라 여기서 가른다(S-12).
   */
  deleted: number;
  /** Pull 시 로컬·리모트 동시 수정으로 발생한 충돌. */
  conflicts: Conflict[];
  failed: FailedOperation[];
  /**
   * 이번 pull 에서 실제로 디스크에 기록한 db-row 파일 경로(SSOT).
   * 오케스트레이터의 링크 해소(resolveNotionLinks) 대상은 반드시 이 목록으로 정한다 —
   * 과거의 `getByStatus("synced").slice(-N)` 휴리스틱은 ORDER BY 가 없어 증분 pull 에서
   * 엉뚱한 행을 골라 정작 바뀐 행의 relation UUID 를 영영 해소하지 못했다(M3).
   */
  writtenPaths: string[];
  /**
   * R13: 볼트에서 사라졌기에 되살린 행 수. `updated` 와 섞지 않는다 — 리모트는 그대로이고
   * 바뀐 것은 로컬의 부재이므로, 합쳐 세면 dry-run 과 멱등성 게이트(churn)가 "원격이
   * 바뀌었다"고 거짓말한다. 페이지 경로가 이미 같은 이유로 `restored` 를 분리해 보고한다.
   */
  restored: number;
  /**
   * F25: 이 config 가 linked view 컨테이너로 판정된 경우 data source 원본 database id.
   * 행 처리는 원본 config 에 양보하고 건너뛰었으므로, 호출처(디스커버리 캐시)는 이 config
   * 를 제거하고 linked 매핑을 기록해야 다음 pull 부터 이중 방문 자체가 사라진다.
   */
  linkedOriginalDbId?: string;
}

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
    /**
     * 이번 동기화가 원격을 보는 기준(N-05) — 오케스트레이터가 실행마다 정한다. 따로 쓰면(시험)
     * 아무것도 가라앉았다고 보지 않는다 — 수정 시각이 같은 행도 받아서 견준다.
     */
    private readonly observation: () => ObservationContext = () => NO_OBSERVATION,
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

  async pullAll(opts?: { readonly paths?: readonly string[] }): Promise<DatabaseSyncResult> {
    const databases = this.config.notion.databases;
    if (!databases || databases.length === 0) {
      return {
        created: 0,
        updated: 0,
        deleted: 0,
        restored: 0,
        conflicts: [],
        failed: [],
        writtenPaths: [],
      };
    }

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let restored = 0;
    const conflicts: Conflict[] = [];
    const failed: FailedOperation[] = [];
    const writtenPaths: string[] = [];

    for (const dbConfig of databases) {
      try {
        const result = await this.pullDatabase(dbConfig, { paths: opts?.paths });
        created += result.created;
        updated += result.updated;
        deleted += result.deleted;
        restored += result.restored;
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

    return { created, updated, deleted, restored, conflicts, failed, writtenPaths };
  }

  async pullDatabase(
    dbConfig: DatabaseSyncConfig,
    opts?: {
      /**
       * F25: database id(하이픈 유무 무관) → 그 DB 행이 사는 로컬 폴더. 디스커버리 캐시가
       * 아는 DB 만 반환하고 모르면 null. linked view 컨테이너 판정 시 원본 폴더를 아는
       * 경우에만 행 소유를 양보한다 — 원본이 미발견이면 이 컨테이너가 유일한 접근 통로다.
       */
      resolveDbFolder?: (databaseId: string) => string | null;
      /** 이 범위의 행만 지운다(`pull --path`). 없으면 모든 행. */
      paths?: readonly string[];
    },
  ): Promise<DatabaseSyncResult> {
    const pages = await this.notionClient.queryAllDatabasePages(
      dbConfig.databaseId,
      dbConfig.pullFilter,
    );

    // F25: 행 parent 로 data source 의 원본 database 를 검증한다(추가 API 0회). 신 모델에선
    // linked view 컨테이너도 data_sources 가 채워져 retrieve 만으론 원본과 구분되지 않아
    // 캐시에 오등록될 수 있는데, 그대로 두면 같은 행 집합을 여러 config 가 각자 자기 폴더로
    // 릴레이 재배치해 원격 무변경에도 매 pull 재작성이 쌓인다(실측 66건/pull, 행당 최대 4중).
    // 컨테이너로 판정되면 행은 원본에 양보하고 .base 만 원본 폴더 필터로 재지향해
    // "같은 데이터의 다른 뷰"라는 Notion 의미를 보존한다.
    const parent = pages[0]?.parent as { type?: string; database_id?: string } | undefined;
    const ownerDbId = parent?.database_id;
    if (ownerDbId && !notionIdsEqual(ownerDbId, dbConfig.databaseId)) {
      const ownerFolder = opts?.resolveDbFolder?.(ownerDbId) ?? null;
      if (ownerFolder !== null) {
        const viewsConfig = await this.pullDatabaseViews(dbConfig);
        await this.generateBaseFile(dbConfig, viewsConfig, ownerFolder);
        return {
          created: 0,
          updated: 0,
          deleted: 0,
          restored: 0,
          conflicts: [],
          failed: [],
          writtenPaths: [],
          linkedOriginalDbId: ownerDbId,
        };
      }
    }

    const schema = await this.notionClient.getDatabaseSchema(dbConfig.databaseId);
    this.propertyMapper.loadSchema(schema);

    await this.vaultFs.ensureFolder(dbConfig.localFolder);

    const viewsConfig = await this.pullDatabaseViews(dbConfig);
    await this.generateBaseFile(dbConfig, viewsConfig);

    let created = 0;
    let updated = 0;
    let restored = 0;
    const conflicts: Conflict[] = [];
    const failed: FailedOperation[] = [];
    // M3: 실제로 디스크에 기록된 DB 행 경로 — 후처리 링크 해소(resolveNotionLinks)가
    // 정확히 이 파일들만 재방문하도록 슬라이스 추정 대신 실측 수집한다.
    const writtenPaths: string[] = [];

    for (const page of pages) {
      try {
        const record = this.stateDb.getByNotionId(page.id);
        // 원격 무변경인데도 되살리려고 내려온 행인가 — 아래 집계에서 updated 와 가른다.
        let restoring = false;

        if (record) {
          // 리모트가 지난번에 본 그대로면 건너뜀. 수정 시각이 같아도 같은 분 안의 편집일 수
          // 있으면(«확인 안 됨», N-05) 받아서 견준다 — 같으면 파일을 쓰지 않는다. 단 두 가지
          // 예외가 있다.
          //  · 레코드 경로가 현재 DB 폴더 직속이 아니면(F24 동명 DB 폴더 분리 후 옛 공유
          //    폴더 잔류) 원격 무변경이어도 재처리해 현 폴더로 재배치한다.
          //  · 로컬 파일이 사라졌으면 되살린다(R13). 이 확인이 없으면 pullDatabasePage
          //    안의 복원 판정(localExists → resolvePullConflict)에 영영 도달하지 못해
          //    지운 행이 조용히 영구 소실된다. 페이지 경로는 R0 으로 이미 마감한 계약인데
          //    행 경로만 빠져 있었다 — 오케스트레이터의 detectMissingLocalFiles 가 "행은
          //    여기서 이미 같은 판정을 거친다"는 (틀린) 전제로 db-row 를 제외해 두었기에
          //    양쪽 어디에도 복원 경로가 없는 상태였다.
          const misplaced = !isDirectDbRowPath(dbConfig.localFolder, record.obsidianPath);
          if (!misplaced && this.remoteVerdict(record, page) === "unchanged") {
            if (await this.vaultFs.exists(record.obsidianPath)) continue;
            restoring = true;
          }
        }

        // R9e: 행 1건 처리도 합성 경로다 — 블록 조회·첨부 다운로드·변환·파일 IO 가 얽혀
        // 있어 호출 단위 상한만으로는 덮이지 않는다. R9b 가 오케스트레이터의 페이지 루프
        // 4곳에만 상한을 걸어 DB 행은 그대로 무방비였다(R9a 의 image/file 핸들러 비대칭과
        // 같은 결함군 — 같은 계약이 두 경로에 있으면 한쪽만 빠진다). 볼트의 887개 파일 중
        // 629개가 DB 행이므로 보호 공백이 오히려 다수였다.
        const outcome = await withDeadline(
          () => this.pullDatabasePage(page, dbConfig),
          this.config.advanced.itemTimeoutMs,
          `pull ${dbConfig.localFolder}/${page.id}`,
        );

        if (!record) {
          created++;
          if (outcome.action === "written") writtenPaths.push(outcome.path);
        } else if (outcome.action === "written") {
          if (restoring) restored++;
          else updated++;
          writtenPaths.push(outcome.path);
        } else if (outcome.action === "conflict") {
          conflicts.push(outcome.conflict);
        }
        // skipped(local-first) · unchanged(받아 보니 그대로): 카운트하지 않음
      } catch (error) {
        failed.push({
          path: `${dbConfig.localFolder}/${page.id}`,
          operation: "create",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const removal = await this.pullDeletedRows(dbConfig, pages, opts?.paths);
    const deleted = removal.deleted;
    conflicts.push(...removal.conflicts);

    getLogger().debug(
      `[DB Sync] ${dbConfig.localFolder}: ${created} 생성, ${updated} 업데이트, ${deleted} 삭제, ${restored} 복원, ${conflicts.length} 충돌`,
    );
    return { created, updated, deleted, restored, conflicts, failed, writtenPaths };
  }

  /**
   * 조회에 없던 이 DB 의 추적 행 가운데 Notion 에서 정말 지워진 것만 볼트에서 지운다(deleteSync, S-12).
   *
   * 행은 DB 조회로만 보인다 — 전체 대조(페이지 순회)는 행을 보지 못해 행의 삭제는 여기서 가른다.
   * 조회에 없다는 것만으로 지우지 않고 행마다 원격에 묻는다({@link remotePresence}): 살아 있는 행은
   * 다른 DB 로 옮겨졌을 수 있다(그 DB 의 pull 이 옮겨 받는다). 묻지 못한 행은 이번에는 둔다 — 다음
   * pull 이 다시 묻는다.
   *
   * 조회 필터(`pullFilter`)가 있으면 가르지 않는다 — 조회에 없는 행이 필터 밖인지 지워진 것인지
   * 모르고, 필터 밖으로 나간 행을 매번 물으면 요청이 끝없이 는다.
   *
   * 올리지 않은 로컬 편집이 있는 행은 페이지와 같은 규칙을 따른다({@link applyRemoteDeletion}) —
   * 지우지 않고 충돌로 남기거나 파일을 둔다.
   */
  private async pullDeletedRows(
    dbConfig: DatabaseSyncConfig,
    pages: readonly PageObjectResponse[],
    paths: readonly string[] | undefined,
  ): Promise<{ deleted: number; conflicts: Conflict[] }> {
    const conflicts: Conflict[] = [];
    if (!this.config.sync.deleteSync || dbConfig.pullFilter) return { deleted: 0, conflicts };

    const listed = new Set(pages.map((page) => normalizeNotionId(page.id)));
    const missing = this.stateDb
      .getAll()
      .filter(
        (record) =>
          record.fileType === "db-row" &&
          record.notionPageId !== null &&
          record.notionParentId !== null &&
          notionIdsEqual(record.notionParentId, dbConfig.databaseId) &&
          !listed.has(normalizeNotionId(record.notionPageId)) &&
          inAnyPathScope(record.obsidianPath, paths),
      );

    let deleted = 0;
    for (const record of missing) {
      try {
        const presence = await remotePresence(this.notionClient, record.notionPageId!);
        if (presence.kind === "alive") continue;
        const outcome = await applyRemoteDeletion(this.stateDb, this.vaultFs, record, {
          deleteFile: this.config.sync.deleteSync,
          strategy: this.config.sync.conflictStrategy,
          remoteChange: remoteDeletionChange(record),
        });
        if (outcome.action === "deleted") deleted++;
        else if (outcome.action === "conflict") conflicts.push(outcome.conflict);
      } catch (error) {
        getLogger().warn(
          `[DB Sync] 조회에 없는 행 ${record.obsidianPath} — 원격을 확인하지 못해 이번에는 지우지 않음:`,
          error,
        );
      }
    }
    return { deleted, conflicts };
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
    /**
     * F25: 행이 실제로 사는 폴더(.base 의 inFolder 필터 대상). linked view 컨테이너의
     * .base 는 자기 폴더가 아니라 원본 DB 폴더를 가리켜야 행 이관 후에도 빈 뷰가 되지
     * 않는다. 생략하면 자기 폴더(원본 DB 의 기본 동작).
     */
    rowsFolder?: string,
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
        folderPath: rowsFolder ?? dbConfig.localFolder,
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
      const serialized = this.sidecarGenerator.serialize(sidecar);
      // 같은 DB 가 한 번의 pull 에서 임베드 재작성 때마다 재생성된다(실측 최대 67회).
      // 결정적 직렬화라 동일 바이트면 쓰기·degrade 로그 모두 생략 — 로그 노이즈와
      // 불필요한 IO 를 없애고, 내용이 실제로 바뀔 때만 알린다.
      const existing = await this.vaultFs.readFile(sidecarPath).catch(() => null);
      if (existing === serialized) return;
      await this.vaultFs.writeFile(sidecarPath, serialized);

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

  /**
   * 행 하나를 pull 이 쓰는 모양 그대로 렌더한다 — 파일은 쓰지 않는다.
   *
   * pull(pullDatabasePage)과 충돌 비교 · 원격 선택 해소 · 원격 미리보기(오케스트레이터의
   * renderRemotePage)가 같은 렌더를 봐야 한다. 행을 페이지처럼 렌더하면 커버 · 아이콘 ·
   * 첨부 속성이 빠지고, 본문 첫머리의 옛 속성 블록 값이 실제 속성을 덮는다(S-02).
   *
   * 본문을 읽지 못하면 던진다 — 행은 실패로 남고 레코드가 그대로라 다음 pull 이 다시
   * 받는다. 예전에는 빈 본문으로 넘어가, 로컬이 그대로인 행은 본문이 지워진 채 «동기화
   * 완료» 로 기록됐다(S-10). 읽지 못한 것은 비어 있는 것이 아니다.
   *
   * @param options.downloadMedia false 면 첨부를 내려받지 않는다(표시 전용). 비교를 보려다
   *   볼트에 파일이 생기면 안 된다 — 그 대가로 아직 내려받지 않은 첨부는 원격 URL 로 남는다.
   * @param options.localPath 로컬 노트가 지금 있는 자리 — 코드 펜스 표기를 되살리는 근거(S-20).
   *   다른 폴더로 옮기기 전이면 옛 경로다. 기본은 `filePath`.
   */
  async renderRow(
    page: PageObjectResponse,
    filePath: string,
    options?: { downloadMedia?: boolean; localPath?: string },
  ): Promise<{
    content: string;
    title: string;
    properties: Record<string, unknown>;
    /** 받은 원격 본문의 지문(`remoteBodyFingerprint`). */
    bodyFingerprint: string;
  }> {
    const downloadMedia = options?.downloadMedia !== false;
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const properties = this.propertyMapper.fromNotionProperties(
      (page as unknown as { properties: Record<string, unknown> }).properties,
    );
    properties.title = title;

    if (downloadMedia) {
      await this.localizeFileProperties(
        (page as unknown as { properties: Record<string, unknown> }).properties,
        properties,
        safeName,
      );
    }

    const cover = this.notionClient.extractCover(page);
    const icon = this.notionClient.extractIcon(page);

    if (cover) {
      // notion-hosted 커버는 서명 URL(약 1시간 만료)이라 frontmatter 에 남기면 깨진
      // 링크 + 풀마다 서명이 바뀌어 churn 이 된다(실측: LIFE/WORK). files 속성과 같은
      // 로컬라이즈 경로(P3-A)로 첨부에 내려받고, 외부 URL(unsplash 등)은 원형 유지한다.
      // (기존 구현은 downloadAllImages 결과를 `![cover](..)` 형태로 재매치했지만 성공
      // 시 결과가 `![[..]]` 위키링크라 항상 미스매치 → 서명 URL 폴백이 되는 버그였다)
      const local = downloadMedia
        ? await this.imageHandler.localizeNotionFileUrl(cover.url, `${safeName}-cover`)
        : null;
      properties.cover = local ? `[[${local}]]` : cover.url;
    }

    if (icon) {
      properties.icon = icon.value;
    }

    const mdResult = await this.notionClient.getPageMarkdown(page.id);
    const bodyFingerprint = remoteBodyFingerprint(mdResult.markdown);
    // 압축형 판정은 원시 export 기준(D1) — enhanced 변환 후에는 판정 불가
    const exportCompact = isCompactExport(mdResult.markdown);
    let markdown = notionEnhancedToObsidian(mdResult.markdown);
    // 이 행이 올린 미디어는 내려받지 않고 원래 임베드로 되돌린다 — 페이지와 같다. 행 id 와
    // 행 경로를 넘겨야 그 행이 올린 것(과 옛 캡션의 파일)을 찾는다.
    markdown = await this.imageHandler.restoreUploadedMedia(markdown, page.id, filePath);

    if (downloadMedia && this.config.conversion.imageDownload === "immediate" && markdown) {
      try {
        const imageResult = await this.imageHandler.downloadAllImages(markdown, title, page.id);
        markdown = imageResult.content;
      } catch (error) {
        getLogger().warn(`[DB Sync] 이미지 다운로드 실패 (${title}):`, error);
      }
    }

    if (downloadMedia && markdown) {
      try {
        const fileResult = await this.imageHandler.downloadAllFiles(markdown, title);
        markdown = fileResult.content;
      } catch (error) {
        getLogger().warn(`[DB Sync] 파일 다운로드 실패 (${title}):`, error);
      }
    }

    const content = this.pipeline.convertToMarkdown(
      markdown,
      {
        direction: "pull",
        path: "markdown-api",
        filePath,
        parentMode: "database",
      },
      {
        properties,
        notionExportCompact: exportCompact,
        localContent: await readLocalNote(this.vaultFs, options?.localPath ?? filePath),
      },
    );
    return { content, title, properties, bodyFingerprint };
  }

  /**
   * 행의 본문 밖이 지난 동기화 사본 그대로인가(N-05) — 제목과 보낼 수 있는 속성, 그리고
   * {@link renderRow} 로 받는 행이면 아이콘 · 커버. push 는 원격을 덮어써도 되는지, pull 은 받을
   * 것이 있는지를 이 규칙으로 가른다. 읽기 전용 속성(수식 · 롤업 · 수정 시각)은 보지 않는다 —
   * 로컬에서 고칠 수 없고 push 가 보내지 않는다.
   *
   * @param mapper 그 행의 DB 스키마를 읽은 매퍼.
   * @param base 지난 동기화 시점의 frontmatter.
   * @param path 지난 동기화 시점의 경로 — 파일 이름을 따르던 제목을 가른다.
   * @param decorated 아이콘 · 커버도 견주나 — {@link renderRow} 로 받는 행만 그것을 노트에 적는다.
   */
  rowOutsideBodyUnchanged(
    mapper: PropertyMapper,
    page: PageObjectResponse,
    base: Readonly<Record<string, unknown>>,
    path: string,
    decorated: boolean,
  ): boolean {
    const raw = (page as unknown as { properties?: Record<string, unknown> }).properties ?? {};
    const { changed, cleared } = diffRowProperties(
      mapper.pickWritable(mapper.fromNotionProperties(raw)),
      mapper.pickWritable(base),
    );
    return (
      this.notionClient.extractTitle(page) === noteTitle(base, path) &&
      Object.keys(changed).length === 0 &&
      cleared.length === 0 &&
      (!decorated || this.decorationsUnchanged(page, base))
    );
  }

  /**
   * 원격 행의 아이콘 · 커버가 `frontmatter` 에 적힌 그대로인가 — {@link renderRow} 가 적는 모양으로
   * 견준다(N-05). Notion 에 올린 파일은 읽을 때마다 주소가 바뀌고(서명) 커버는 볼트로 내려받아
   * 적으므로, 있는지만 견준다.
   */
  private decorationsUnchanged(
    page: PageObjectResponse,
    frontmatter: Readonly<Record<string, unknown>>,
  ): boolean {
    const icon = this.notionClient.extractIcon(page);
    const cover = this.notionClient.extractCover(page);
    return (
      sameDecoration(
        icon === null ? null : { uploaded: icon.type === "file", value: icon.value },
        frontmatter.icon,
      ) &&
      sameDecoration(
        cover === null ? null : { uploaded: cover.type === "file", value: cover.url },
        frontmatter.cover,
      )
    );
  }

  /** 레코드가 지난번에 본 원격 행과 지금 행을 견준다 — 이번 동기화의 기준으로(N-05). */
  private remoteVerdict(record: SyncRecord, page: PageObjectResponse): RemoteVerdict {
    return compareRemote(record, page, this.observation().botUserId);
  }

  private async pullDatabasePage(
    page: PageObjectResponse,
    dbConfig: DatabaseSyncConfig,
  ): Promise<PullOutcome> {
    const safeName = sanitizeFileName(this.notionClient.extractTitle(page));

    const existingRecord = this.stateDb.getByNotionId(page.id);
    // F24: 동명 형제 DB 폴더 분리 후 레코드가 옛 공유 폴더를 가리키면(직속 아님) 현재
    // 폴더 기준으로 경로를 재산정해 재배치한다. 파일 이동은 overwrite 확정 후에만 —
    // local-first 스킵/충돌이면 원위치를 보존한다. 재산정은 resolveDbRowPath 를 그대로
    // 타므로 충돌 시절 붙은 id 접미사도 새 폴더에서 자연 이름으로 되돌아온다.
    const recordPath = existingRecord?.obsidianPath;
    let filePath: string;
    if (recordPath && isDirectDbRowPath(dbConfig.localFolder, recordPath)) {
      filePath = recordPath;
    } else {
      filePath = resolveDbRowPath(dbConfig.localFolder, safeName, page.id, (p) =>
        this.stateDb.getByPath(p),
      );
    }

    const {
      content: finalContent,
      title,
      properties,
      bodyFingerprint,
    } = await this.renderRow(page, filePath, { localPath: recordPath ?? filePath });
    const seenAt = this.observation().seenAt;

    // 기존 추적 레코드가 있으면 무조건 덮어쓰기 전에 로컬 수정 여부를 검사한다.
    // (신규 페이지는 existingRecord 가 없으므로 충돌 검사 없이 바로 기록 — 로컬 파일 미존재)
    if (existingRecord) {
      let localContent = "";
      // 읽기 실패를 곧바로 "파일 없음"으로 단정하지 않는다(권한 오류 구분). 실패 경로에서만
      // 존재 여부를 다시 물어, 사라진 행은 복원하고 못 읽은 행은 종전대로 보수 처리한다.
      let localExists = true;
      const readPath = recordPath ?? filePath;
      try {
        // 재배치 대상이면 로컬 내용은 아직 옛 경로에 있다 — 실제 위치에서 읽어야
        // local-first/충돌 판정이 빈 파일로 오판되지 않는다.
        localContent = await this.vaultFs.readFile(readPath);
      } catch {
        localContent = "";
        localExists = await this.vaultFs.exists(readPath);
      }

      // 받은 행이 지난 사본 그대로인지 내용으로 가른다 — push 와 같은 규칙(N-05). 렌더한 글이
      // 달라도 받을 것이 없으면, 그 사이 로컬 편집을 충돌로 올리지 않는다. 사라진 행은 되살린다.
      const base = snapshotFrontmatter(existingRecord.baseSnapshot);
      const remoteUnchanged =
        localExists &&
        base !== null &&
        bodyFingerprint === existingRecord.notionBodyFingerprint &&
        this.rowOutsideBodyUnchanged(
          this.propertyMapper,
          page,
          base,
          existingRecord.obsidianPath,
          true,
        );

      const resolution = resolvePullConflict({
        record: existingRecord,
        localContent,
        localExists,
        remoteContent: finalContent,
        remoteUnchanged,
        remoteChange: {
          pageId: page.id,
          type: "modified",
          lastEdited: page.last_edited_time,
          previousEdited: existingRecord.notionLastEdited,
        },
        strategy: this.config.sync.conflictStrategy,
      });

      if (resolution.action === "skip") {
        // 원격이 지난 사본 그대로다 — 본 것만 적는다. 로컬 편집은 다음 push 가 올린다.
        if (resolution.remoteUnchanged) {
          this.stateDb.setRemoteObservation(existingRecord.id, {
            ...observationOf(page, seenAt),
            bodyFingerprint,
          });
          return { action: "unchanged", path: recordPath ?? filePath };
        }
        // local-first: 로컬 보존, 리모트 변경 무시(재배치 대상이어도 파일은 원위치 유지)
        return { action: "skipped", path: recordPath ?? filePath };
      }
      if (resolution.action === "conflict") {
        // 양쪽 모두 수정됨 → 충돌로 표시하고 로컬 보존 (사용자 해소 대기)
        this.stateDb.updateStatus(existingRecord.id, "conflict");
        return {
          action: "conflict",
          path: recordPath ?? filePath,
          conflict: resolution.conflict!,
        };
      }
      // 받아 보니 로컬과 같다 — 파일을 다시 쓰지 않고 본 것만 적는다. 페이지의 같은 자리(I5)와
      // 같은 이유다: 같은 분 안의 편집인지 확인하려고 받은 행(N-05) · 수정 시각만 바뀐 행을
      // «업데이트» 로 세지 않는다. 파일 끝 개행만 다르면 로컬을 그대로 두고 로컬을 사본으로
      // 적는다. 재배치할 행은 옮겨야 하므로 아래로 간다.
      if (localExists && sameNoteContent(localContent, finalContent) && readPath === filePath) {
        const stat = await this.vaultFs.getFileStat(filePath);
        this.stateDb.upsert({
          obsidianPath: filePath,
          notionPageId: page.id,
          notionParentId: dbConfig.databaseId,
          contentHash: computeHash(localContent),
          ...observedRecordFields(page, seenAt, bodyFingerprint),
          localLastModified: existingRecord.localLastModified,
          syncDirection: existingRecord.syncDirection,
          fileType: "db-row",
          status: "synced",
          baseSnapshot: Buffer.from(localContent, "utf-8"),
          localMtime: stat?.mtime ?? existingRecord.localMtime,
          localFileSize: stat?.size ?? existingRecord.localFileSize,
        });
        return { action: "unchanged", path: filePath };
      }
      // resolution.action === "write" → 아래로 진행하여 덮어쓰기
    }

    await this.vaultFs.ensureFolder(dbConfig.localFolder);
    await this.vaultFs.writeFile(filePath, finalContent);

    const rehomed = existingRecord && recordPath && recordPath !== filePath;
    const hash = computeHash(finalContent);
    this.stateDb.transaction(() => {
      if (rehomed) {
        // 재배치: upsert 는 obsidianPath 키라 경로를 먼저 옮겨야 같은 notion_page_id 의
        // 중복 INSERT(UNIQUE 위반)가 안 난다. 옛 경로 위키링크도 함께 제거.
        this.stateDb.updatePath(existingRecord.id, filePath);
        this.stateDb.deleteWikilink(recordPath);
      }
      this.stateDb.upsert({
        obsidianPath: filePath,
        notionPageId: page.id,
        notionParentId: dbConfig.databaseId,
        contentHash: hash,
        ...observedRecordFields(page, seenAt, bodyFingerprint),
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
    if (rehomed) {
      try {
        await this.vaultFs.deleteFile(recordPath);
      } catch {
        // 옛 파일 삭제 실패는 재배치 자체를 무르지 않는다(다음 pull 재시도 여지).
      }
    }

    return { action: "written", path: filePath };
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

/**
 * 원격 아이콘 · 커버 하나가 frontmatter 에 적힌 값과 같은가. Notion 에 올린 파일(`uploaded`)은
 * 있는지만 본다. `remote` 는 원격에 없으면 null.
 */
function sameDecoration(
  remote: { readonly uploaded: boolean; readonly value: string } | null,
  written: unknown,
): boolean {
  const present = written !== undefined && written !== null && written !== "";
  if (remote === null) return !present;
  return remote.uploaded ? present : written === remote.value;
}
