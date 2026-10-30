import { DECORATION_KEYS } from "../notion/decoration-values.js";
import type { Config, DatabaseSyncConfig } from "../types/config.js";
import type { IStateDB } from "../state/state-db-interface.js";
import { isNotionObjectNotFound, type DatabaseMeta, type NotionClient } from "../notion/client.js";
import { readLocalNote, type VaultFS } from "./vault-fs.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import type {
  Conflict,
  FailedOperation,
  ProgressItem,
  RemoteMove,
  RemoteMoveSkip,
  SchemaFollowed,
  SyncRecord,
} from "../types/sync.js";
import type { BasePropertySchema, DatabaseViewsConfig } from "../types/view.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { PropertyMapper, RANGE_END_SUFFIX } from "../notion/property-mapper.js";
import type { ImageHandler } from "./image-handler.js";
import { resolvePullConflict, sameNoteContent } from "./conflict-detector.js";
import type { PullOutcome } from "./pull-outcome.js";
import { UpdateJournal } from "./update-journal.js";
import {
  applyRemoteDeletion,
  decideRemoteDeletion,
  remoteDeletionChange,
  remotePresence,
} from "./remote-deletion.js";
import { diffRowProperties } from "./row-properties.js";
import { extractAliases, noteTitle, retitledInNotion } from "./note-title.js";
import { computeHash } from "../utils/hash.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import {
  inClaimOrder,
  pagePathCandidates,
  resolveDbRowPath,
  type PathOwner,
} from "../utils/db-row-path.js";
import {
  databaseFolderName,
  isDirectDbRowPath,
  resolveDbFolderPath,
} from "../utils/db-folder-path.js";
import { childFolderOf, isFolderRecord, parentFolderOf } from "./folder-container.js";
import { loadDatabaseMoves } from "./database-moves.js";
import {
  DISCOVERED_DBS_META_KEY,
  ROOT_DATABASES_FOLDER,
  parseDiscoveredDbs,
} from "./discovered-databases.js";
import { compactNotionId, normalizeNotionId, notionIdsEqual } from "../utils/id.js";
import { inAnyPathScope, matchesPathScope } from "../utils/path-scope.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { stripMarkdownExtension } from "../utils/markdown-path.js";
import { getLogger } from "../utils/logger.js";
import { withDeadline } from "../utils/deadline.js";
import {
  frontmatterLines,
  isEmptyFrontmatterValue,
  replaceFrontmatterLines,
  sameFrontmatterValue,
  snapshotFrontmatter,
  splitFrontmatter,
} from "../utils/frontmatter.js";
import { mergeRowFrontmatter } from "../converter/frontmatter-merge.js";
import { BaseFileGenerator } from "../view/base-file-generator.js";
import { SidecarGenerator, type SidecarAppearance } from "../view/sidecar-generator.js";
import { richTextToNfm } from "../converter/blocks-to-nfm.js";
import { hasPropertiesBlock } from "../converter/post-processors/properties-table-restorer.js";
import { isGeneratedDbArtifact, selectStaleDbArtifacts } from "./stale-db-artifacts.js";
import { DbBaseFiles, type DbBaseFile } from "./db-base-files.js";
import { recordBaseViews } from "./base-view-record.js";
import { SidecarBases } from "./sidecar-bases.js";
import { sidecarPropertiesEdited } from "./sidecar-schema-edit.js";
import {
  SchemaLedger,
  diffSourceSchema,
  isEmptySchemaChange,
  seenSchemaOf,
  sourceKeyOf,
  type SchemaChange,
} from "./schema-ledger.js";
import { rekeyTrackedRows } from "./schema-follow.js";
import { NoteRelocator, baseName, joinPath, within } from "./note-relocation.js";
import type { DatabasePullLedger } from "./remote-scan.js";
import type { AbortLike } from "../utils/pool.js";
import { INTERNAL_DIR, DB_VIEWS_PATH, BASE_SUFFIX, SIDECAR_SUFFIX } from "../constants/paths.js";
import { notionBodyToObsidian } from "./page-body.js";
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
import { PageDecorations, decorationsUnchanged } from "./page-decorations.js";

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

/** dry-run 이 센 행 하나 — 경로와 할 일. `restore` 는 볼트에서 사라진 행을 되살리는 것이다. */
export interface PlannedRow {
  readonly pageId: string;
  readonly path: string;
  /** `move` — Notion 에서 다른 페이지 아래로 옮긴 DB 의 폴더를 옮긴다(`pageId` 는 DB, ADR-047). */
  readonly operation: "create" | "update" | "delete" | "move";
  readonly restore?: boolean;
  /** Notion 에서 DB 안으로 옮긴 페이지가 행이 되며 옮길 것 — 노트와 하위 페이지 폴더 · 옮긴 DB 의 폴더(ADR-047). */
  readonly moves?: readonly RemoteMove[];
  /** 로컬도 고친 행을 실제 pull 이 받지 않는 까닭 — 없으면 받는다. */
  readonly resolution?: PlannedResolution;
}

/**
 * 로컬도 고친 노트를 실제 pull 이 어떻게 처리하나 — 충돌로 남김 · 합침(merge) · 받지 않음(원격이 그대로거나
 * local-first). dry-run 이 미리 알린다.
 */
export type PlannedResolution =
  | { readonly action: "conflict"; readonly conflict: Conflict }
  | { readonly action: "merge" | "skip" };

/**
 * 행을 받는 진행 — 진행 표시가 페이지와 행을 한 목록 · 한 수로 보이게 한다. 행은 DB 를 조회해야 몇
 * 개인지 알아, 받기 전에 이 DB 에서 받을 행 수를 `planned` 로 알리고 행 하나를 마칠 때마다 `done` 을
 * 부른다. 지운 행은 조회에 없어 미리 셀 수 없다 — 지울 때 `planned(1)` 뒤에 `done` 을 부른다.
 */
export interface RowProgress {
  planned(count: number): void;
  done(item: ProgressItem): void;
}

/**
 * 조회한 행 하나에 할 일 — 건너뜀 · 되살림(볼트에서 사라짐) · 받음 · 날짜 모양만 고쳐 씀(원격은 그대로,
 * F-08).
 */
type RowAction = "skip" | "restore" | "pull" | "reform";

function emptyDatabaseSyncResult(): DatabaseSyncResult {
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

export class DatabaseSyncer {
  private readonly propertyMapper: PropertyMapper;
  private decorationsCache?: PageDecorations;
  /**
   * 받은 DB 마다 사이드카에 적을 꾸밈 — 한 pull 이 같은 DB 의 사이드카를 여러 번 다시 만든다(임베드 재작성).
   * 올린 파일 아이콘 · 커버를 그때마다 내려받지 않는다.
   */
  private readonly appearances = new WeakMap<DatabaseMeta, Promise<SidecarAppearance>>();
  private readonly baseFileGenerator = new BaseFileGenerator();
  /** 사용자가 만들거나 고친 `.base` 라 덮어쓰지 않았다고 이미 알린 경로 — 한 pull 이 같은 DB 를 여러 번 다시 쓴다. */
  private readonly keptUserBases = new Set<string>();
  private readonly sidecarGenerator = new SidecarGenerator();
  /** Notion 에서 바꾼 제목으로 이름을 바꾼 행과 실제로 옮긴 차례 — pull 마감이 가져가 다른 노트의 링크를 고친다. */
  private readonly relocator: NoteRelocator;
  private renamedRows: { renamed: RemoteMove[]; applied: RemoteMove[] } = {
    renamed: [],
    applied: [],
  };
  /** 볼트에서 사라져 되살린 행의 경로 — pull 마감이 가져가 화면에 알린다(D8). */
  private restoredRows: string[] = [];
  /** 쓰다 끊긴 행을 알아본다 — {@link UpdateJournal}. */
  private readonly journal: UpdateJournal;
  /** merge 전략이 받은 행에 로컬 편집을 합친 행 — {@link takeMergedRows}. */
  private mergedRows: string[] = [];
  /** Notion 에서 바뀐 속성을 행 노트에 옮긴 것 — pull 마감이 가져가 화면에 알린다(ADR-045). */
  private schemaFollowed: SchemaFollowed[] = [];
  /** pull 이 마지막으로 쓴 사이드카 — 볼트에서 고친 것은 덮어쓰지 않는다(ADR-045). */
  private readonly sidecarBases: SidecarBases;
  /** 이번 pull 이 고쳐 둔 것이라 덮어쓰지 않은 사이드카 경로. */
  private heldSidecars = new Set<string>();
  /** 이번 pull 이 볼트에서 고친 것이라 덮어쓰지 않은 `.base` 경로(ADR-046). */
  private heldBases = new Set<string>();
  /** 이번 pull 이 치운 링크드 뷰의 `.base`({@link takeRetiredBases}). */
  private readonly retiredBases = new Set<string>();
  /** 이번 실행에서 받은 DB(줄인 id)의 기간 날짜 짝 키 — 그 DB 를 원본으로 둔 링크드 뷰의 `.base` 도 같게 쓴다. */
  private readonly rangeEnds = new Map<string, ReadonlyMap<string, string>>();

  /**
   * 실제로 기록한 .base 경로/DB 제목 — placeholder 임베드 재작성(F22)의 SSOT. 이번 pull 이 조회하지
   * 않은 DB 의 것도 남아 있다({@link DbBaseFiles}).
   */
  readonly baseFileInfo: DbBaseFiles;
  /** DB 마다 지난 pull 이 본 속성 — Notion 에서 바꾼 속성 이름을 행 노트에 옮기는 근거(ADR-045). */
  private readonly schemaLedger: SchemaLedger;

  private get decorations(): PageDecorations {
    return (this.decorationsCache ??= new PageDecorations(this.notionClient, this.imageHandler));
  }

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
    /**
     * 받은 행 본문(Notion 원문)을 알린다 — 감지가 행의 하위 페이지를 빠뜨렸을 때 그 본문의 자식 태그로
     * 채운다({@link RemoteDetector.noteBodyChildren}).
     */
    private readonly noteRowBody: (pageId: string, rawMarkdown: string) => void = () => {},
  ) {
    this.baseFileInfo = new DbBaseFiles(stateDb);
    this.journal = new UpdateJournal(stateDb);
    this.sidecarBases = new SidecarBases(stateDb);
    this.schemaLedger = new SchemaLedger(stateDb);
    this.relocator = new NoteRelocator(stateDb, vaultFs, config.notion.databases ?? []);
    this.propertyMapper = PropertyMapper.fromConfig(config);
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

  async pullAll(opts?: {
    readonly paths?: readonly string[];
    readonly progress?: RowProgress;
    /** 조회할 DB 와 DB 마다의 결과(ADR-027). 없으면 모든 DB 를 조회한다. */
    readonly ledger?: DatabasePullLedger;
    /** 취소하면 다음 DB 를 조회하지 않는다 — 닿지 못한 DB 는 다음 pull 이 조회한다. */
    readonly signal?: AbortLike;
    /** {@link pullDatabase} 의 같은 이름 옵션. */
    readonly rescanRowChildren?: boolean;
  }): Promise<DatabaseSyncResult> {
    const databases = this.config.notion.databases;
    if (!databases || databases.length === 0) return emptyDatabaseSyncResult();

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let restored = 0;
    const conflicts: Conflict[] = [];
    const failed: FailedOperation[] = [];
    const writtenPaths: string[] = [];
    const ledger = opts?.ledger;

    for (const dbConfig of databases) {
      if (ledger && !ledger.selects(dbConfig.databaseId)) {
        ledger.skip();
        continue;
      }
      if (opts?.signal?.aborted) {
        ledger?.retry(dbConfig.databaseId);
        continue;
      }
      try {
        const result = await this.pullDatabase(dbConfig, {
          paths: opts?.paths,
          progress: opts?.progress,
          rescanRowChildren: opts?.rescanRowChildren,
        });
        created += result.created;
        updated += result.updated;
        deleted += result.deleted;
        restored += result.restored;
        conflicts.push(...result.conflicts);
        failed.push(...result.failed);
        writtenPaths.push(...result.writtenPaths);
        // 받지 못한 행이 있으면 다음 pull 이 다시 조회한다 — 그 행의 수정 시각은 다음 조회 창 밖이다.
        if (result.failed.length > 0) ledger?.retry(dbConfig.databaseId);
        else ledger?.settle(dbConfig.databaseId);
      } catch (error) {
        ledger?.retry(dbConfig.databaseId);
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
      /**
       * 이 범위의 행만 받고 지운다(`pull --path` · 변경 패널의 항목별 받기). 없으면 모든 행.
       * 새 행은 DB 폴더 전체가 범위일 때만 만든다 — 받기 전에는 어느 경로에 쓸지 모른다.
       */
      paths?: readonly string[];
      /** 받은 행 · 지운 행을 하나씩 알린다. 예전에는 pull 진행 표시에 행이 하나도 보이지 않았다. */
      progress?: RowProgress;
      /**
       * `--force` — 그대로라 받지 않는 행도 본문을 읽어 하위 페이지를 알린다({@link noteRowBody}). 감지가 빠뜨린
       * 행의 하위 페이지는 행 본문으로만 보이는데, 이미 받은 행은 바뀌기 전까지 본문을 다시 읽지 않는다.
       * 행 파일은 쓰지 않는다.
       */
      rescanRowChildren?: boolean;
      /**
       * 발견한 DB 다 — Notion 에서 다른 페이지 아래로 옮겼으면 볼트에서도 폴더를 옮기고 알린다({@link placementMoveOf}).
       * 설정 파일에 적은 DB 의 폴더는 사용자가 정했다 — 주지 않는다.
       */
      onFolderMoved?: (move: RemoteMove) => void;
    },
  ): Promise<DatabaseSyncResult> {
    const scope = opts?.paths;
    const target = await this.queryRows(dbConfig, opts);
    if (target.kind === "out-of-scope") return emptyDatabaseSyncResult();
    if (target.kind === "rows" && opts?.onFolderMoved && !scope) {
      const move = await this.followPlacement(dbConfig, target.meta);
      if (move) {
        dbConfig = { ...dbConfig, localFolder: move.to };
        opts.onFolderMoved(move);
      }
    }
    // 링크드 뷰의 `.base` 는 부른 쪽이 원본 DB 폴더에 쓴다({@link pullLinkedView}) — 이 컨테이너의 폴더는 행이 없다.
    if (target.kind === "linked") {
      return { ...emptyDatabaseSyncResult(), linkedOriginalDbId: target.ownerDbId };
    }
    const { pages, wholeDbInScope, meta } = target;

    const schema = await this.notionClient.getDatabaseSchema(dbConfig.databaseId, meta);
    this.propertyMapper.loadSchema(schema);

    await this.vaultFs.ensureFolder(dbConfig.localFolder);

    // Notion 에서 바꾼 속성을 행 노트에 먼저 옮긴다 — DB 전체를 받을 때만(ADR-045).
    const followed = wholeDbInScope
      ? await this.followSchema(dbConfig, meta, pages)
      : { changes: new Map<string, SchemaChange>(), rekeyed: new Set<string>() };
    const refreshedKeys = (page: PageObjectResponse) =>
      followed.changes.get(sourceKeyOf(page, dbConfig.databaseId))?.refreshed;

    // 보기(`.base`)는 DB 폴더 전체를 받을 때만 다시 만든다 — 행 하나를 받는 데 쓰지 않는다.
    if (wholeDbInScope) {
      const viewsConfig = await this.pullDatabaseViews(dbConfig);
      const rangeEnds = this.rangeEndsOf(pages);
      this.rangeEnds.set(compactNotionId(dbConfig.databaseId), rangeEnds);
      await this.generateBaseFile(dbConfig, viewsConfig, meta, undefined, rangeEnds);
    }

    let created = 0;
    // 키만 바꾼 행 노트도 바뀐 파일이다 — 그 행을 이어서 받으면 한 번만 센다.
    let updated = followed.rekeyed.size;
    let restored = 0;
    const conflicts: Conflict[] = [];
    const failed: FailedOperation[] = [];
    // M3: 실제로 디스크에 기록된 DB 행 경로 — 후처리 링크 해소(resolveNotionLinks)가
    // 정확히 이 파일들만 재방문하도록 슬라이스 추정 대신 실측 수집한다.
    const writtenPaths: string[] = [];

    const rowFailure = (page: PageObjectResponse, error: unknown): FailedOperation => ({
      path: `${dbConfig.localFolder}/${page.id}`,
      operation: "create",
      error: error instanceof Error ? error.message : String(error),
    });

    // 받을 행을 먼저 가른다 — 진행 표시가 이 DB 에서 받을 행 수를 받기 전에 안다.
    const pending: { page: PageObjectResponse; action: Exclude<RowAction, "skip"> }[] = [];
    const unchanged: PageObjectResponse[] = [];
    for (const page of pages) {
      try {
        const record = this.stateDb.getByNotionId(page.id);
        const action = await this.rowAction(
          dbConfig,
          page,
          record,
          wholeDbInScope,
          scope,
          refreshedKeys(page),
        );
        if (action !== "skip") pending.push({ page, action });
        else if (record && (wholeDbInScope || inAnyPathScope(record.obsidianPath, scope))) {
          unchanged.push(page);
        }
      } catch (error) {
        failed.push(rowFailure(page, error));
      }
    }
    opts?.progress?.planned(pending.length);

    // 새 행은 ID 차례로 경로를 고른다 — 같은 이름이면 조회 순서에 따라 경로가 달라졌다(B10).
    const ordered = inClaimOrder(
      pending,
      ({ page }) => this.stateDb.getByNotionId(page.id) === null,
      ({ page }) => page.id,
    );
    for (const { page, action } of ordered) {
      try {
        const record = this.stateDb.getByNotionId(page.id);

        // R9e: 행 1건 처리도 합성 경로다 — 블록 조회·첨부 다운로드·변환·파일 IO 가 얽혀
        // 있어 호출 단위 상한만으로는 덮이지 않는다. R9b 가 오케스트레이터의 페이지 루프
        // 4곳에만 상한을 걸어 DB 행은 그대로 무방비였다(R9a 의 image/file 핸들러 비대칭과
        // 같은 결함군 — 같은 계약이 두 경로에 있으면 한쪽만 빠진다). 볼트의 887개 파일 중
        // 629개가 DB 행이므로 보호 공백이 오히려 다수였다.
        const outcome = await withDeadline(
          () =>
            action === "reform" && record
              ? this.rewriteStaleKeys(page, record, refreshedKeys(page))
              : this.pullDatabasePage(page, dbConfig),
          this.config.advanced.itemTimeoutMs,
          `pull ${dbConfig.localFolder}/${page.id}`,
        );

        if (!record) {
          created++;
          if (outcome.action === "written") writtenPaths.push(outcome.path);
        } else if (outcome.action === "written") {
          // 원격 무변경인데도 되살린 행은 updated 와 가른다.
          if (action === "restore") {
            restored++;
            this.restoredRows.push(outcome.path);
          } else if (!followed.rekeyed.has(record.id)) updated++;
          writtenPaths.push(outcome.path);
        } else if (outcome.action === "merged") {
          // 받은 행에 로컬 편집을 합쳤다 — 받은 것으로 세되 push 에서 빼지 않는다(합친 글을 올려야 한다).
          updated++;
          this.mergedRows.push(outcome.path);
        } else if (outcome.action === "conflict") {
          conflicts.push(outcome.conflict);
        }
        // skipped(local-first) · unchanged(받아 보니 그대로): 카운트하지 않음
        opts?.progress?.done({
          path: outcome.path ?? record?.obsidianPath ?? `${dbConfig.localFolder}/${page.id}`,
          operation: record ? "update" : "create",
        });
      } catch (error) {
        failed.push(rowFailure(page, error));
      }
    }

    if (opts?.rescanRowChildren) await this.noteUnchangedRowBodies(unchanged);

    const removal = await this.pullDeletedRows(dbConfig, pages, opts?.paths, opts?.progress);
    const deleted = removal.deleted;
    conflicts.push(...removal.conflicts);

    getLogger().debug(
      `[DB Sync] ${dbConfig.localFolder}: ${created} 생성, ${updated} 업데이트, ${deleted} 삭제, ${restored} 복원, ${conflicts.length} 충돌`,
    );
    return { created, updated, deleted, restored, conflicts, failed, writtenPaths };
  }

  /**
   * 받지 않는 행의 본문을 읽어 하위 페이지만 알린다(`--force`). 읽지 못한 행은 경고만 남긴다 — 그 행은 받을 것이
   * 없었고, 하위 페이지는 다음 `--force` 가 다시 찾는다.
   */
  private async noteUnchangedRowBodies(pages: readonly PageObjectResponse[]): Promise<void> {
    for (const page of pages) {
      try {
        const { markdown } = await withDeadline(
          () => this.notionClient.getPageMarkdown(page.id),
          this.config.advanced.itemTimeoutMs,
          `row body ${page.id}`,
        );
        this.noteRowBody(page.id, markdown);
      } catch (error) {
        getLogger().warn(
          `[Im-Nobsidian] 행의 하위 페이지를 확인하지 못함 (${page.id}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * 받을 행을 세기만 한다(dry-run) — 볼트 · 상태 DB · Notion 을 바꾸지 않는다. 조회 · 범위 · 받을
   * 행 판정 · 삭제 확인은 {@link pullDatabase} 와 같다.
   *
   * 행 본문은 읽지 않는다. 그래서 같은 분 안의 편집(«확인 안 됨»)은 고침으로 세고, 받아 보고 같으면
   * 쓰지 않을 행 · local-first 로 지킬 행 · 충돌로 남길 행도 고침으로 센다. 새 행의 경로는 pull 과 같은
   * 차례(ID 순)로 고른다 — 이번에 만들 행끼리 이름이 겹치면 뒤 차례에 id 가 붙는다.
   */
  async planDatabase(
    dbConfig: DatabaseSyncConfig,
    opts?: {
      resolveDbFolder?: (databaseId: string) => string | null;
      paths?: readonly string[];
      /** 발견한 DB 다 — Notion 에서 옮긴 DB 의 폴더 이동도 보인다({@link pullDatabase}). */
      followPlacement?: boolean;
      /**
       * 볼트에서 옮긴 레코드 — dry-run 은 옮겨 적지 않아 이동 WAL 이 없다. 실제 pull 처럼 볼트가 먼저다.
       */
      movingInVault?: ReadonlySet<string>;
    },
  ): Promise<PlannedRow[]> {
    const target = await this.queryRows(dbConfig, opts);
    if (target.kind !== "rows") return [];

    const folderMove =
      opts?.followPlacement && !opts.paths
        ? await this.unblocked(this.placementMoveOf(dbConfig, target.meta, opts.movingInVault))
        : null;
    const planned = await this.planRows(dbConfig, target, opts?.paths, opts?.movingInVault);
    if (!folderMove) return planned;
    // 실제 pull 은 폴더를 먼저 옮기고 행을 받는다 — 행도 새 자리로 보인다.
    const moved = (path: string) =>
      within(path, folderMove.from) ? folderMove.to + path.slice(folderMove.from.length) : path;
    return [
      {
        pageId: dbConfig.databaseId,
        path: folderMove.to,
        operation: "move",
        moves: [folderMove],
      },
      ...planned.map((row) => ({ ...row, path: moved(row.path) })),
    ];
  }

  /**
   * 받은 행이 지난 사본 그대로인가 — 렌더한 글이 달라도 받을 것이 없으면 그 사이 로컬 편집을 충돌로 올리지 않는다
   * (N-05). 본문은 지문으로, 본문 밖은 지난 사본의 속성과 견준다. 이 도구가 이 행을 쓰다 끊긴 원격도 받을 것이
   * 없다 — push 가 마저 올린다({@link UpdateJournal}).
   */
  private rowRemoteUnchanged(
    record: SyncRecord,
    page: PageObjectResponse,
    bodyFingerprint: string | null,
    localContent: string,
  ): boolean {
    const base = snapshotFrontmatter(record.baseSnapshot);
    return (
      (base !== null &&
        bodyFingerprint === record.notionBodyFingerprint &&
        this.rowOutsideBodyUnchanged(this.propertyMapper, page, base, record.obsidianPath)) ||
      this.journal.wroteRemote(
        record,
        page,
        computeHash(localContent),
        this.observation().botUserId,
      )
    );
  }

  /**
   * dry-run 이 알릴, 로컬도 고친 행을 실제 pull 이 어떻게 처리할지 — 받은 행과 견주는 판정은 실제 pull 과 같다.
   * 첨부를 내려받지 않고 렌더하며 상태 DB 를 바꾸지 않는다. 로컬을 고치지 않았거나 읽지 못하면 null(받는다).
   */
  private async previewRowResolution(
    record: SyncRecord,
    page: PageObjectResponse,
  ): Promise<PlannedResolution | null> {
    let localContent: string;
    try {
      localContent = await this.vaultFs.readFile(record.obsidianPath);
    } catch {
      return null;
    }
    if (computeHash(localContent) === record.contentHash) return null;
    const rendered = await this.renderRow(page, record.obsidianPath, { downloadMedia: false });
    const resolution = resolvePullConflict({
      record,
      localContent,
      remoteContent: rendered.content,
      remoteUnchanged: this.rowRemoteUnchanged(
        record,
        page,
        rendered.bodyFingerprint,
        localContent,
      ),
      remoteChange: {
        pageId: page.id,
        type: "modified",
        lastEdited: page.last_edited_time,
        previousEdited: record.notionLastEdited,
      },
      strategy: this.config.sync.conflictStrategy,
    });
    if (resolution.action === "conflict")
      return { action: "conflict", conflict: resolution.conflict! };
    return resolution.action === "write" ? null : { action: resolution.action };
  }

  /**
   * 수정 시각 · 편집자로 가르지 못한 행이 지난 사본 그대로인가 — 본문 지문과 본문 밖 속성으로({@link rowRemoteUnchanged}).
   * dry-run 이 실제 pull 처럼 받을 것이 없는 행을 세지 않게. 견줄 사본 · 지문이 없거나 본문을 읽지 못하면 아니다.
   */
  private async unverifiedRowUnchanged(
    record: SyncRecord,
    page: PageObjectResponse,
  ): Promise<boolean> {
    if (this.remoteVerdict(record, page) !== "unverified") return false;
    const base = snapshotFrontmatter(record.baseSnapshot);
    if (base === null || record.notionBodyFingerprint === null) return false;
    try {
      const fingerprint = remoteBodyFingerprint(
        (await this.notionClient.getPageMarkdown(page.id)).markdown,
      );
      return (
        fingerprint === record.notionBodyFingerprint &&
        this.rowOutsideBodyUnchanged(this.propertyMapper, page, base, record.obsidianPath)
      );
    } catch {
      return false;
    }
  }

  private async planRows(
    dbConfig: DatabaseSyncConfig,
    target: { readonly pages: PageObjectResponse[]; readonly wholeDbInScope: boolean },
    paths: readonly string[] | undefined,
    movingInVault: ReadonlySet<string> = new Set(),
  ): Promise<PlannedRow[]> {
    const opts = { paths };
    const planned: PlannedRow[] = [];
    // 이번에 만들 행이 고른 경로 — 경로 → 페이지. 뒤 차례 행은 이 경로를 피한다.
    const claimed = new Map<string, string>();
    const pages = inClaimOrder(
      target.pages,
      (page) => this.stateDb.getByNotionId(page.id) === null,
      (page) => page.id,
    );
    for (const page of pages) {
      const record = this.stateDb.getByNotionId(page.id);
      const action = await this.rowAction(
        dbConfig,
        page,
        record,
        target.wholeDbInScope,
        opts?.paths,
      );
      if (action === "skip") continue;
      if (!record) {
        const name = sanitizeFileName(this.notionClient.extractTitle(page));
        const ownerOf = await this.rowPathOwners(dbConfig.localFolder, name, page.id);
        const path = resolveDbRowPath(dbConfig.localFolder, name, page.id, (p) => {
          const owner = claimed.get(p);
          return owner !== undefined ? { notionPageId: owner } : ownerOf(p);
        });
        claimed.set(path, page.id);
        planned.push({ pageId: page.id, path, operation: "create" });
      } else if (wasPage(record) || arrivesFromOtherDatabase(record, dbConfig)) {
        // 볼트에서 옮긴 것을 아직 올리지 않았으면 받지 않는다(pullDatabasePage).
        if (this.movedInVault(record, movingInVault)) continue;
        const name = sanitizeFileName(this.notionClient.extractTitle(page));
        const path = resolveDbRowPath(
          dbConfig.localFolder,
          name,
          page.id,
          await this.rowPathOwners(dbConfig.localFolder, name, page.id),
        );
        const children = this.adoptedChildrenOf(record, path);
        planned.push({
          pageId: page.id,
          path,
          operation: "update",
          moves: [{ from: record.obsidianPath, to: path }, ...(children ? [children] : [])],
        });
      } else {
        // 수정 시각 · 편집자로 가르지 못한 행 — 실제 pull 은 받아 견주고 그대로면 세지 않는다.
        if (action === "pull" && (await this.unverifiedRowUnchanged(record, page))) continue;
        // Notion 에서 바꾼 제목으로 이름을 바꿀 행 — 실제 pull 과 같은 판정으로 새 이름을 보인다.
        const retitle = await this.retitledRowTarget(dbConfig.localFolder, record, page);
        const renamed = retitle && "to" in retitle ? retitle : null;
        // 로컬도 고친 행 — 실제 pull 이 충돌로 남기거나 · 합치거나 · 받지 않는다. 사라진 행은 되살린다.
        const resolution =
          action === "restore" ? null : await this.previewRowResolution(record, page);
        planned.push({
          pageId: page.id,
          path: renamed?.to ?? record.obsidianPath,
          operation: "update",
          restore: action === "restore",
          ...(resolution ? { resolution } : {}),
          // 실제 pull 이 알리는 것과 같게 행만 — 하위 페이지 폴더는 함께 옮기지만 따로 알리지 않는다.
          ...(renamed
            ? { moves: [{ from: record.obsidianPath, to: renamed.to, renamed: true }] }
            : {}),
        });
      }
    }

    if (this.config.sync.deleteSync && !dbConfig.pullFilter) {
      for (const record of this.unlistedRows(dbConfig, target.pages, opts?.paths)) {
        try {
          const presence = await remotePresence(this.notionClient, record.notionPageId!);
          if (presence.kind === "alive") continue;
          const decision = await decideRemoteDeletion(this.vaultFs, record, {
            deleteFile: this.config.sync.deleteSync,
            strategy: this.config.sync.conflictStrategy,
          });
          if (decision.action === "deleted") {
            planned.push({
              pageId: record.notionPageId!,
              path: record.obsidianPath,
              operation: "delete",
            });
          }
        } catch {
          // 확인하지 못한 행은 실제 pull 도 이번에는 지우지 않는다.
        }
      }
    }
    return planned;
  }

  /**
   * 이 DB 에서 볼 행을 조회한다. 범위(`paths`)가 이 DB 폴더에 닿지 않으면 조회하지 않는다 — 예전에는
   * 범위와 상관없이 모든 행을 만들고 고쳤다.
   *
   * F25: 행 parent 로 data source 의 원본 database 를 검증한다(추가 API 0회). 신 모델에선
   * linked view 컨테이너도 data_sources 가 채워져 retrieve 만으론 원본과 구분되지 않아
   * 캐시에 오등록될 수 있는데, 그대로 두면 같은 행 집합을 여러 config 가 각자 자기 폴더로
   * 릴레이 재배치해 원격 무변경에도 매 pull 재작성이 쌓인다(실측 66건/pull, 행당 최대 4중).
   * 컨테이너로 판정되면 행은 원본에 양보하고 .base 만 원본 폴더 필터로 재지향해
   * "같은 데이터의 다른 뷰"라는 Notion 의미를 보존한다.
   *
   * DB 는 한 번만 받는다(`meta`) — 행 조회 · 스키마 · `.base` 제목이 이것을 같이 읽는다. 예전에는 같은 DB 를
   * 세 번 넘게 다시 받아 DB 하나에 요청 6~8회가 들었다(ADR-027).
   */
  private async queryRows(
    dbConfig: DatabaseSyncConfig,
    opts?: {
      resolveDbFolder?: (databaseId: string) => string | null;
      paths?: readonly string[];
    },
  ): Promise<
    | { readonly kind: "out-of-scope" }
    | {
        readonly kind: "linked";
        readonly ownerDbId: string;
        readonly ownerFolder: string;
        readonly wholeDbInScope: boolean;
        readonly meta: DatabaseMeta;
      }
    | {
        readonly kind: "rows";
        readonly pages: PageObjectResponse[];
        readonly wholeDbInScope: boolean;
        readonly meta: DatabaseMeta;
      }
  > {
    const scope = opts?.paths;
    // 이 DB 폴더 전체가 범위인가 · 범위가 이 폴더 안의 행만 가리키는가. 둘 다 아니면 범위 밖이다.
    const wholeDbInScope = inAnyPathScope(dbConfig.localFolder, scope);
    if (!wholeDbInScope && !scope!.some((path) => matchesPathScope(path, dbConfig.localFolder))) {
      return { kind: "out-of-scope" };
    }
    // 설정이 뺀 DB 폴더(이슈 #8)는 조회하지도 쓰지도 않는다.
    if (this.vaultFs.excludesPath?.(dbConfig.localFolder, "folder"))
      return { kind: "out-of-scope" };

    const meta = await this.notionClient.getDatabaseMeta(dbConfig.databaseId);
    const pages = await this.notionClient.queryAllDatabasePages(
      dbConfig.databaseId,
      dbConfig.pullFilter,
      meta,
    );

    const parent = pages[0]?.parent as { type?: string; database_id?: string } | undefined;
    const ownerDbId = parent?.database_id;
    if (ownerDbId && !notionIdsEqual(ownerDbId, dbConfig.databaseId)) {
      const ownerFolder = opts?.resolveDbFolder?.(ownerDbId) ?? null;
      if (ownerFolder !== null) {
        return { kind: "linked", ownerDbId, ownerFolder, wholeDbInScope, meta };
      }
    }
    return { kind: "rows", pages, wholeDbInScope, meta };
  }

  /**
   * 조회한 행 하나에 할 일 — 건너뜀 · 되살림 · 받음. 범위가 행 몇 개면 그 행만 받고 새 행은
   * 만들지 않는다(어느 경로에 쓸지 받기 전에는 모른다).
   *
   * 리모트가 지난번에 본 그대로면 건너뜀. 수정 시각이 같아도 같은 분 안의 편집일 수 있으면
   * («확인 안 됨», N-05) 받아서 견준다 — 같으면 파일을 쓰지 않는다. 단 두 가지 예외가 있다.
   *  · 레코드 경로가 현재 DB 폴더 직속이 아니면(F24 동명 DB 폴더 분리 후 옛 공유 폴더 잔류)
   *    원격 무변경이어도 재처리해 현 폴더로 재배치한다.
   *  · 로컬 파일이 사라졌으면 되살린다(R13). 이 확인이 없으면 pullDatabasePage 안의 복원
   *    판정(localExists → resolvePullConflict)에 영영 도달하지 못해 지운 행이 조용히 영구
   *    소실된다. 페이지 경로는 R0 으로 이미 마감한 계약인데 행 경로만 빠져 있었다 —
   *    오케스트레이터의 detectMissingLocalFiles 가 "행은 여기서 이미 같은 판정을 거친다"는
   *    (틀린) 전제로 db-row 를 제외해 두었기에 양쪽 어디에도 복원 경로가 없는 상태였다.
   *    deleteSync 가 켜져 있으면 되살리지 않는다 — 지운 것은 Notion 에서도 지우라는 뜻이고, sync 는
   *    pull 을 먼저 돌려 되살리면 뒤이은 push 가 지울 것을 잃는다(detectMissingLocalFiles 와 같다).
   *  · 예전 버전이 적은 날짜 모양이 남은 행, Notion 이 새로 만들거나 타입을 바꾼 속성의 값이 다른 행은 그 줄만
   *    고쳐 쓴다({@link staleKeysToRewrite}, F-08 · ADR-045).
   *
   * @param refreshed 이 행의 data source 에서 새로 생기거나 타입이 바뀐 속성의 키(ADR-045).
   */
  private async rowAction(
    dbConfig: DatabaseSyncConfig,
    page: PageObjectResponse,
    record: SyncRecord | null,
    wholeDbInScope: boolean,
    scope: readonly string[] | undefined,
    refreshed?: ReadonlySet<string>,
  ): Promise<RowAction> {
    if (!wholeDbInScope && !(record && inAnyPathScope(record.obsidianPath, scope))) return "skip";
    if (record && this.vaultFs.excludesPath?.(record.obsidianPath)) return "skip";
    if (!record) return "pull";
    const misplaced = !isDirectDbRowPath(dbConfig.localFolder, record.obsidianPath);
    const changed = misplaced || this.remoteVerdict(record, page) !== "unchanged";
    if (!changed && (await this.staleKeysToRewrite(record, page, refreshed))) return "reform";
    // 원격도 바뀐 행이라도 볼트에서 사라진 것이면 되살린 것이다 — 받는 일은 같고 세는 칸만 다르다.
    // 예전에는 «업데이트» 로 세어, 지운 파일이 돌아온다는 것을 결과가 말하지 않았다.
    if (this.config.sync.deleteSync || (await this.vaultFs.exists(record.obsidianPath))) {
      // deleteSync 로 볼트에서 지운 행은 원격이 바뀌었을 때만 받는다(되살린다). 수정 시각 · 편집자로 가르지 못했으면
      // 내용으로 — 받아 견줄 로컬이 없어, 받으면 그대로인 원격으로 지운 파일을 되살린다.
      if (
        changed &&
        !misplaced &&
        this.config.sync.deleteSync &&
        !(await this.vaultFs.exists(record.obsidianPath)) &&
        (await this.unverifiedRowUnchanged(record, page))
      ) {
        return "skip";
      }
      return changed ? "pull" : "skip";
    }
    return "restore";
  }

  /**
   * 원격이 그대로인 행이지만 그 줄만 고쳐 쓸 키가 있는가 — 예전 버전이 적은 날짜 모양(`…Z` · `…+09:00` ·
   * `{start, end}`, F-08, {@link PropertyMapper.outdatedDateKeys}), 또는 Notion 이 새로 만들거나 타입을 바꾼
   * 속성의 값이 적힌 것과 다른 키(ADR-045 — 수식 열을 더하면 행마다 값이 생기지만 행의 수정 시각은 그대로다).
   * 고쳐 쓰면 사본도 새 값이 되어 다음 pull 은 건너뛴다.
   *
   * 지난 동기화 뒤 로컬을 고친 행은 고르지 않는다 — 로컬 편집을 지키느라 쓰지 않으니 pull 마다 고르기만
   * 한다. 그 편집을 올린 뒤의 pull 이 고른다. 로컬 파일을 읽지 못하면 고르지 않는다.
   */
  private async staleKeysToRewrite(
    record: SyncRecord,
    page: PageObjectResponse,
    refreshed: ReadonlySet<string> | undefined,
  ): Promise<boolean> {
    const base = snapshotFrontmatter(record.baseSnapshot);
    if (base === null || this.staleKeys(base, rowProperties(page), refreshed).length === 0) {
      return false;
    }
    try {
      return computeHash(await this.vaultFs.readFile(record.obsidianPath)) === record.contentHash;
    } catch {
      return false;
    }
  }

  /** 적힌 frontmatter 에서 받은 값으로 고쳐 쓸 키 — {@link staleKeysToRewrite}. */
  private staleKeys(
    written: Readonly<Record<string, unknown>>,
    raw: Record<string, unknown>,
    refreshed: ReadonlySet<string> | undefined,
  ): string[] {
    const keys = new Set(this.propertyMapper.outdatedDateKeys(written, raw));
    if (refreshed && refreshed.size > 0) {
      const fresh = this.propertyMapper.fromNotionProperties(raw);
      for (const key of refreshed) {
        // 파일 속성은 받은 값이 서명 URL 이다 — 첨부로 내려받는 것은 행을 받을 때다.
        if ((raw[key] as { type?: string } | undefined)?.type === "files") continue;
        if (!sameFrontmatterValue(written[key] ?? null, fresh[key] ?? null)) keys.add(key);
      }
    }
    return [...keys];
  }

  /**
   * 원격이 그대로인 행에서 {@link staleKeys} 의 키만 받은 값으로 고쳐 쓴다 — 본문 · 첨부는 다시 받지 않는다. 본문은
   * 한 글자도 바꾸지 않고, 다른 키의 줄은 그대로 둔다(키 단위로 나눠 읽을 수 없는 frontmatter 는 값만 지킨다 —
   * {@link mergeRowFrontmatter}).
   *
   * 예전에는 행을 통째로 다시 받았다. 행마다 본문을 읽어 요청이 늘고, 다시 그릴 때마다 달라지는 본문(빈
   * 블록 · 첨부 이름)까지 바뀌었다 — 실볼트 사본에서 다시 받은 149행 중 99행.
   *
   * 고른 뒤 로컬을 고쳤으면 쓰지 않는다(`skipped`) — 이어지는 push 가 올린다.
   */
  private async rewriteStaleKeys(
    page: PageObjectResponse,
    record: SyncRecord,
    refreshed: ReadonlySet<string> | undefined,
  ): Promise<PullOutcome> {
    const path = record.obsidianPath;
    const local = await this.vaultFs.readFile(path);
    if (computeHash(local) !== record.contentHash) return { action: "skipped", path };

    const raw = rowProperties(page);
    const keys = this.staleKeys(splitFrontmatter(local).data, raw, refreshed);
    // 고를 때 견준 값 그대로 적는다 — 다음 pull 이 같은 값으로 견줘 다시 고르지 않는다. 빈 값은 행을 받을 때처럼
    // 적지 않는다 — 받은 속성에 없는 키는 합치기가 지운다(지운 옵션의 행이 `상태: null` 이 되지 않게).
    const fresh = this.propertyMapper.fromNotionProperties(raw);
    const pulled = Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(fresh, key) && !isEmptyFrontmatterValue(fresh[key]))
        .map((key) => [key, fresh[key]]),
    );
    const lines = keys.length > 0 ? mergeRowFrontmatter(local, pulled, new Set(keys)) : null;
    const content = lines === null ? null : replaceFrontmatterLines(local, lines);
    if (content === null) return { action: "unchanged", path };

    await this.vaultFs.writeFile(path, content);
    // 원격을 본 기록은 그대로 둔다 — 원격을 다시 읽지 않았다.
    const stat = await this.vaultFs.getFileStat(path);
    this.stateDb.transaction(() => {
      this.stateDb.updateHash(record.id, computeHash(content), Buffer.from(content, "utf-8"));
      if (stat) this.stateDb.updateStatCache(record.id, stat.mtime, stat.size);
    });
    return { action: "written", path };
  }

  /**
   * Notion 에서 바뀐 속성을 지난 pull 이 본 스키마와 id 로 견줘 행 노트에 옮긴다(ADR-045) — 이름을 바꾼 속성은 키
   * 이름을, 지운 속성은 키를. 새로 생기거나 타입이 바뀐 속성은 돌려준다 — 그대로인 행도 그 값을 고쳐 쓴다.
   *
   * 처음 보는 DB 는 견줄 것이 없어 적기만 한다. 행 하나라도 옮기지 못하면 본 스키마를 적지 않는다 — 다음 pull 이 다시
   * 옮긴다(이미 옮긴 행은 바꿀 것이 없다).
   *
   * @returns 바뀐 속성(data source → 바뀐 것, 바뀐 소스만)과 키를 바꾼 행의 레코드 id.
   */
  private async followSchema(
    dbConfig: DatabaseSyncConfig,
    meta: DatabaseMeta,
    pages: readonly PageObjectResponse[],
  ): Promise<{ changes: Map<string, SchemaChange>; rekeyed: ReadonlySet<string> }> {
    const changes = new Map<string, SchemaChange>();
    const seen = seenSchemaOf(meta);
    if (seen === null) return { changes, rekeyed: new Set() };
    const before = this.schemaLedger.get(dbConfig.databaseId);
    for (const [source, after] of Object.entries(seen)) {
      const prev = before?.[source];
      if (!prev) continue;
      const change = diffSourceSchema(prev, after);
      if (!isEmptySchemaChange(change)) changes.set(source, change);
    }
    let rekeyed: ReadonlySet<string> = new Set();
    if (changes.size > 0) {
      const sources = Object.keys(seen);
      const soleSource = meta.dataSources.length <= 1 && sources.length === 1 ? sources[0]! : null;
      const outcome = await rekeyTrackedRows(
        this.stateDb,
        this.vaultFs,
        dbConfig.databaseId,
        pages,
        changes,
        soleSource,
      );
      rekeyed = new Set(outcome.rewritten);
      this.noteSchemaFollowed(dbConfig, changes, outcome);
      if (outcome.failed > 0) {
        getLogger().warn(
          `[DB Sync] ${dbConfig.localFolder}: 바뀐 속성을 행 노트 ${outcome.failed}개에 옮기지 못함 — 다음 pull 이 다시 합니다`,
        );
        return { changes, rekeyed };
      }
    }
    this.schemaLedger.set(dbConfig.databaseId, seen);
    return { changes, rekeyed };
  }

  /** 옮긴 것을 pull 마감이 알리게 적는다 — 이름 바꿈 · 지움이 있었던 DB 만. 날짜 범위 끝 키는 따로 세지 않는다. */
  private noteSchemaFollowed(
    dbConfig: DatabaseSyncConfig,
    changes: ReadonlyMap<string, SchemaChange>,
    outcome: Awaited<ReturnType<typeof rekeyTrackedRows>>,
  ): void {
    const derived = (key: string, keys: ReadonlySet<string> | ReadonlyMap<string, string>) =>
      key.endsWith(RANGE_END_SUFFIX) && keys.has(key.slice(0, -RANGE_END_SUFFIX.length));
    const renamed = [...changes.values()].flatMap((c) =>
      [...c.renamed].filter(([from]) => !derived(from, c.renamed)),
    );
    const removed = [...changes.values()].flatMap((c) =>
      [...c.removed].filter((key) => !derived(key, c.removed)),
    );
    if (renamed.length === 0 && removed.length === 0) return;
    this.schemaFollowed.push({
      folder: dbConfig.localFolder,
      renamed,
      removed,
      rows: outcome.rewritten.length,
      kept: outcome.kept,
    });
  }

  /** 이번 pull 이 행 노트에 옮긴 Notion 속성 변경 — 가져가면 비운다(ADR-045). */
  /** 고쳐 둔 것이라 덮어쓰지 않은 사이드카 — 가져가면 비운다. */
  takeHeldSidecars(): string[] {
    const held = [...this.heldSidecars];
    this.heldSidecars = new Set();
    return held;
  }

  /** 고쳐 둔 것이라 덮어쓰지 않은 `.base` — 가져가면 비운다. */
  takeHeldBases(): string[] {
    const held = [...this.heldBases];
    this.heldBases = new Set();
    return held;
  }

  takeSchemaFollowed(): SchemaFollowed[] {
    const followed = this.schemaFollowed;
    this.schemaFollowed = [];
    return followed;
  }

  /** 이 DB 의 추적 행 가운데 이번 조회에 없던 것 — 지워졌는지는 아직 모른다. */
  private unlistedRows(
    dbConfig: DatabaseSyncConfig,
    pages: readonly PageObjectResponse[],
    paths: readonly string[] | undefined,
  ): SyncRecord[] {
    const listed = new Set(pages.map((page) => normalizeNotionId(page.id)));
    return this.stateDb
      .getAll()
      .filter(
        (record) =>
          record.fileType === "db-row" &&
          record.notionPageId !== null &&
          record.notionParentId !== null &&
          notionIdsEqual(record.notionParentId, dbConfig.databaseId) &&
          !listed.has(normalizeNotionId(record.notionPageId)) &&
          inAnyPathScope(record.obsidianPath, paths) &&
          !(this.vaultFs.excludesPath?.(record.obsidianPath) ?? false),
      );
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
    progress: RowProgress | undefined,
  ): Promise<{ deleted: number; conflicts: Conflict[] }> {
    const conflicts: Conflict[] = [];
    if (!this.config.sync.deleteSync || dbConfig.pullFilter) return { deleted: 0, conflicts };

    let deleted = 0;
    for (const record of this.unlistedRows(dbConfig, pages, paths)) {
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
        progress?.planned(1);
        progress?.done({ path: record.obsidianPath, operation: "delete" });
      } catch (error) {
        getLogger().warn(
          `[DB Sync] 조회에 없는 행 ${record.obsidianPath} — 원격을 확인하지 못해 이번에는 지우지 않음:`,
          error,
        );
      }
    }
    return { deleted, conflicts };
  }

  /**
   * DB 의 보기를 Notion 에서 다시 읽어 `db-views.json` 에 적는다. DB 를 통째로 받을 때(행이 바뀐 DB · 전체 대조)
   * 마다 부른다 — 보기만 고친 것은 DB 의 수정 시각을 바꾸지 않아(2026-10-23 실측) 다음 전체 대조가 받는다.
   * 예전에는 처음 받은 보기를 끝까지 썼다 — Notion 에서 더하거나 고친 보기가 `.base` 에 오지 않았다.
   * 읽지 못하면 받아 둔 보기를 쓴다 — 보기가 빠진 `.base` 를 쓰지 않는다.
   */
  private async pullDatabaseViews(
    dbConfig: DatabaseSyncConfig,
  ): Promise<DatabaseViewsConfig | null> {
    const configPath = DB_VIEWS_PATH;
    // 파일이 없을 때만 빈 객체에서 시작한다. 있는데 읽지 못하면(깨진 JSON 등) 이 DB 의 설정만 담아 쓰면
    // 다른 DB 들의 보기 설정이 모두 지워진다 — 이번에는 쓰지 않고 받은 설정만 돌려준다.
    let allViewsConfigs: Record<string, DatabaseViewsConfig> | null = {};
    try {
      if (await this.vaultFs.exists(configPath)) {
        allViewsConfigs = JSON.parse(await this.vaultFs.readFile(configPath)) as Record<
          string,
          DatabaseViewsConfig
        >;
      }
    } catch (error) {
      getLogger().warn(
        `[DB Sync] ${configPath} 를 읽지 못해 이 DB 의 보기 설정을 저장하지 않음(파일은 그대로 둠):`,
        error,
      );
      allViewsConfigs = null;
    }
    const cached = allViewsConfigs?.[dbConfig.databaseId] ?? null;

    let viewsConfig: DatabaseViewsConfig;
    try {
      viewsConfig = await this.notionClient.getDatabaseViewsConfig(dbConfig.databaseId);
    } catch (error) {
      getLogger().warn(
        `[DB Sync] 뷰 설정을 받지 못함 — ${cached ? "받아 둔 보기로 씀" : "보기 없이 씀"}:`,
        error,
      );
      return cached;
    }
    if (!allViewsConfigs) return viewsConfig;

    try {
      await this.vaultFs.ensureFolder(INTERNAL_DIR);
      allViewsConfigs[dbConfig.databaseId] = viewsConfig;
      await this.vaultFs.writeFile(configPath, JSON.stringify(allViewsConfigs, null, 2));
      getLogger().debug(
        `[DB Sync] 뷰 설정 ${viewsConfig.views.length}개 저장: ${dbConfig.databaseId}`,
      );
    } catch (error) {
      getLogger().warn(`[DB Sync] 뷰 설정을 저장하지 못함 (계속 진행):`, error);
    }
    return viewsConfig;
  }

  /** 행들 가운데 한 번이라도 기간인 날짜 속성 → 그 짝 키. */
  private rangeEndsOf(pages: readonly PageObjectResponse[]): Map<string, string> {
    const ends = new Map<string, string>();
    for (const page of pages) {
      for (const [name, endKey] of this.propertyMapper.rangeEndKeysOf(rowProperties(page))) {
        ends.set(name, endKey);
      }
    }
    return ends;
  }

  private async generateBaseFile(
    dbConfig: DatabaseSyncConfig,
    viewsConfig: DatabaseViewsConfig | null,
    /** {@link queryRows} 가 받은 이 DB — 스키마 · 제목을 다시 받지 않는다. */
    meta: DatabaseMeta,
    /**
     * F25: 행이 실제로 사는 폴더(.base 의 폴더 필터 대상). linked view 컨테이너의
     * .base 는 자기 폴더가 아니라 원본 DB 폴더를 가리켜야 행 이관 후에도 빈 뷰가 되지
     * 않는다. 생략하면 자기 폴더(원본 DB 의 기본 동작).
     */
    rowsFolder?: string,
    /** 받은 행 가운데 기간이 있는 날짜 속성의 짝 키 — `BaseFileOptions.rangeEnds`. */
    rangeEnds?: ReadonlyMap<string, string>,
    /** 링크드 뷰 컨테이너의 `.base` — 행을 가진 원본 DB 와 파일 이름({@link pullLinkedView}). */
    linked?: { readonly ownerId: string; readonly name: string },
  ): Promise<void> {
    try {
      const schemaFull = await this.notionClient.getDatabaseSchemaFull(dbConfig.databaseId, meta);
      const dbName =
        linked?.name ||
        viewsConfig?.databaseName ||
        (await this.notionClient.getDatabaseTitle(dbConfig.databaseId, meta)) ||
        dbConfig.localFolder.split("/").pop() ||
        "Database";

      const resolvedViews: DatabaseViewsConfig = viewsConfig ?? {
        databaseId: dbConfig.databaseId,
        databaseName: dbName,
        lastSynced: new Date().toISOString(),
        views: [{ id: "default", name: "Table", type: "table" }],
      };

      const generated = this.baseFileGenerator.generateWithViews({
        databaseId: dbConfig.databaseId,
        databaseName: dbName,
        schema: schemaFull,
        viewsConfig: resolvedViews,
        folderPath: rowsFolder ?? dbConfig.localFolder,
        rangeEnds,
      });
      const baseContent = generated.content;

      const safeName = sanitizeFileName(dbName);
      const basePath = `${dbConfig.localFolder}/${safeName}${BASE_SUFFIX}`;
      const previous = this.baseFileInfo.get(dbConfig.databaseId);
      const existing = await this.vaultFs.readFile(basePath).catch(() => null);
      let record: DbBaseFile = {
        basePath,
        title: dbName,
        hash: computeHash(baseContent),
        // Notion 보기를 받지 못해 기본 표 하나를 쓴 파일은 올릴 보기가 없다.
        ...(viewsConfig ? recordBaseViews(baseContent, generated.views, viewsConfig.views) : null),
        ...(linked ? { linkedTo: compactNotionId(linked.ownerId) } : null),
      };
      // Obsidian 은 보기를 고치면 `.base` 를 다시 쓰며 머리 주석을 지운다(1.13.7 실측) — 보기를 기록해 둔 경로면
      // 머리가 없어도 pull 이 쓴 파일이다.
      const ours =
        existing === null ||
        isGeneratedDbArtifact(basePath, existing) ||
        (previous?.basePath === basePath && previous.views !== undefined);
      if (!ours) {
        // 직접 만든 `.base` 의 보기는 Notion 보기에서 온 것이 아니다 — 보기를 기록하지 않아 push 도 올리지 않는다.
        record = { basePath, title: dbName, hash: record.hash, linkedTo: record.linkedTo };
        if (!this.keptUserBases.has(basePath)) {
          this.keptUserBases.add(basePath);
          // 알림이 아니다 — 볼트에서 만든 폴더를 DB 로 올리면(#75) 사용자의 `.base` 가 늘 이 자리에 있다.
          getLogger().info(
            `[DB Sync] 직접 만든 .base 라 Notion 보기로 덮어쓰지 않음: ${basePath} — Notion 보기를 받으려면 이 파일의 이름을 바꾸세요`,
          );
        }
      } else if (
        existing !== null &&
        existing !== baseContent &&
        editedSince(previous, basePath, existing)
      ) {
        // pull 이 쓴 뒤 볼트에서 고친 보기 — 덮어쓰면 고친 것이 사라진다. 기록은 그대로 둔다(계속 «고친 것»).
        // push 가 이 기록과 견줘 고친 보기를 Notion 에 올린다.
        record = { ...previous!, title: dbName };
        this.warnEditedBase(basePath);
      } else if (existing !== baseContent) {
        await this.vaultFs.writeFile(basePath, baseContent);
      }
      this.baseFileInfo.set(dbConfig.databaseId, record);
      getLogger().debug(`[DB Sync] .base 파일 생성: ${basePath}`);

      if (linked) {
        // 사이드카는 원본 DB 의 것이 있다. 이름이 바뀌었으면(원본 제목 · 첫 보기 이름) 옛 `.base` 를 치운다 — 원본의
        // 산출물 정리는 이 파일을 지키므로 여기서 지운다.
        if (previous && previous.basePath !== basePath) {
          await this.removeLinkedBase(previous);
          if (
            !(await this.vaultFs.exists(previous.basePath)) &&
            (await this.vaultFs.exists(basePath))
          ) {
            this.renamedRows.applied.push({ from: previous.basePath, to: basePath });
          }
        }
        return;
      }

      await this.generateSidecar(
        dbConfig,
        dbName,
        safeName,
        schemaFull,
        resolvedViews,
        meta.isInline,
        await this.appearanceOf(meta, safeName),
      );
      await this.cleanupStaleDbArtifacts(
        dbConfig.databaseId,
        dbConfig.localFolder,
        safeName,
        previous,
      );
      // DB 제목이 바뀌어 `.base` 이름이 바뀌었다 — 옛 `.base` 를 지웠으면 그것을 넣은 노트의 임베드 · 링크를 고친다.
      if (
        previous &&
        previous.basePath !== basePath &&
        !(await this.vaultFs.exists(previous.basePath)) &&
        (await this.vaultFs.exists(basePath))
      ) {
        this.renamedRows.applied.push({ from: previous.basePath, to: basePath });
      }
    } catch (error) {
      getLogger().warn(`[DB Sync] .base 파일 생성 실패 (계속 진행):`, error);
    }
  }

  /**
   * DB 의 아이콘 · 커버 · 설명 · 제목 표시 — push 가 DB 를 다시 만들 때 쓴다(ADR-036). 아이콘 · 커버는 페이지와
   * 같은 꼴로 적고 올린 파일은 볼트로 내려받는다 — 서명 주소를 적으면 pull 마다 사이드카가 바뀐다.
   */
  private appearanceOf(meta: DatabaseMeta, safeName: string): Promise<SidecarAppearance> {
    let found = this.appearances.get(meta);
    if (!found) {
      found = this.readAppearance(meta, safeName);
      this.appearances.set(meta, found);
    }
    return found;
  }

  private async readAppearance(meta: DatabaseMeta, safeName: string): Promise<SidecarAppearance> {
    const a = meta.appearance;
    if (!a) return {};
    const decorated = await this.decorations.pulled(
      { icon: a.icon, cover: a.cover } as unknown as PageObjectResponse,
      `${safeName}-db`,
      true,
    );
    const description = richTextToNfm(a.description as Parameters<typeof richTextToNfm>[0]);
    return {
      ...decorated,
      ...(description ? { description } : {}),
      ...(a.showTitle ? {} : { showTitle: false as const }),
    };
  }

  /**
   * 링크드 뷰 컨테이너의 `.base` 를 그 컨테이너의 보기(이름 · 필터 · 정렬)로 원본 DB 폴더에 쓴다. 행은 원본 DB 가
   * 갖는다(F25) — 폴더 필터도 원본 폴더를 가리킨다. 예전에는 링크드 뷰를 원본의 `.base` 로 몰아, 링크드 뷰가 고른
   * 보기가 볼트에 오지 않았다.
   *
   * 이름은 Notion 이 그 블록 위에 보이는 것처럼 「원본 제목 - 첫 보기 이름」 이다. 컨테이너 제목은 비어 온다.
   *
   * @returns `gone` — Notion 에서 컨테이너를 지웠다. 쓴 `.base` 를 치웠으니 부른 쪽이 연결을 잊는다.
   *   `failed` — 읽지 못했다. 쓴 `.base` 는 그대로 두고 다음 pull 이 다시 본다.
   */
  async pullLinkedView(
    containerId: string,
    owner: DatabaseSyncConfig,
  ): Promise<"written" | "gone" | "failed"> {
    let meta: DatabaseMeta;
    try {
      meta = await this.notionClient.getDatabaseMeta(containerId);
    } catch (error) {
      if (isNotionObjectNotFound(error)) {
        await this.retireLinkedView(containerId);
        return "gone";
      }
      getLogger().warn(
        `[DB Sync] 링크드 뷰 ${containerId} 를 읽지 못함 (다음 pull 이 다시 봄):`,
        error,
      );
      return "failed";
    }
    if (meta.inTrash) {
      await this.retireLinkedView(containerId);
      return "gone";
    }
    const container = { ...owner, databaseId: containerId };
    const views = await this.pullDatabaseViews(container);
    // 보기를 받지 못했으면 쓰지 않는다 — 기본 표를 쓰면 원본 DB 의 `.base` 와 같은 것이 하나 더 생긴다.
    if (!views || views.views.length === 0) return "failed";
    await this.generateBaseFile(
      container,
      views,
      meta,
      owner.localFolder,
      this.rangeEnds.get(compactNotionId(owner.databaseId)),
      { ownerId: owner.databaseId, name: this.linkedBaseName(containerId, owner, views) },
    );
    return "written";
  }

  /** 링크드 뷰 `.base` 의 이름 — 같은 폴더의 다른 `.base` 가 쓰는 이름이면 컨테이너 id 앞 네 자리를 붙인다. */
  private linkedBaseName(
    containerId: string,
    owner: DatabaseSyncConfig,
    views: DatabaseViewsConfig,
  ): string {
    const ownerTitle =
      this.baseFileInfo.get(owner.databaseId)?.title ||
      owner.localFolder.split("/").pop() ||
      "Database";
    const name = `${ownerTitle} - ${views.views[0]?.name || "View"}`;
    const self = compactNotionId(containerId);
    const taken = new Set(
      this.baseFileInfo
        .all()
        .filter(([id]) => id !== self)
        .map(([, file]) => file.basePath),
    );
    return taken.has(`${owner.localFolder}/${sanitizeFileName(name)}${BASE_SUFFIX}`)
      ? `${name} (${self.slice(0, 4)})`
      : name;
  }

  /** Notion 에서 지운 링크드 뷰 — 쓴 `.base` 를 치우고 기록을 잊는다. */
  private async retireLinkedView(containerId: string): Promise<void> {
    const record = this.baseFileInfo.get(containerId);
    if (!record) return;
    if (await this.removeLinkedBase(record)) this.retiredBases.add(record.basePath);
    this.baseFileInfo.delete(containerId);
    getLogger().info(`[DB Sync] Notion 에서 지운 링크드 뷰의 .base 를 치움: ${record.basePath}`);
  }

  /**
   * pull 이 쓴 그대로인 링크드 뷰 `.base` 를 지운다 — 볼트에서 고쳤으면 두고 알린다.
   * @returns 지웠나.
   */
  private async removeLinkedBase(record: DbBaseFile): Promise<boolean> {
    const content = await this.vaultFs.readFile(record.basePath).catch(() => null);
    if (content === null || !isGeneratedDbArtifact(record.basePath, content)) return false;
    if (editedSince(record, record.basePath, content)) {
      this.warnEditedBase(record.basePath);
      return false;
    }
    await this.vaultFs.deleteFile(record.basePath);
    return true;
  }

  /** 볼트에서 고친 `.base` 를 덮어쓰거나 지우지 않았다고 한 번 알린다. */
  private warnEditedBase(path: string): void {
    this.heldBases.add(path);
    if (this.keptUserBases.has(path)) return;
    this.keptUserBases.add(path);
    getLogger().warn(
      `[DB Sync] 볼트에서 고친 .base 라 Notion 보기로 덮어쓰지 않음: ${path} — push 하면 고친 보기 이름 · 열 · 정렬 · 필터와 더하고 지운 보기를 Notion 에 올립니다. Notion 의 보기를 다시 받으려면 이 파일을 지우세요`,
    );
  }

  /**
   * DB 제목이 바뀌면 `.base`/`.notion.json` 파일명(safeName)이 바뀌어 옛 이름의 산출물이
   * 같은 폴더에 고아로 잔존한다(drift·부활 원인). DB 폴더 **직속**의 산출물 중 현재 이름이
   * 아닌 것을 삭제해 멱등을 보장한다. 하위 폴더(중첩 DB)의 산출물은 보호한다.
   */
  private async cleanupStaleDbArtifacts(
    databaseId: string,
    localFolder: string,
    safeName: string,
    /** 이 DB 의 `.base` 를 지난번에 쓴 기록 — 제목이 바뀌어 옛 이름이 된 것을 볼트에서 고쳤으면 지우지 않는다. */
    previous?: DbBaseFile,
  ): Promise<void> {
    try {
      const keep = new Set([
        `${localFolder}/${safeName}${BASE_SUFFIX}`,
        `${localFolder}/${safeName}${SIDECAR_SUFFIX}`,
        // 이 DB 를 원본으로 둔 링크드 뷰의 `.base` — 같은 폴더에 놓인다.
        ...this.baseFileInfo.linkedBasesOf(databaseId),
      ]);
      const files = await this.vaultFs.listNonMarkdownFiles();
      const stale = selectStaleDbArtifacts(files, localFolder, keep);
      for (const path of stale) {
        const content = await this.vaultFs.readFile(path).catch(() => null);
        if (content === null || !isGeneratedDbArtifact(path, content)) continue;
        if (this.heldSidecars.has(path)) continue;
        if (editedSince(previous, path, content)) {
          this.warnEditedBase(path);
          continue;
        }
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
    schemaFull: Record<string, BasePropertySchema>,
    resolvedViews: DatabaseViewsConfig,
    isInline: boolean,
    appearance: SidecarAppearance,
  ): Promise<void> {
    try {
      const sidecar = this.sidecarGenerator.build({
        databaseId: dbConfig.databaseId,
        databaseName: dbName,
        schema: schemaFull,
        viewsConfig: resolvedViews,
        isInline,
        appearance,
      });
      const sidecarPath = `${dbConfig.localFolder}/${safeName}${SIDECAR_SUFFIX}`;
      const serialized = this.sidecarGenerator.serialize(sidecar);
      // 같은 DB 가 한 번의 pull 에서 임베드 재작성 때마다 재생성된다(실측 최대 67회).
      // 결정적 직렬화라 동일 바이트면 쓰기·degrade 로그 모두 생략 — 로그 노이즈와
      // 불필요한 IO 를 없애고, 내용이 실제로 바뀔 때만 알린다.
      const existing = await this.vaultFs.readFile(sidecarPath).catch(() => null);
      if (
        existing !== null &&
        existing !== serialized &&
        !isGeneratedDbArtifact(sidecarPath, existing)
      ) {
        return;
      }
      // pull 이 쓴 뒤 볼트에서 고친 사이드카 — push 가 고친 속성을 Notion 에 올린다. 덮어쓰거나(제목이 바뀌어 옛
      // 이름이 된 것은) 지우면 고친 것이 사라진다. 올린 뒤의 pull 이 새로 쓴다.
      const previous = this.sidecarBases.get(dbConfig.databaseId);
      if (previous) {
        const written =
          previous.path === sidecarPath
            ? existing
            : await this.vaultFs.readFile(previous.path).catch(() => null);
        if (
          written !== null &&
          written !== serialized &&
          computeHash(written) !== previous.hash &&
          isGeneratedDbArtifact(previous.path, written) &&
          sidecarPropertiesEdited(written, previous)
        ) {
          this.heldSidecars.add(previous.path);
          return;
        }
      }
      this.sidecarBases.set(dbConfig.databaseId, {
        path: sidecarPath,
        hash: computeHash(serialized),
        properties: sidecar.properties,
      });
      if (existing === serialized) return;
      await this.vaultFs.writeFile(sidecarPath, serialized);

      if (sidecar.degraded.length > 0) {
        const unrep = sidecar.degraded.filter((d) => d.kind === "view-unrepresentable").length;
        const dropped = sidecar.degraded.length - unrep;
        getLogger().info(
          `[DB Sync] '${dbName}' degrade ${sidecar.degraded.length}건` +
            ` (미표현 뷰 ${unrep} · 미표현 설정 ${dropped}) → ${safeName}${SIDECAR_SUFFIX} 보존`,
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
    /** 원격 본문에 페이지 시절의 속성 블록이 있었나 — 받으며 걷어 냈다. */
    propertiesBlock: boolean;
  }> {
    const downloadMedia = options?.downloadMedia !== false;
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const rawProperties = (page as unknown as { properties: Record<string, unknown> }).properties;
    const properties = this.propertyMapper.fromNotionProperties(rawProperties);
    properties.title = title;

    if (downloadMedia) {
      await this.localizeFileProperties(rawProperties, properties, safeName);
    }

    // 아이콘 · 커버 — Notion 에 올린 파일은 files 속성과 같이 첨부로 내려받는다(P3-A). 서명 URL(약 1시간
    // 만료)을 적으면 깨진 링크가 되고 받을 때마다 주소가 바뀌어 churn 이 된다(실측: LIFE/WORK).
    Object.assign(properties, await this.decorations.pulled(page, safeName, downloadMedia));

    const mdResult = await this.notionClient.getPageMarkdown(page.id);
    this.noteRowBody(page.id, mdResult.markdown);
    const bodyFingerprint = remoteBodyFingerprint(mdResult.markdown);
    // 압축형 판정은 원시 export 기준(D1) — enhanced 변환 후에는 판정 불가
    const exportCompact = isCompactExport(mdResult.markdown);
    let markdown = await notionBodyToObsidian(this.notionClient, mdResult.markdown, page.id);
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
        const fileResult = await this.imageHandler.downloadAllFiles(markdown, title, page.id);
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
        // 이 렌더러가 적는 키 — 속성과 제목 · 커버 · 아이콘. 나머지는 로컬 키다(F-08).
        notionKeys: [...this.propertyMapper.ownedKeys(rawProperties), "title", ...DECORATION_KEYS],
      },
    );
    return {
      content,
      title,
      properties,
      bodyFingerprint,
      propertiesBlock: hasPropertiesBlock(mdResult.markdown),
    };
  }

  /**
   * 행의 본문 밖이 지난 동기화 사본 그대로인가(N-05) — 제목과 보낼 수 있는 속성, 아이콘 · 커버.
   * push 는 원격을 덮어써도 되는지, pull 은 받을
   * 것이 있는지를 이 규칙으로 가른다. 읽기 전용 속성(수식 · 롤업 · 수정 시각)은 보지 않는다 —
   * 로컬에서 고칠 수 없고 push 가 보내지 않는다.
   *
   * @param mapper 그 행의 DB 스키마를 읽은 매퍼.
   * @param base 지난 동기화 시점의 frontmatter.
   * @param path 지난 동기화 시점의 경로 — 파일 이름을 따르던 제목을 가른다.
   */
  rowOutsideBodyUnchanged(
    mapper: PropertyMapper,
    page: PageObjectResponse,
    base: Readonly<Record<string, unknown>>,
    path: string,
  ): boolean {
    const raw = (page as unknown as { properties?: Record<string, unknown> }).properties ?? {};
    const { changed, cleared } = diffRowProperties(
      mapper.writableValues(mapper.fromNotionProperties(raw)),
      mapper.writableValues(base),
    );
    return (
      this.notionClient.extractTitle(page) === noteTitle(base, path) &&
      Object.keys(changed).length === 0 &&
      cleared.length === 0 &&
      decorationsUnchanged(this.notionClient, page, base)
    );
  }

  /** 레코드가 지난번에 본 원격 행과 지금 행을 견준다 — 이번 동기화의 기준으로(N-05). */
  private remoteVerdict(record: SyncRecord, page: PageObjectResponse): RemoteVerdict {
    return compareRemote(record, page, this.observation().botUserId);
  }

  /**
   * 행 경로 후보의 주인 — 상태 DB 의 레코드, 없으면 볼트에 이미 있는 파일(주인 모름). 추적하지 않는 로컬 파일
   * (아직 push 하지 않은 노트)을 새 행이 덮어쓰면 그 글이 사라졌다. 일반 페이지 받기(`claimFilePath`)처럼 피한다.
   */
  private async rowPathOwners(
    localFolder: string,
    safeName: string,
    pageId: string,
  ): Promise<(path: string) => PathOwner | null> {
    const untracked = new Set<string>();
    for (const candidate of pagePathCandidates(localFolder, safeName, pageId)) {
      if (this.stateDb.getByPath(candidate) === null && (await this.vaultFs.exists(candidate))) {
        untracked.add(candidate);
      }
    }
    return (path) =>
      this.stateDb.getByPath(path) ?? (untracked.has(path) ? { notionPageId: null } : null);
  }

  /** 되살린 행의 경로를 가져가고 비운다. */
  takeRestoredRows(): string[] {
    const rows = this.restoredRows;
    this.restoredRows = [];
    return rows;
  }

  /** 이번 받기에서 로컬 편집을 합친 행의 경로를 가져가고 비운다. */
  takeMergedRows(): string[] {
    const rows = this.mergedRows;
    this.mergedRows = [];
    return rows;
  }

  /**
   * Notion 에서 다른 페이지 아래로 옮긴 DB 의 폴더를 볼트에서도 옮긴다 — 옮겼으면 그 이동. 옮기지 못하면 까닭을 남기고
   * 옛 자리에서 받는다.
   */
  private async followPlacement(
    dbConfig: DatabaseSyncConfig,
    meta: DatabaseMeta,
  ): Promise<RemoteMove | null> {
    const outcome = this.placementMoveOf(dbConfig, meta);
    if (!outcome) return null;
    const move = await this.unblocked(outcome);
    if (!move) return null;
    await this.relocator.relocate([move]);
    this.renamedRows.renamed.push(move);
    this.renamedRows.applied.push(move);
    getLogger().info(
      `[Im-Nobsidian] Notion 에서 ${move.renamed ? "이름을 바꾼" : "옮긴"} DB 의 폴더를 볼트에서 옮김: ${move.from} → ${move.to}`,
    );
    return move;
  }

  /** 옮길 수 있으면 그 이동, 막혔으면 까닭을 알리고 null. */
  private async unblocked(outcome: RemoteMove | RemoteMoveSkip | null): Promise<RemoteMove | null> {
    if (!outcome) return null;
    if ("reason" in outcome) {
      getLogger().warn(
        `[Im-Nobsidian] Notion 에서 옮기거나 이름을 바꾼 DB 의 폴더를 볼트에서 옮기지 않음 (${outcome.path}): ${outcome.reason}`,
      );
      return null;
    }
    const blocked = await this.relocator.blocked(outcome);
    return blocked ? this.unblocked({ path: outcome.from, reason: blocked }) : outcome;
  }

  /** 볼트에서 옮기고 아직 올리지 않았나 — 이동 WAL, 또는 dry-run 이 옮겨 적지 않은 이번 이동. */
  private movedInVault(record: SyncRecord, movingInVault: ReadonlySet<string>): boolean {
    return (
      movingInVault.has(record.id) ||
      this.stateDb.getIncompleteOpByState(record.id, "move") !== null
    );
  }

  /**
   * Notion 에서 다른 페이지 아래로 옮기거나 이름을 바꾼 발견 DB 의 폴더를 옮길 곳(ADR-047 · {@link retitledFolderName})
   * — 제자리면 null.
   *
   * Notion 에서 DB 를 옮겨도 DB · 행의 수정 시각이 그대로라 받은 DB 의 부모로만 안다 — 전체 대조는 모든 DB 를 받으니
   * 거기서 보인다. 새 자리는 처음 발견할 때와 같다 — 부모 페이지의 하위 폴더 이름 그대로, 루트면 `databases` 선반.
   * 맨 위 폴더도 루트 아래로 본다(볼트에서 옮긴 DB 를 push 가 루트 아래에 둔다 — {@link DatabaseMover}).
   * 다음은 옮기지 않는다.
   *   - 부모가 블록(토글 · 열) 안 · 볼트가 모르는 페이지 — 볼트에 그 자리가 없다(이름만 따른다)
   *   - 볼트에서 옮긴 DB 폴더 · 부모 노트를 아직 올리지 않았다 — 볼트가 먼저다(push 가 Notion 을 옮긴다)
   */
  private placementMoveOf(
    dbConfig: DatabaseSyncConfig,
    meta: DatabaseMeta,
    movingInVault: ReadonlySet<string> = new Set(),
  ): RemoteMove | RemoteMoveSkip | null {
    const id = dbConfig.databaseId;
    if ((this.config.notion.databases ?? []).some((db) => notionIdsEqual(db.databaseId, id))) {
      return null;
    }
    if (loadDatabaseMoves(this.stateDb).some((move) => notionIdsEqual(move.databaseId, id))) {
      return null;
    }
    const folder = dbConfig.localFolder;
    const current = parentFolderOf(folder);
    let place = current;
    const parentId = meta.parentPageId;
    if (parentId) {
      let places: string[] | null = null;
      if (notionIdsEqual(parentId, this.config.notion.rootPageId)) {
        places = [ROOT_DATABASES_FOLDER, ""];
      } else {
        const parent = this.stateDb.getByNotionId(parentId);
        if (parent && this.movedInVault(parent, movingInVault)) {
          return {
            path: folder,
            reason: "볼트에서 옮긴 부모 노트를 아직 올리지 않았다 — 다음 push 가 Notion 을 맞춘다",
          };
        }
        if (parent) {
          places = [childFolderOf(parent, { databaseAt: (path) => this.databaseAt(path) })];
          // 처음 발견할 때는 폴더로 추적하는 페이지면 그 폴더 안에 두었다(`DatabaseDiscovery`).
          if (isFolderRecord(parent)) places.push(parent.obsidianPath);
        }
      }
      if (places && !places.includes(current)) place = places[0]!;
    }
    const renamed = this.retitledFolderName(folder, dbConfig.databaseId, meta.title);
    const to =
      renamed === null
        ? joinPath(place, baseName(folder))
        : resolveDbFolderPath(joinPath(place, renamed), id, (path) => this.databaseAt(path));
    if (to === folder) return null;
    return { from: folder, to, ...(renamed !== null ? { renamed: true } : {}) };
  }

  /**
   * Notion 에서 바꾼 DB 제목을 따른 폴더 이름(`sync.renameOnTitleChange`) — 바꿀 것이 없으면 null.
   *
   * 지난번에 받은 제목({@link DbBaseFiles})과 달라졌고, 폴더 이름이 그 옛 제목을 따르고 있을 때만 — 폴더를 만든 규칙
   * (`databaseFolderName`) 이나 `.base` 이름 규칙(`sanitizeFileName`, 볼트에서 바꿔 올린 이름) 그대로일 때다. 사용자가
   * 따로 정한 이름이면 두고, 새 이름도 지금 이름과 같은 규칙으로 짓는다. 같은 이름 DB 와 가르려 붙인 ` (id 조각)` 은
   * 떼고 견준다(F24) — 새 자리에서 다시 가른다.
   */
  private retitledFolderName(folder: string, databaseId: string, title: string): string | null {
    if (!this.config.sync.renameOnTitleChange || !title) return null;
    const previous = this.baseFileInfo.get(databaseId)?.title;
    if (!previous || previous === title) return null;
    const name = baseName(folder).replace(/ \([0-9a-f]{8,32}\)$/, "");
    for (const style of [databaseFolderName, sanitizeFileName]) {
      if (style(previous) !== name) continue;
      const next = style(title);
      return next && next !== name ? next : null;
    }
    return null;
  }

  /** 이 폴더가 받는 DB — 설정한 DB 와 발견한 DB 에서. */
  private databaseAt(folder: string): string | null {
    const all = [
      ...(this.config.notion.databases ?? []),
      ...parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY)),
    ];
    return all.find((db) => db.localFolder === folder)?.databaseId ?? null;
  }

  /** 이름을 바꾼 행을 가져가고 비운다. */
  /** 이번 pull 이 Notion 에서 지운 링크드 뷰라 치운 `.base` — 그것을 넣은 노트의 임베드를 뺀다({@link LinkUpdater.dropEmbeds}). */
  takeRetiredBases(): string[] {
    const paths = [...this.retiredBases];
    this.retiredBases.clear();
    return paths;
  }

  takeRenamedRows(): { renamed: RemoteMove[]; applied: RemoteMove[] } {
    const rows = this.renamedRows;
    this.renamedRows = { renamed: [], applied: [] };
    return rows;
  }

  /**
   * 행이 된 페이지의 하위 페이지 폴더 — 폴더 노트(`X/X.md`)는 든 폴더, 노트는 옆의 `X/`. 행의 하위 페이지는 `행/` 에
   * 든다. 추적하는 노트가 없으면 null.
   */
  private adoptedChildrenOf(record: SyncRecord, rowPath: string): RemoteMove | null {
    const from =
      record.fileType === "folder-note"
        ? parentFolderOf(record.obsidianPath)
        : stripMarkdownExtension(record.obsidianPath);
    const hasChildren = this.stateDb
      .getAll()
      .some((r) => r.id !== record.id && within(r.obsidianPath, from));
    return hasChildren ? { from, to: stripMarkdownExtension(rowPath) } : null;
  }

  /**
   * Notion 에서 바꾼 제목으로 행 이름을 바꿀 자리(`sync.renameOnTitleChange`) — 바꿀 것이 없으면 null.
   * 받기 · pull dry-run · status 가 같은 판정을 쓴다. 행의 하위 페이지 폴더(`행/`)도 새 이름으로 옮기며, 옮길 수
   * 없으면 이름을 바꾸지 않는다(예전처럼 제목만 받는다) — 그 까닭을 돌려준다.
   */
  async retitledRowTarget(
    localFolder: string,
    record: SyncRecord,
    page: PageObjectResponse,
  ): Promise<{ to: string; children: RemoteMove | null } | { reason: string } | null> {
    const recordPath = record.obsidianPath;
    const title = this.notionClient.extractTitle(page);
    if (
      !this.config.sync.renameOnTitleChange ||
      !isDirectDbRowPath(localFolder, recordPath) ||
      !retitledInNotion(snapshotFrontmatter(record.baseSnapshot), null, recordPath, title) ||
      this.stateDb.getIncompleteOpByState(record.id, "move")
    ) {
      return null;
    }
    const safeName = sanitizeFileName(title);
    const to = resolveDbRowPath(
      localFolder,
      safeName,
      page.id,
      await this.rowPathOwners(localFolder, safeName, page.id),
    );
    if (to === recordPath) return null;
    const from = stripMarkdownExtension(recordPath);
    if (!this.stateDb.getAll().some((r) => within(r.obsidianPath, from))) {
      return { to, children: null };
    }
    const children = { from, to: stripMarkdownExtension(to) };
    const blocked = await this.relocator.blocked(children);
    return blocked ? { reason: `하위 페이지 폴더 — ${blocked}` } : { to, children };
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
    // Notion 에서 제목을 바꿨으면(sync.renameOnTitleChange) 새 이름의 자리로 — 옮기는 것은 아래 재배치와 같다.
    const retitle =
      existingRecord && recordPath
        ? await this.retitledRowTarget(dbConfig.localFolder, existingRecord, page)
        : null;
    let filePath: string;
    let childFolderMove: RemoteMove | null = null;
    if (retitle && "to" in retitle) {
      filePath = retitle.to;
      childFolderMove = retitle.children;
    } else if (recordPath && isDirectDbRowPath(dbConfig.localFolder, recordPath)) {
      filePath = recordPath;
    } else {
      filePath = resolveDbRowPath(
        dbConfig.localFolder,
        safeName,
        page.id,
        await this.rowPathOwners(dbConfig.localFolder, safeName, page.id),
      );
    }
    if (retitle && "reason" in retitle) {
      getLogger().warn(
        `[Im-Nobsidian] Notion 에서 바꾼 제목으로 행 이름을 바꾸지 않음 (${recordPath}): ${retitle.reason}`,
      );
    }
    const renaming = retitle !== null && "to" in retitle;
    // Notion 에서 DB 안으로 옮긴 페이지가 행이 된다(ADR-047) — 폴더 노트의 폴더 · 노트 옆 자식 폴더는 행의 하위
    // 페이지 폴더(`행/`)로 함께 옮긴다. 볼트에서 옮긴 것을 아직 올리지 않았으면 볼트가 먼저다(push 가 Notion 을 옮긴다).
    const becomesRow = !!existingRecord && !!recordPath && wasPage(existingRecord);
    // 다른 DB 에서 옮겨 온 행도 같다 — 하위 페이지 폴더와 함께 옮기고 옮긴 것으로 알린다.
    const arrives =
      becomesRow ||
      (!!existingRecord && !!recordPath && arrivesFromOtherDatabase(existingRecord, dbConfig));
    if (arrives && recordPath && this.stateDb.getIncompleteOpByState(existingRecord!.id, "move")) {
      getLogger().warn(
        `[Im-Nobsidian] Notion 에서 DB 로 옮긴 것을 받지 않음 (${recordPath}): 볼트에서 옮긴 것을 아직 올리지 않았다 — 다음 push 가 Notion 을 볼트의 자리로 옮긴다`,
      );
      return { action: "skipped", path: recordPath };
    }
    let adoptedChildren: RemoteMove | null = null;
    let emptiedFolder: string | null = null;
    if (arrives && recordPath && filePath !== recordPath) {
      adoptedChildren = this.adoptedChildrenOf(existingRecord, filePath);
      const blocked = adoptedChildren && (await this.relocator.blocked(adoptedChildren));
      if (blocked) {
        getLogger().warn(
          `[Im-Nobsidian] DB 로 옮긴 행의 하위 페이지 폴더를 옮기지 않음 (${adoptedChildren!.from}): ${blocked}`,
        );
        adoptedChildren = null;
      } else if (!adoptedChildren && existingRecord!.fileType === "folder-note") {
        emptiedFolder = parentFolderOf(recordPath);
      }
    }

    const rendered = await this.renderRow(page, filePath, { localPath: recordPath ?? filePath });
    const { title, properties, bodyFingerprint } = rendered;
    // 행이 된 페이지 — 볼트 frontmatter 의 값을 비어 있는 열이 지우지 않는다(Notion 은 페이지의 속성을 모른다).
    const finalContent = becomesRow
      ? keepPageValues(rendered.content, await readLocalNote(this.vaultFs, recordPath!))
      : rendered.content;
    const seenAt = this.observation().seenAt;

    // merge 전략이 합친 글 — 있으면 받은 행 대신 이것을 쓰고, 지난 사본은 받은 행으로 적는다.
    let merged: string | null = null;
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

      // 받은 행이 지난 사본 그대로인지 내용으로 가른다 — push 와 같은 규칙(N-05). 사라진 행은 되살린다.
      const remoteUnchanged =
        localExists && this.rowRemoteUnchanged(existingRecord, page, bodyFingerprint, localContent);

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
      // merge: 양쪽이 다른 줄을 고쳤다 — 합친 글을 쓴다. 지난 사본 · 해시는 받은 행이라 합친 글의
      // 로컬 편집이 바뀐 행으로 남아 이어지는 push 가 올린다.
      if (resolution.action === "merge") merged = resolution.merged!;
      // resolution.action === "write" → 아래로 진행하여 덮어쓰기
    }

    await this.vaultFs.ensureFolder(dbConfig.localFolder);
    await this.vaultFs.writeFile(filePath, merged ?? finalContent);

    const rehomed = existingRecord && recordPath && recordPath !== filePath;
    // 행이 된 페이지의 frontmatter 는 비어 있는 열에 지워지지 않고 남는다(mergeRowFrontmatter) — Notion 의 행과
    // 다르면 다음 push 가 행의 속성으로 올리게 해시를 비운다. 그대로 두면 양쪽이 말없이 갈린다.
    // 페이지 시절 본문에 실린 속성 블록도 그 push 가 걷어 낸다.
    const outOfStep =
      becomesRow &&
      (rendered.propertiesBlock ||
        !this.rowOutsideBodyUnchanged(
          this.propertyMapper,
          page,
          snapshotFrontmatter(Buffer.from(finalContent, "utf-8")) ?? {},
          filePath,
        ));
    const hash = outOfStep ? "" : computeHash(finalContent);
    // 쓴 파일의 stat 도 적는다 — 없으면 다음 변경 확인이 받은 행을 모두 다시 읽어 해시를 잰다(B5).
    const stat = await this.vaultFs.getFileStat(filePath);
    this.stateDb.transaction(() => {
      if (rehomed) {
        // 재배치: upsert 는 obsidianPath 키라 경로를 먼저 옮겨야 같은 notion_page_id 의
        // 중복 INSERT(UNIQUE 위반)가 안 난다. 옛 경로 위키링크도 함께 제거.
        this.stateDb.updatePath(existingRecord.id, filePath);
        this.stateDb.deleteWikilink(recordPath);
        // 보존 마커는 경로에 매인다 — 옮기지 않으면 다음 받기가 새 경로에서 마커를 찾지 못한다.
        const markers = this.stateDb.getPreserveMarkers(recordPath);
        if (markers.length > 0) {
          this.stateDb.storePreserveMarkers(filePath, markers);
          this.stateDb.storePreserveMarkers(recordPath, []);
        }
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
        // 비운 해시 · 합친 글을 변경 확인이 보게 — stat 이 맞으면 내용을 읽지 않는다(B5).
        localMtime: outOfStep || merged !== null ? null : (stat?.mtime ?? null),
        localFileSize: outOfStep || merged !== null ? null : (stat?.size ?? null),
        // 빈 해시와 함께 — push 가 지난 사본 대신 원격의 지금 값과 견줘 다른 속성을 모두 보낸다(overwritesRemote).
        ...(outOfStep ? { notionBodyFingerprint: null } : {}),
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
      if (adoptedChildren) await this.relocator.relocate([adoptedChildren]);
      if (emptiedFolder) await this.vaultFs.removeEmptyFolder?.(emptiedFolder);
      if (arrives) {
        // 옮긴 것으로 알리고 옛 경로를 가리키던 링크를 고친다.
        const moved = { from: recordPath, to: filePath };
        this.renamedRows.renamed.push(moved, ...(adoptedChildren ? [adoptedChildren] : []));
        this.renamedRows.applied.push(moved, ...(adoptedChildren ? [adoptedChildren] : []));
        getLogger().info(
          becomesRow
            ? `[Im-Nobsidian] Notion 에서 DB 로 옮긴 페이지를 행으로 받음: ${recordPath} → ${filePath}`
            : `[Im-Nobsidian] Notion 에서 다른 DB 로 옮긴 행을 받음: ${recordPath} → ${filePath}`,
        );
      }
      if (renaming) {
        if (childFolderMove) await this.relocator.relocate([childFolderMove]);
        this.renamedRows.renamed.push({ from: recordPath, to: filePath, renamed: true });
        this.renamedRows.applied.push(
          { from: recordPath, to: filePath },
          ...(childFolderMove ? [childFolderMove] : []),
        );
        getLogger().info(
          `[Im-Nobsidian] Notion 에서 바꾼 제목으로 행 이름을 바꿈: ${recordPath} → ${filePath}`,
        );
      }
    }

    return merged !== null
      ? { action: "merged", path: filePath }
      : { action: "written", path: filePath };
  }
}

/** 다른 DB 의 행으로 추적하던 레코드인가 — 이 DB 조회에 나오면 Notion 에서 이 DB 로 옮긴 것이다(ADR-047). */
function arrivesFromOtherDatabase(record: SyncRecord, dbConfig: DatabaseSyncConfig): boolean {
  return (
    record.fileType === "db-row" &&
    !!record.notionParentId &&
    !notionIdsEqual(record.notionParentId, dbConfig.databaseId)
  );
}

/** 페이지로 추적하던 레코드인가 — DB 조회에 나오면 Notion 에서 DB 안으로 옮긴 것이다(ADR-047). */
function wasPage(record: SyncRecord): boolean {
  return (
    record.fileType === "file" ||
    record.fileType === "folder-note" ||
    record.fileType === "folder-only"
  );
}

/**
 * 행이 된 페이지의 노트 — 받은 행의 비어 있는 frontmatter 값을 볼트 노트의 값으로 채운다. 페이지 시절의 값은 볼트에만
 * 있다(push 는 페이지의 frontmatter 를 본문의 속성 블록으로 싣는다). 다음 push 가 그 값을 행의 속성으로 올린다.
 */
function keepPageValues(content: string, local: string | undefined): string {
  if (local === undefined) return content;
  let localData: Record<string, unknown>;
  let rendered: ReturnType<typeof splitFrontmatter>;
  try {
    localData = splitFrontmatter(local).data;
    rendered = splitFrontmatter(content);
  } catch {
    return content;
  }
  if (!rendered.hasFrontmatter) return content;
  const data = { ...rendered.data };
  let filled = false;
  for (const [key, value] of Object.entries(localData)) {
    if (isEmptyFrontmatterValue(value) || !isEmptyFrontmatterValue(data[key])) continue;
    data[key] = value;
    filled = true;
  }
  return filled ? (replaceFrontmatterLines(content, frontmatterLines(data)) ?? content) : content;
}

/** 원격 행의 속성(`page.properties`). */
function rowProperties(page: PageObjectResponse): Record<string, unknown> {
  return (page as unknown as { properties?: Record<string, unknown> }).properties ?? {};
}

/**
 * pull 이 그 경로에 쓴 뒤 볼트에서 고쳤는가 — 지난번에 쓴 내용의 해시와 견준다. 기록이 없거나 다른 경로의 기록이면
 * 가를 수 없어 false 다(예전 버전이 쓴 것).
 */
function editedSince(previous: DbBaseFile | undefined, path: string, content: string): boolean {
  return (
    previous?.basePath === path &&
    previous.hash !== undefined &&
    computeHash(content) !== previous.hash
  );
}
