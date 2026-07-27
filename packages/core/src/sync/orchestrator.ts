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
} from "../types/sync.js";
import type { Config } from "../types/config.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { NotionClient } from "../notion/client.js";
import { isNotionObjectNotFound, DiscoveryTooLargeError } from "../notion/client.js";
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
import { ConflictResolver } from "../conflict/resolver.js";
import type { ResolutionChoice, ResolutionResult } from "../conflict/resolver.js";
import { PropertyMapper, type WikilinkResolver } from "../notion/property-mapper.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { notionIdsEqual, normalizeNotionId } from "../utils/id.js";
import { runPool } from "../utils/pool.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { resolveFrontmatterRelations } from "./frontmatter-link-resolver.js";
import type { VaultFS } from "./vault-fs.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../converter/enhanced-md-converter.js";
import { isCompactExport } from "../converter/post-processors/block-spacer.js";
import { extractInlineDbIds } from "../utils/inline-db-refs.js";
import { resolveDbFolderPath, repairDbFolderCollisions } from "../utils/db-folder-path.js";
import { rewriteDbPlaceholders, type DbEmbedTarget } from "./db-placeholder-rewriter.js";

/** 자동 발견된 DB 설정 빌드 결과 — 동기화 가능/linked 해소/접근 불가/일시 오류를 구분한다. */
type DiscoveredDbOutcome =
  | { kind: "ok"; config: { databaseId: string; localFolder: string; titleProperty: string } }
  | { kind: "linked"; originalDbId: string }
  | { kind: "inaccessible" }
  | { kind: "error" };

/** 접근 불가 DB denylist 를 보존하는 상태 메타 키. */
const INACCESSIBLE_DBS_META_KEY = "inaccessible_dbs";

/** linked view 컨테이너 → 원본 DB 매핑을 보존하는 상태 메타 키(nohyph → nohyph). */
const LINKED_DBS_META_KEY = "linked_dbs";

/**
 * 증분 pull 워터마크 안전창(F20). Notion search 는 인덱싱 지연이 있어 생성 직후 페이지가
 * 결과에 안 잡히는데, 워터마크를 그대로 쓰면 다음 pull 부터 last_edited < since 로
 * 영원히 제외된다(실측 재현: 신규 하위 페이지가 편집 전까지 3회 연속 미발견).
 * 이 창만큼 되돌려 조회하면 지연 인덱싱분을 다음 pull 이 회수한다.
 */
const INCREMENTAL_SAFETY_WINDOW_MS = 15 * 60_000;

/** 전략 → 선택지 매핑. propagateResolution 이 push 방향을 정할 때 사용. */
function strategyToChoice(strategy: ConflictStrategy): ResolutionChoice {
  switch (strategy) {
    case "local-first":
      return "local";
    case "remote-first":
      return "remote";
    case "duplicate":
      return "duplicate";
    case "manual":
      return "merge";
  }
}

export class SyncOrchestrator {
  private readonly changeDetector: ChangeDetector;
  private readonly pipeline: ConversionPipeline;
  private readonly blockConverter: BlockConverter;
  private readonly imageHandler: ImageHandler;
  private readonly fileHandler: FileHandler;
  private readonly databaseSyncer: DatabaseSyncer;
  private readonly propertyMapper: PropertyMapper;
  private readonly conflictResolver: ConflictResolver;
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

  // 서브트리 직접 순회(getChildPagesRecursive) 시간 예산. 초과하면 search 기반 디스커버리로
  // 폴백한다. 분기점 근거: 워크스페이스 search 열거는 latency-bound 로 대략 이 수준(수천 페이지
  // 워크스페이스에서 ~100s)이므로, 순회가 이 시간을 넘기면 search 가 더 저렴해진다. 작은 볼트는
  // 이 예산 안에서 순회가 끝나 폴백 없이 빠르게 완료된다. (단위: ms)
  private static readonly DISCOVERY_RECURSIVE_BUDGET_MS = 90_000;

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

    this.blockConverter.initNotionToMd(this.notionClient.getInternalClient());
    this.conflictResolver = new ConflictResolver(stateDb, vaultFs);
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

    this.cleanupInterruptedSync();

    const counts = { created: 0, updated: 0, deleted: 0, restored: 0 };
    this._pullImageCount = 0;
    this._pullFileCount = 0;
    this._inlineDbRefs.clear();
    const conflicts: Conflict[] = [];
    const writtenPaths: string[] = [];
    const failed: FailedOperation[] = [];

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
      this.stateDb.setMeta("last_pull_at", new Date().toISOString());
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
      };
    };

    const lastPull = this.stateDb.getMeta("last_pull_at") ?? this.stateDb.getMeta("last_sync_at");
    const trackedCount = this.stateDb.getAll().length;
    // 증분(searchRecentPages) 은 in_trash 페이지를 못 보므로 삭제를 감지하지 못한다(I10).
    // deleteSync 가 켜진 경우엔 삭제 전파가 필요하니 반드시 전체 스캔(detectRemoteChanges)을
    // 타게 해 사라진 추적 페이지를 잡는다. 꺼진 경우엔 어차피 삭제를 전파하지 않으므로 빠른
    // 증분 경로가 안전하다(누락해도 사용자 설정상 무동작).
    const canUseIncremental =
      !this.isDatabaseMode &&
      !!lastPull &&
      trackedCount > 0 &&
      !options?.force &&
      !this.config.sync.deleteSync;
    const remoteChanges = canUseIncremental
      ? await this.detectRemoteChangesIncremental(lastPull!)
      : await this.detectRemoteChanges();

    const filtered = options?.paths
      ? remoteChanges.filter((c) => {
          const record = this.stateDb.getByNotionId(c.pageId);
          return record && options.paths!.some((p) => record.obsidianPath.startsWith(p));
        })
      : remoteChanges;

    // D-DELETE-NORESTORE: 원격 변경 감지는 "Notion 에서 바뀐 것"만 본다. 로컬에서 지워진
    // 추적 파일은 어느 경로로도 큐에 오르지 않아, 증분이든 --force 든 되살아나지 않고
    // 영구히 발산했다(실측 0/4). 상태 DB 와 실제 볼트의 차집합으로 직접 잡아 복원 대상으로
    // 밀어 넣는다. 이미 원격 변경으로 큐에 오른 페이지는 중복 처리하지 않는다.
    const queuedIds = new Set(filtered.map((c) => c.pageId));
    const restoreChanges: RemoteChange[] = (await this.detectMissingLocalFiles(options?.paths))
      .filter((r) => r.notionPageId !== null && !queuedIds.has(r.notionPageId))
      .map((r) => ({
        pageId: r.notionPageId as string,
        type: "modified" as const,
        lastEdited: r.notionLastEdited ?? r.updatedAt,
        previousEdited: r.notionLastEdited,
      }));
    const restoreIds = new Set(restoreChanges.map((c) => c.pageId));
    const workItems = restoreChanges.length > 0 ? [...filtered, ...restoreChanges] : filtered;

    if (workItems.length === 0 && (this.config.notion.databases?.length ?? 0) === 0) {
      // 본문 페이지 변경이 없어도 디스커버리된 DB 행은 새로 기록될 수 있다. 그 행들의
      // 본문 링크·frontmatter relation 을 finalize() 의 resolveNotionLinks 가 해소한다(M2).
      // (기록이 0건이면 writtenPaths 가 비어 linkCount 0 으로 마감 — emptyResult 와 동일)
      const dbDiscovery = await this.pullDiscoveredDatabases(
        writtenPaths,
        failed,
        conflicts,
        options?.force === true,
      );
      return finalize(dbDiscovery.created, dbDiscovery.updated, 0);
    }
    if (workItems.length === 0) {
      return emptyResult;
    }

    if (options?.dryRun) {
      const dryCreated = filtered.filter((c) => c.type === "created").length;
      const dryUpdated = filtered.filter((c) => c.type === "modified").length;
      const dryDeleted = filtered.filter((c) => c.type === "deleted").length;
      let dryProgress = 0;
      const dryTotal = workItems.length;
      for (const change of workItems) {
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
        // 복원은 updated 에 섞지 않는다 — dry-run 이 "수정 N건" 이라고만 말하면
        // 사용자가 사라진 파일이 되살아난다는 사실을 미리 알 수 없다.
        restored: restoreChanges.length,
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

    const pullTotal = workItems.length;
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
          } else if (result.path && !result.unchanged) {
            // unchanged=true 는 content_hash 동일 no-op(가짜 수정) — 파일 재기록·churn 없음.
            // updated 카운트에 넣지 않아 보고가 정직해진다(I5).
            writtenPaths.push(result.path);
            if (restoreIds.has(change.pageId)) counts.restored++;
            else counts.updated++;
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
      workItems,
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
        // M3: 후처리 대상은 실제 기록된 행 경로를 그대로 받는다. 과거엔 "synced 상태의
        // db-row 중 마지막 N개" 라는 슬라이스 추정을 썼는데, 정렬·기존행 혼입 때문에
        // 엉뚱한 파일을 후처리하거나 갓 쓴 행을 놓쳐 링크가 미해소로 남았다.
        writtenPaths.push(...dbResult.writtenPaths);
      } catch (error) {
        getLogger().warn("[Im-Nobsidian] DB Pull 중 오류:", error);
      }
    }

    {
      const dbDiscovery = await this.pullDiscoveredDatabases(
        writtenPaths,
        failed,
        conflicts,
        options?.force === true,
      );
      counts.created += dbDiscovery.created;
      counts.updated += dbDiscovery.updated;
    }

    return finalize(counts.created, counts.updated, counts.deleted, counts.restored);
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
    // 증분은 삭제(in_trash)를 못 본다(I10). deleteSync 시 status 가 원격 삭제를 보고할 수
    // 있도록 전체 스캔으로 우회한다. 꺼진 경우엔 삭제를 행동에 옮기지 않으므로 증분으로 충분.
    const remoteChanges =
      lastSyncAt && !this.config.sync.deleteSync
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
          remoteContent = (await this.fetchPageMarkdown(record.notionPageId)).content;
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
      // 제목 + 접근 가능한 data source 유무를 확인한다. data source 가 없으면
      // 행 조회가 404 로 실패하고 빈 폴더/.base 만 남기므로, 발견 단계에서 미리 제외한다.
      const info = await this.notionClient.getDatabaseSyncability(dbId);
      // F25: data_sources 가 채워진 linked view 컨테이너(원본이 공유 범위에 있는 경우) —
      // 원본으로 해소해 등록한다. 컨테이너를 원본처럼 등록하면 같은 행 집합을 이중
      // pull 해 매 pull 폴더 릴레이 재배치(churn)가 된다.
      if (info.linkedOriginalDbId) {
        getLogger().info(
          `[Im-Nobsidian] DB ${dbId}: linked view 컨테이너(원본 ${info.linkedOriginalDbId}) → 원본으로 해소(F25)`,
        );
        return { kind: "linked", originalDbId: info.linkedOriginalDbId };
      }
      if (!info.queryable) {
        // linked database view 컨테이너는 data_sources 가 비지만 Views API 로 원본을
        // 알 수 있다(F22). 해소되면 접근 불가가 아니라 "원본으로 향하는 참조"로 취급한다.
        const linked = await this.notionClient.resolveLinkedDatabase(dbId);
        if (linked) {
          getLogger().info(
            `[Im-Nobsidian] DB ${dbId}: linked view("${linked.viewName}") → 원본 ${linked.originalDbId} 로 해소`,
          );
          return { kind: "linked", originalDbId: linked.originalDbId };
        }
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
        const fileBase = (parts.pop() ?? "").replace(/\.md$/, "");
        const dirName = parts[parts.length - 1] ?? "";
        // folder note(파일명==폴더명)면 그 폴더가 곧 페이지 폴더. 아니면(플레인 페이지·
        // DB row 파일) 페이지 이름의 하위 폴더로 중첩해 Notion 의 "페이지 안의 DB" 구조를
        // 보존한다 — dirname 을 쓰면 형제 row 들이 가진 동명 DB 가 한 폴더에서 충돌한다
        // (만다라트 81개 셀 페이지가 각자 동명 체크리스트 DB 를 갖는 실측 사례).
        parentFolder =
          fileBase === dirName ? parts.join("/") : [...parts, fileBase].filter(Boolean).join("/");
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

  /** linked view 컨테이너 → 원본 DB 매핑을 상태 메타에서 로드한다(nohyph → nohyph). */
  private loadLinkedDbMap(): Map<string, string> {
    const raw = this.stateDb.getMeta(LINKED_DBS_META_KEY);
    if (!raw) return new Map();
    try {
      const obj = JSON.parse(raw) as Record<string, string>;
      return new Map(
        Object.entries(obj).map(([k, v]) => [k.replace(/-/g, ""), v.replace(/-/g, "")]),
      );
    } catch {
      return new Map();
    }
  }

  private async pullDiscoveredDatabases(
    writtenPaths: string[],
    failed: FailedOperation[],
    conflicts: Conflict[],
    forceRediscovery = false,
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

      // F24: 동명 형제 DB(같은 부모 아래 같은 제목 인라인 DB — 실측 22쌍)는 제목 기반
      // 폴더 유도가 충돌해 .base/사이드카를 서로 덮어쓰고 행이 한 폴더에 섞인다.
      // 폴더 점유 대장을 두고 ① 캐시의 기존 충돌을 결정적으로 수리(첫 항목이 원 폴더
      // 유지)하고 ② 신규 등록도 같은 대장을 거치게 한다. 사용자 설정 DB 폴더는 선점.
      const folderOwner = new Map<string, string>(
        (this.config.notion.databases ?? []).map((d) => [d.localFolder, d.databaseId]),
      );
      const repairedCount = repairDbFolderCollisions(dbConfigs, folderOwner);
      for (const c of dbConfigs) folderOwner.set(c.localFolder, c.databaseId);
      if (repairedCount > 0) {
        changed = true;
        getLogger().info(`[Im-Nobsidian] 동명 DB 폴더 충돌 ${repairedCount}건 분리(F24)`);
      }
      const claimFolder = (config: { databaseId: string; localFolder: string }): void => {
        config.localFolder = resolveDbFolderPath(
          config.localFolder,
          config.databaseId,
          (f) => folderOwner.get(f) ?? null,
        );
        folderOwner.set(config.localFolder, config.databaseId);
      };

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

      // --force: 과거 접근 불가로 강등된 DB 를 재검증한다(F23). 공유 복구·linked 해소
      // 지원 추가 후에도 denylist 가 영구 차단해 구제 경로가 없었다. 비우면 재발견 루프가
      // 다시 만나는 항목은 fresh 평가되고, 여전히 불가면 degrade 로 재편입된다.
      if (forceRediscovery && inaccessibleIds.size > 0) {
        getLogger().info(
          `[Im-Nobsidian] --force: 접근 불가 DB ${inaccessibleIds.size}개 denylist 재검증`,
        );
        inaccessibleIds.clear();
        inaccessibleChanged = true;
      }

      // linked view 컨테이너 → 원본 DB 매핑. placeholder 임베드 재작성이 원본 .base 로
      // 향하게 하고, 해소 완료 컨테이너의 재해소(건당 API ~4회)를 건너뛰게 한다.
      const linkedMap = this.loadLinkedDbMap();
      let linkedChanged = false;

      // 발견 1건 등록 — 원본 DB 면 설정 추가, linked view 컨테이너면 원본으로 해소해 매핑
      // 기록 후 원본을 같은 부모 아래로 등록한다. 해소는 1홉: 원본이 또 linked 면(순환·
      // 다단 참조) 접근 불가로 강등해 무한 추적을 차단한다.
      const register = async (dbId: string, parentPageId: string): Promise<void> => {
        const nohyph = dbId.replace(/-/g, "");
        if (knownIds.has(nohyph) || inaccessibleIds.has(nohyph)) return;

        const registerOriginal = async (origNohyph: string): Promise<void> => {
          if (knownIds.has(origNohyph) || inaccessibleIds.has(origNohyph)) return;
          const origId = normalizeNotionId(origNohyph);
          const outcome = await this.buildDiscoveredDbConfig(origId, parentPageId);
          knownIds.add(origNohyph);
          if (outcome.kind === "ok") {
            claimFolder(outcome.config);
            dbConfigs.push(outcome.config);
            changed = true;
          } else if (outcome.kind !== "error") {
            degrade(origId);
          }
        };

        // 이미 해소된 컨테이너는 재해소하지 않고 원본 등록만 보정한다.
        const knownOriginal = linkedMap.get(nohyph);
        if (knownOriginal) {
          await registerOriginal(knownOriginal);
          return;
        }

        const outcome = await this.buildDiscoveredDbConfig(dbId, parentPageId);
        knownIds.add(nohyph);
        if (outcome.kind === "ok") {
          claimFolder(outcome.config);
          dbConfigs.push(outcome.config);
          changed = true;
        } else if (outcome.kind === "linked") {
          const origNohyph = outcome.originalDbId.replace(/-/g, "");
          linkedMap.set(nohyph, origNohyph);
          linkedChanged = true;
          await registerOriginal(origNohyph);
        } else if (outcome.kind === "inaccessible") {
          degrade(dbId);
        }
      };

      // (1) 블록 스캔 기반 발견 — 추적 페이지마다 직속 children 1회 조회로 비용이 크므로
      //     캐시가 비었을 때(최초 full pull)만 수행한다. 이후 생긴 신규 child DB 는 이
      //     게이트 탓에 복구 경로가 없었으므로(F21), --force 시에는 재스캔을 허용한다.
      if (dbConfigs.length === 0 || forceRediscovery) {
        const discovered = await this.discoverChildDatabases();
        for (const { dbId, parentPageId } of discovered) {
          await register(dbId, parentPageId);
        }
      }

      // (2) markdown 기반 발견 — 추가 API 호출 없이 컬럼/synced_block 내부 깊이 중첩된
      //     child_database 까지 포착한다. 이번 pull 에서 재취득된 페이지에 한해 채워지므로
      //     캐시 유무와 무관하게 항상 병합한다(증분 pull·업그레이드 시 신규 DB 흡수).
      for (const [nohyph, parentPageId] of this._inlineDbRefs) {
        await register(normalizeNotionId(nohyph), parentPageId);
      }

      // 동기화 가능한 DB 만 처리하고, 캐시에 잔존하던 접근 불가 DB 는 건너뛴다.
      // 처리에 성공/일시실패한 DB 만 stillSyncable 로 모아 캐시의 권위적 스냅샷으로 삼는다.
      // DB row 페이지 본문에도 child DB/linked view 가 중첩될 수 있으므로(만다라트 셀·OKR
      // 회의록 등 — E2E 실측 140건), 라운드 사이에 이번 라운드가 기록한 row md 를 스캔해
      // 신규 발견을 등록하고 발견이 마를 때까지 반복한다. 페이지 pull 경로(_inlineDbRefs)만
      // 스캔하던 기존 구현은 row 내부 DB 를 어떤 pull 에서도 발견하지 못했다.
      const stillSyncable: typeof dbConfigs = [];
      let queue = [...dbConfigs];
      const MAX_DISCOVERY_ROUNDS = 4;
      // F25: linked view 컨테이너 판정 시 행 소유를 양보할 원본 폴더 탐색. 디스커버리
      // 캐시(dbConfigs — 이번 라운드 신규 등록 포함)와 사용자 명시 설정을 함께 본다.
      const resolveDbFolder = (dbId: string): string | null => {
        const key = dbId.replace(/-/g, "");
        const hit =
          dbConfigs.find((c) => c.databaseId.replace(/-/g, "") === key) ??
          (this.config.notion.databases ?? []).find((c) => c.databaseId.replace(/-/g, "") === key);
        return hit?.localFolder ?? null;
      };
      for (let round = 1; queue.length > 0; round++) {
        const roundRowPaths: string[] = [];
        for (const dbConfig of queue) {
          if (inaccessibleIds.has(dbConfig.databaseId.replace(/-/g, ""))) continue;
          try {
            const dbResult = await this.databaseSyncer.pullDatabase(dbConfig, { resolveDbFolder });
            // F25: linked view 컨테이너로 판정 — 행은 원본 config 가 단일 소유한다.
            // 매핑을 기록하고(placeholder 임베드가 원본 .base 로 향하게) 캐시에서 제거해
            // 다음 pull 부터 이중 방문 자체를 없앤다. .base 재지향은 pullDatabase 가 마쳤다.
            if (dbResult.linkedOriginalDbId) {
              linkedMap.set(
                dbConfig.databaseId.replace(/-/g, ""),
                dbResult.linkedOriginalDbId.replace(/-/g, ""),
              );
              linkedChanged = true;
              changed = true;
              getLogger().info(
                `[Im-Nobsidian] DB ${dbConfig.databaseId}: linked view 컨테이너 감지 → 행은 원본 ${dbResult.linkedOriginalDbId} 폴더가 단일 소유(F25)`,
              );
              continue;
            }
            created += dbResult.created;
            updated += dbResult.updated;
            conflicts.push(...dbResult.conflicts);
            failed.push(...dbResult.failed);
            // M3: 슬라이스 추정 대신 실제 기록된 행 경로를 후처리 대상으로 받는다.
            writtenPaths.push(...dbResult.writtenPaths);
            roundRowPaths.push(...dbResult.writtenPaths);
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

        const before = dbConfigs.length;
        for (const ref of await this.collectRowInlineRefs(roundRowPaths)) {
          await register(ref.dbId, ref.parentPageId);
        }
        queue = dbConfigs.slice(before);
        if (queue.length > 0 && round >= MAX_DISCOVERY_ROUNDS) {
          // 등록은 이미 캐시(dbConfigs)에 반영됐으므로 다음 pull 의 캐시 루프가 이어받는다.
          getLogger().warn(
            `[Im-Nobsidian] 중첩 DB 발견 라운드 한도(${MAX_DISCOVERY_ROUNDS}) 도달 — ${queue.length}개는 다음 pull 에서 동기화`,
          );
          stillSyncable.push(...queue);
          break;
        }
        if (queue.length > 0) {
          getLogger().info(
            `[Im-Nobsidian] DB row 본문에서 중첩 DB ${queue.length}개 추가 발견(라운드 ${round + 1})`,
          );
        }
      }

      // 발견·강등·정리 결과를 캐시에 1회 반영(접근 불가 DB 는 stillSyncable 에서 빠져 제거됨).
      if (changed || inaccessibleChanged || stillSyncable.length !== dbConfigs.length) {
        this.stateDb.setMeta("discovered_dbs", JSON.stringify(stillSyncable));
      }
      if (inaccessibleChanged) {
        this.stateDb.setMeta(INACCESSIBLE_DBS_META_KEY, JSON.stringify([...inaccessibleIds]));
      }
      if (linkedChanged) {
        this.stateDb.setMeta(LINKED_DBS_META_KEY, JSON.stringify(Object.fromEntries(linkedMap)));
      }

      // 이번 pull 산출 md 의 인라인 DB placeholder 를 .base 임베드로 재작성한다(F22).
      // .base 생성(위 pullDatabase)이 끝난 뒤여야 임베드가 깨진 링크가 되지 않는다.
      await this.rewriteDbPlaceholderEmbeds(writtenPaths, stillSyncable, linkedMap);
    } catch (error) {
      getLogger().warn("[Im-Nobsidian] child_database 자동 발견 실패:", error);
    }

    return { created, updated };
  }

  /**
   * pull 산출 md 의 인라인 DB placeholder(`**제목** *(Notion DB)*` + 보존 마커)를
   * `![[<실제 .base 경로>|제목]]` 임베드로 재작성한다(F22) — folder note 본문에서
   * DB 가 텍스트 한 줄이 아니라 실제 Bases 뷰로 보이게 하는 마지막 조각. linked view
   * 컨테이너는 linkedMap 을 거쳐 원본 DB 의 .base 로 향한다. .base 경로는 DatabaseSyncer
   * 가 실제 기록한 경로(baseFileInfo)가 SSOT — 폴더명과 .base 파일명은 새니타이즈 규칙이
   * 달라(공백→하이픈 vs 공백 보존) localFolder 로 추측하면 깨진 임베드가 된다(E2E 실측
   * 91/158건). 최종적으로 .base 실존까지 확인해, 없으면 placeholder 를 마커째 보존한다.
   */
  private async rewriteDbPlaceholderEmbeds(
    paths: string[],
    dbConfigs: Array<{ databaseId: string; localFolder: string }>,
    linkedMap: Map<string, string>,
  ): Promise<void> {
    const targets = new Map<string, DbEmbedTarget>();
    const addTarget = (databaseId: string, localFolder: string): void => {
      const nohyph = databaseId.replace(/-/g, "");
      if (targets.has(nohyph)) return;
      const info = this.databaseSyncer.baseFileInfo.get(nohyph);
      if (info) {
        targets.set(nohyph, { basePath: info.basePath, title: info.title });
        return;
      }
      // 이번 실행에서 .base 를 기록하지 못한 DB(생성 실패 등) — 추측 경로는 아래
      // 실존 확인을 통과해야만 대상이 된다.
      const safeName = localFolder.split("/").pop() ?? localFolder;
      targets.set(nohyph, { basePath: `${localFolder}/${safeName}.base`, title: safeName });
    };
    for (const cfg of dbConfigs) addTarget(cfg.databaseId, cfg.localFolder);
    // 수동 구성 DB 도 대상 — 본문 placeholder 가 이들을 가리킬 수 있다.
    for (const d of this.config.notion.databases ?? []) addTarget(d.databaseId, d.localFolder);
    // 깨진 임베드 방지의 최종 방벽: 대상 .base 가 디스크에 실존하는 경우에만 재작성한다.
    // 탈락한 id 의 placeholder 는 마커째 남아 다음 pull 에서 재시도된다.
    for (const [key, t] of [...targets]) {
      if (!(await this.vaultFs.exists(t.basePath))) targets.delete(key);
    }
    if (targets.size === 0) return;

    const resolve = (nohyph: string): DbEmbedTarget | null =>
      targets.get(nohyph) ?? targets.get(linkedMap.get(nohyph) ?? "") ?? null;

    let total = 0;
    for (const filePath of paths) {
      if (!filePath.endsWith(".md")) continue;
      try {
        const content = await this.vaultFs.readFile(filePath);
        const { content: next, rewrites } = rewriteDbPlaceholders(content, resolve);
        if (rewrites === 0) continue;
        await this.vaultFs.writeFile(filePath, next);
        total += rewrites;
        // 디스크 내용이 바뀌었으므로 해시·스냅샷·stat 을 재동기화한다 — 누락하면 저장
        // 해시(placeholder 형태)와 디스크(임베드 형태)가 영구 불일치해 매 sync 마다
        // "modified" 로 재감지되는 fixpoint 위반(I5)이 재발한다.
        const record = this.stateDb.getByPath(filePath);
        if (record) {
          const stat = await this.vaultFs.getFileStat(filePath);
          this.stateDb.transaction(() => {
            this.stateDb.updateHash(record.id, computeHash(next), Buffer.from(next, "utf-8"));
            if (stat) this.stateDb.updateStatCache(record.id, stat.mtime, stat.size);
          });
        }
      } catch {
        // 파일 읽기/쓰기 실패 — 재작성은 best-effort, placeholder 는 마커째 보존돼 다음 pull 재시도
      }
    }
    if (total > 0) {
      getLogger().info(`[Im-Nobsidian] 인라인 DB 임베드 재작성: ${total}건`);
    }
  }

  private async resolveNotionLinks(paths: string[]): Promise<number> {
    let totalResolved = 0;
    const allRecords = this.stateDb.getAll();
    const idToTitle = new Map<string, string>();
    for (const r of allRecords) {
      if (r.notionPageId && r.obsidianPath) {
        // M4: 단일 변환 패스(resolvePageId)와 동일한 규칙으로 위키링크 텍스트를 만든다.
        const title = wikilinkTitleFromPath(r.obsidianPath);
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

        // frontmatter 의 relation/people 원시 UUID → `[[제목]]`. 변환 시점에는 대상
        // 페이지가 미등록이라 UUID 로 남지만, 이 post-pass 시점엔 맵이 완성돼 해소된다.
        const fm = resolveFrontmatterRelations(content, idToTitle);
        if (fm.count > 0) {
          content = fm.content;
          totalResolved += fm.count;
          changed = true;
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

    await this.imageHandler.uploadAndAppendImages(page.id, conversionResult.images, path);

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

    await this.imageHandler.uploadAndAppendImages(
      record.notionPageId,
      conversionResult.images,
      path,
    );

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

    // notionLastEdited 는 반드시 Notion 서버가 돌려준 값으로 저장한다. 로컬 시각
    // (new Date())을 쓰면 서버 시각과 클록 스큐·네트워크 지연만큼 어긋나 다음 pull 이
    // 가짜 modified 로 오인 → 불필요 재조회·집계(false-churn). 속성 갱신이 있으면 그
    // 응답이 최종 mutation 이라 권위값이고, 없으면(블록/이미지만 변경) 1회 getPage 로
    // 권위값을 받아 진짜 fixpoint 를 만든다. (I5 — pull 측 content_hash 가드와 이중 차단)
    let lastEditedTime: string;
    if (propsToUpdate && Object.keys(propsToUpdate).length > 0) {
      const updatedPage = await this.notionClient.updatePageProperties(
        record.notionPageId,
        propsToUpdate,
      );
      lastEditedTime = updatedPage.last_edited_time;
    } else {
      const refreshed = await this.notionClient.getPage(record.notionPageId);
      lastEditedTime = refreshed.last_edited_time;
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

  // ──────────────────────────────────────────────────────────────────────────
  // 충돌 해소 (I8) — 해소 결과를 로컬에만 쓰지 않고 Notion 으로 재push + notionLastEdited
  // 재조정까지 한 트랜잭션으로 묶는다. ConflictResolver 단독은 로컬 write + updateHash 만
  // 수행하므로(merge 결과가 Notion 에 반영되지 않음) 다음 pull 이 원격으로 덮어써 영구
  // 유실·충돌 루프가 발생한다. 해소 → 전파(propagate)를 오케스트레이터에서 봉합해 무손실
  // 보장. 변환 파이프라인이 필요한 push 는 기존 엔터프라이즈 경로(pushUpdate)를 재사용한다.
  // ──────────────────────────────────────────────────────────────────────────

  /** 단일 충돌을 사용자가 고른 선택지(local/remote/merge/duplicate)로 해소 + Notion 전파. */
  async resolveConflict(conflict: Conflict, choice: ResolutionChoice): Promise<ResolutionResult> {
    const result = await this.conflictResolver.resolve(conflict, choice);
    await this.propagateResolution(conflict, choice, result);
    return result;
  }

  /** 단일 충돌을 전략(manual/local-first/remote-first/duplicate)으로 해소 + Notion 전파. */
  async resolveConflictByStrategy(
    conflict: Conflict,
    strategy: ConflictStrategy,
  ): Promise<ResolutionResult> {
    const result = await this.conflictResolver.resolveByStrategy(conflict, strategy);
    await this.propagateResolution(conflict, strategyToChoice(strategy), result);
    return result;
  }

  /** 여러 충돌을 동일 전략으로 일괄 해소 + Notion 전파. */
  async resolveAllConflicts(
    conflicts: Conflict[],
    strategy: ConflictStrategy,
  ): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];
    for (const conflict of conflicts) {
      results.push(await this.resolveConflictByStrategy(conflict, strategy));
    }
    return results;
  }

  /** 충돌 미리보기용 통합 diff(원본 vs 로컬 vs 원격). 해소 없이 표시 전용. */
  generateConflictDiff(conflict: Conflict): string {
    return this.conflictResolver.generateDiff(conflict);
  }

  /**
   * 해소 결과를 Notion 으로 전파해 로컬↔원격 일관성을 봉합한다.
   * - remote 선택: 로컬이 원격으로 갱신됐을 뿐이므로 push 불필요. notionLastEdited 만
   *   원격 변경의 lastEdited 로 재조정 → 다음 pull 이 같은 변경을 재충돌로 보지 않음.
   * - merge 실패(충돌 마커 잔존): 사용자가 직접 풀어야 하므로 conflict 상태 유지·push 안 함.
   * - local / merge(성공) / duplicate: 해소된 로컬 내용을 Notion 에 재push(pushUpdate 가
   *   변환·이미지·속성·해시·notionLastEdited 를 한 트랜잭션으로 재조정) → 무손실 수렴.
   */
  private async propagateResolution(
    conflict: Conflict,
    choice: ResolutionChoice,
    result: ResolutionResult,
  ): Promise<void> {
    const record = conflict.syncRecord;
    if (!record.notionPageId) return;

    if (choice === "remote") {
      this.stateDb.setNotionLastEdited(record.id, conflict.remoteChange.lastEdited);
      return;
    }

    // merge 가 충돌 마커를 남긴 경우(자동 병합 실패) → push 하지 않고 conflict 상태 유지.
    if (!result.success) return;

    // local / merge(성공) / duplicate: 해소된 로컬 본문을 Notion 으로 재push.
    await this.pushUpdate(record.obsidianPath);
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
      // 디스커버리 이중 전략(비용 상한 하이브리드):
      //  1) 기본 — root 서브트리 직접 BFS 순회(getChildPagesRecursive). 비용이 실제 동기화
      //     대상(서브트리)에 비례해, 작은 볼트가 수천 페이지 워크스페이스에 있어도 빠르다
      //     (I10: 2-파일 볼트 pull ~12s). 단 비용은 서브트리 **전체 블록 수**에 비례하므로,
      //  2) 콘텐츠가 많은 대규모 서브트리에서는 시간 예산(DISCOVERY_RECURSIVE_BUDGET_MS)을
      //     초과할 수 있다. 그 경우 워크스페이스 search 기반 디스커버리로 폴백한다(비용이
      //     워크스페이스 페이지 수에 비례·예측가능·유한). 두 경로 모두 중첩 깊이와 무관하게
      //     모든 하위 페이지를 찾으므로 **무손실**이며, DB 행·archive/in_trash 를 동일하게
      //     제외해 orphan(삭제) 판정도 일관된다.
      let underRoot: PageObjectResponse[];
      try {
        underRoot = await this.notionClient.getChildPagesRecursive(this.config.notion.rootPageId, {
          deadlineMs: Date.now() + SyncOrchestrator.DISCOVERY_RECURSIVE_BUDGET_MS,
        });
      } catch (error) {
        if (!(error instanceof DiscoveryTooLargeError)) throw error;
        getLogger().info(
          `[Im-Nobsidian] 서브트리가 큼(${error.message}) → 워크스페이스 search 기반 디스커버리로 전환`,
        );
        underRoot = await this.notionClient.getPagesUnderRootViaSearch(
          this.config.notion.rootPageId,
        );
      }
      // 폴더 판정용 _childParentIds: 발견된 각 페이지의 부모(자식을 가진 페이지)를 수집한다.
      // 부모가 page_id 면 추가 API 호출 없이 즉시 해석(공통 경로), block 중첩만 1회 조회.
      this._childParentIds.add(normalizeNotionId(this.config.notion.rootPageId));
      for (const page of underRoot) {
        const parentId = await this.extractParentId(page);
        if (parentId) this._childParentIds.add(normalizeNotionId(parentId));
      }
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

  /**
   * 증분 원격 변경 감지 — `since` 이후 수정된 페이지만 search 로 받아 created/modified 만
   * 만든다. **삭제는 의도적으로 감지하지 않는다**: search API 는 in_trash/archived 페이지를
   * 반환하지 않아(=사라진 것을 증분만으로는 구분 불가) 삭제 판정에는 전체 enumeration 이
   * 필수다. 따라서 호출부는 `deleteSync` 가 켜진 경우 이 fast-path 를 쓰지 않고
   * `detectRemoteChanges`(전체 스캔, 삭제 diff 포함)로 우회한다. (I10)
   */
  private async detectRemoteChangesIncremental(since: string): Promise<RemoteChange[]> {
    const changes: RemoteChange[] = [];
    this._childParentIds.clear();
    // 안전창만큼 과거로 되돌려 조회(F20). 넓어진 창에 들어온 무변경 페이지는 아래
    // last_edited 비교가 걸러내므로 재처리 비용 없이 멱등하다.
    const sinceMs = Date.parse(since);
    const safeSince = Number.isFinite(sinceMs)
      ? new Date(sinceMs - INCREMENTAL_SAFETY_WINDOW_MS).toISOString()
      : since;
    const recentPages = await this.notionClient.searchRecentPages(safeSince);

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
   * 추적 중(sync_state)인데 디스크에서 사라진 파일을 찾는다.
   *
   * 원격 변경 감지(detectRemoteChanges*)는 "Notion 에서 바뀐 것"만 본다. 로컬에서 파일이
   * 지워진 경우는 어느 경로로도 잡히지 않아, 재pull 해도 `--force` 로도 되살아나지 않고
   * 영구히 발산했다. push 는 deleteSync=false 면 원격을 지우지 않으므로 사용자에겐 복구
   * 수단이 볼트 전체 초기화밖에 남지 않는다 — 이 스캔이 그 마지막 구멍을 막는다.
   *
   * 레코드마다 stat 을 던지면 1000건 규모에서 수 초가 든다. 볼트 워크 1회로 실재 목록을
   * 만든 뒤 차집합을 취한다(md). md 가 아닌 추적 레코드는 수가 적어 개별 확인으로 남긴다.
   *
   * 로컬 이름변경·이동은 "사라짐" 과 구별해야 한다 — 되살리면 원본과 새 이름의 사본이
   * 둘 다 남는다. push 의 detectMoves 와 같은 기준(내용 해시 일치)을 쓰되, 볼트 전체를
   * 해시하지 않도록 크기가 같은 미추적 파일만 후보로 좁혀 확인한다.
   */
  private async detectMissingLocalFiles(paths?: string[]): Promise<SyncRecord[]> {
    // deleteSync 가 켜져 있으면 로컬 삭제는 "원격에도 지우라" 는 의사 표시다. sync() 는
    // pull 을 먼저 돌리므로 여기서 되살리면 뒤이은 push 가 지울 대상을 잃어 삭제 의도가
    // 통째로 무효화된다. 복원은 삭제를 전파할 수단이 아예 없는 설정(deleteSync=false)
    // 에서만 유일하게 옳은 해석이다.
    if (this.config.sync.deleteSync) return [];

    const records = this.stateDb.getAll();
    if (records.length === 0) return [];

    const scoped = records.filter(
      (r) =>
        // folder-only 는 실체가 폴더라 파일 부재가 정상. db-row 는 매 pull 마다
        // database-syncer 가 전 행을 훑으며 같은 복원 판정을 이미 거치므로 여기서
        // 중복 처리하면 행 전용 frontmatter 없이 본문만 쓰는 잘못된 경로로 샌다.
        (r.fileType === "file" || r.fileType === "folder-note") &&
        r.notionPageId !== null &&
        (!paths?.length || paths.some((p) => r.obsidianPath.startsWith(p))),
    );
    if (scoped.length === 0) return [];

    const stats = await this.vaultFs.listMarkdownFileStats();
    const live = new Set(stats.map((f) => f.path));

    const candidates: SyncRecord[] = [];
    for (const record of scoped) {
      if (record.obsidianPath.endsWith(".md")) {
        if (!live.has(record.obsidianPath)) candidates.push(record);
      } else if (!(await this.vaultFs.exists(record.obsidianPath))) {
        candidates.push(record);
      }
    }
    if (candidates.length === 0) return [];

    // 이름이 바뀐 파일은 추적 경로에 없다 — 미추적 실재 파일만 크기별로 색인한다.
    const tracked = new Set(records.map((r) => r.obsidianPath));
    const untrackedBySize = new Map<number, string[]>();
    for (const f of stats) {
      if (tracked.has(f.path)) continue;
      const bucket = untrackedBySize.get(f.size);
      if (bucket) bucket.push(f.path);
      else untrackedBySize.set(f.size, [f.path]);
    }

    const hashCache = new Map<string, string | null>();
    const hashOf = async (path: string): Promise<string | null> => {
      const cached = hashCache.get(path);
      if (cached !== undefined) return cached;
      let hash: string | null = null;
      try {
        hash = computeHash(await this.vaultFs.readFile(path));
      } catch {
        // 못 읽는 파일은 이름변경 판정에서 제외 — 확신 없이 복원을 취소하지 않는다.
      }
      hashCache.set(path, hash);
      return hash;
    };

    const missing: SyncRecord[] = [];
    for (const record of candidates) {
      // localFileSize 는 크기 버킷으로 후보를 좁히는 최적화일 뿐이다. 구버전이 남긴
      // 레코드처럼 값이 없으면 버킷을 못 고르는데, 여기서 빈 배열로 끝내면 이름변경을
      // 놓쳐 원본 이름 사본이 되살아난다. 미추적 마크다운은 정상 볼트에서 거의 0건이라
      // (실측: 추적 1189 / 볼트 md 1189) 전수 대조로 폴백해도 비용이 없다.
      const sameSize =
        record.localFileSize !== null
          ? (untrackedBySize.get(record.localFileSize) ?? [])
          : [...untrackedBySize.values()].flat();
      let renamed = false;
      for (const path of sameSize) {
        if ((await hashOf(path)) === record.contentHash) {
          renamed = true;
          break;
        }
      }
      if (!renamed) missing.push(record);
    }
    return missing;
  }

  private async pullCreate(pageId: string): Promise<string> {
    const page = await this.notionClient.getPage(pageId);
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const parentPath = await this.resolveParentPath(page);

    const hasChildPages = await this.pageHasChildContainers(pageId);

    const { content: markdown, compact: exportCompact } = await this.fetchPageMarkdown(pageId);
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
    // D2(page 모드): 파일명 stem 으로 복원 가능한 제목은 프론트매터에 주입하지 않는다 —
    // 원본에 없던 `title:` 키가 pull 마다 생기는 가짜 diff 의 원인. sanitize·`(1)` 접미사로
    // 파일명이 제목과 달라진 경우만 보존한다(DB 모드 title 은 Name 컬럼 데이터라 항상 유지).
    if (this.isDatabaseMode || extractTitle(filePath) !== title) {
      properties.title = title;
    }

    let processedMarkdown = markdown;
    if (this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title, pageId);
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
   * 1차: 발견 단계(서브트리 순회/증분)에서 전 페이지의 부모를 해소하며 만든
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

  private async pullUpdate(
    change: RemoteChange,
  ): Promise<{ path?: string; conflict?: Conflict; unchanged?: boolean }> {
    const record = this.stateDb.getByNotionId(change.pageId);
    if (!record) return {};

    const page = await this.notionClient.getPage(change.pageId);

    // 리모트가 휴지통/보관 상태인데 로컬 파일도 없다면 양쪽 다 없는 것이다 — 복원 스캔이
    // 올린 항목이라도 되살릴 원본이 없으므로 빈 껍데기를 만들지 않고 무동작으로 끝낸다.
    // (deleteSync 가 켜져 있으면 전체 스캔이 이 페이지를 deleted 로 따로 처리한다.)
    const remoteGone =
      (page as { in_trash?: boolean }).in_trash === true ||
      (page as { archived?: boolean }).archived === true;
    if (remoteGone && !(await this.vaultFs.exists(record.obsidianPath))) {
      return { unchanged: true };
    }

    const fetched = await this.fetchPageMarkdown(change.pageId);
    let markdown = fetched.content;

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
    // D2: pullCreate 와 동일 — 파일명으로 복원 가능한 제목은 주입하지 않는다.
    if (this.isDatabaseMode || extractTitle(record.obsidianPath) !== title) {
      properties.title = title;
    }

    if (this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title, change.pageId);
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
      {
        properties,
        preserveMarkers: savedMarkers.length > 0 ? savedMarkers : undefined,
        notionExportCompact: fetched.compact,
      },
    );

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

    const resolution = resolvePullConflict({
      record,
      localContent,
      localExists,
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

    // I5 false-churn 차단: 리모트 변환 결과가 디스크 내용과 바이트 동일하면 Notion 이
    // last_edited 만 갱신한 '가짜 수정'이다. 파일을 재기록하면 mtime 이 바뀌어 다음 push 가
    // 로컬 수정으로 오인 → push↔pull 무한 churn. 파일은 건드리지 않고 추적 메타
    // (notionLastEdited)만 현재 원격값으로 정렬해 재감지를 멈춘다. content_hash 비교로
    // 진짜 변경과 가짜 변경을 구분하는 핵심 멱등 지점이다.
    // localExists 를 반드시 함께 본다: 파일이 사라졌고 원격도 빈 페이지면 둘 다 "" 라
    // 동일 판정이 나면서 파일을 되쓰지 않고 synced 로 마감돼 삭제가 굳는다.
    if (localExists && remoteContent === localContent) {
      const stat = await this.vaultFs.getFileStat(record.obsidianPath);
      this.stateDb.upsert({
        obsidianPath: record.obsidianPath,
        notionPageId: change.pageId,
        notionParentId: record.notionParentId,
        contentHash: computeHash(remoteContent),
        notionLastEdited: page.last_edited_time,
        localLastModified: record.localLastModified,
        syncDirection: record.syncDirection,
        fileType: record.fileType,
        status: "synced",
        baseSnapshot: Buffer.from(remoteContent, "utf-8"),
        localMtime: stat?.mtime ?? record.localMtime ?? null,
        localFileSize: stat?.size ?? record.localFileSize ?? null,
      });
      return { path: record.obsidianPath, unchanged: true };
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

  private async fetchPageMarkdown(pageId: string): Promise<{ content: string; compact: boolean }> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      try {
        const result = await this.notionClient.getPageMarkdown(pageId);
        this.collectInlineDbRefs(pageId, result.markdown);
        return {
          content: this.resolveNotionIdWikilinks(notionEnhancedToObsidian(result.markdown)),
          // 압축형 판정은 반드시 원시 export 기준 — enhanced 변환이 <empty-block/> 을
          // 빈 줄로 바꾼 뒤에는 BlockSpacer 가 저작형과 구분할 수 없다(D1).
          compact: isCompactExport(result.markdown),
        };
      } catch {
        // Markdown API 실패 시 blocks API fallback
      }
    }
    // blocks-API 폴백 산출물은 이미 표준 간격 — 재간격 불필요.
    // 폴백 변환기도 child-database 보존 마커를 발행하므로 인라인 DB 수집을 이어간다.
    const fallback = await this.blockConverter.notionBlocksToMarkdown(pageId);
    this.collectInlineDbRefs(pageId, fallback);
    return { content: fallback, compact: false };
  }

  // Markdown API는 인라인 데이터베이스를 <database url="..." ...>Title</database> 로 렌더한다
  // (컬럼/콜아웃/synced_block 내부 포함). url 의 32자리 hex 가 databaseId 이므로 블록 트리
  // 재귀 없이 이 신호만으로 깊이 중첩된 child_database 를 발견한다. url 호스트는
  // www.notion.so / app.notion.com/p 두 형태가 실측돼 고정하지 않는다 — 규칙은
  // extractInlineDbIds(blocks-API 폴백 마커 겸용) 참조.
  private collectInlineDbRefs(parentPageId: string, rawMarkdown: string): void {
    for (const dbId of extractInlineDbIds(rawMarkdown)) {
      this._inlineDbRefs.set(dbId, parentPageId);
    }
  }

  /**
   * 이번 라운드에 기록된 DB row md 를 읽어 본문의 인라인 DB 참조를 수집한다.
   * row 페이지는 DatabaseSyncer 자체 파이프라인으로 변환돼 fetchPageMarkdown 의
   * _inlineDbRefs 수집을 타지 않는다 — 디스크에 남은 보존 마커가 유일한 발견 신호다.
   * 부모 Notion 페이지 id 는 state DB 역조회(getByPath)로 얻는다(row upsert 직후라 항상 존재).
   */
  private async collectRowInlineRefs(
    rowPaths: string[],
  ): Promise<Array<{ dbId: string; parentPageId: string }>> {
    const refs: Array<{ dbId: string; parentPageId: string }> = [];
    for (const path of rowPaths) {
      if (!path.endsWith(".md")) continue;
      try {
        const ids = extractInlineDbIds(await this.vaultFs.readFile(path));
        if (ids.length === 0) continue;
        const record = this.stateDb.getByPath(path);
        if (!record?.notionPageId) continue;
        for (const id of ids) {
          refs.push({ dbId: normalizeNotionId(id), parentPageId: record.notionPageId });
        }
      } catch {
        // 방금 기록한 파일 읽기 실패 — 발견은 best-effort, 다음 pull 재시도
      }
    }
    return refs;
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
