import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionClient } from "../notion/client.js";
import { DiscoveryTooLargeError } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { LocalChange, RemoteChange, SyncRecord } from "../types/sync.js";
import { throwIfAborted } from "../utils/abort.js";
import { compactNotionId, normalizeNotionId, notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import type { AbortLike } from "../utils/pool.js";
import {
  DISCOVERED_DBS_META_KEY,
  loadInaccessibleDbIds,
  parseDiscoveredDbs,
} from "./discovered-databases.js";
import { extractParentId } from "./notion-parent.js";
import { isDatabaseMode } from "./parent-mode.js";
import { incrementalSearchSince } from "./pull-watermark.js";
import { remoteDeletionChange, remotePresence } from "./remote-deletion.js";
import { remoteStampOf, type RemotePageStamp } from "./remote-observation.js";
import {
  ALL_DATABASES,
  chooseRemoteScan,
  LAST_FULL_PULL_META_KEY,
  PENDING_DATABASES_META_KEY,
  serializePendingDatabases,
  type DatabasePullLedger,
  type DatabaseSelection,
  type RemoteScan,
} from "./remote-scan.js";
import type { RunObservation } from "./run-observation.js";

/**
 * 원격에서 찾은 변경. 증분이면 바뀐 것이 보인 DB 도 함께 — 행을 고쳤거나 · 새 행이 생겼거나 · 스키마를
 * 고친 DB(id 는 {@link compactNotionId}). 전체 대조면 null 이다 — 모든 DB 를 조회한다(ADR-027).
 */
export interface RemoteDetection {
  readonly changes: RemoteChange[];
  readonly databaseIds: ReadonlySet<string> | null;
}

/**
 * 원격에서 바뀐 것을 찾는다 — 전체 대조(루트 아래를 모두 훑고 삭제를 가른다)와 증분(바뀐 것만
 * search 로)을 같은 규칙으로 고른다(ADR-027). pull · status · fetch 가 이 감지를 함께 쓴다.
 *
 * 감지하며 모은 «자식을 가진 페이지» 는 pull 이 폴더노트를 가를 때 읽는다({@link hasChildPages}).
 */
export class RemoteDetector {
  // 서브트리 직접 순회(getChildPagesRecursive) 시간 예산. 초과하면 search 기반 디스커버리로
  // 폴백한다. 분기점 근거: 워크스페이스 search 열거는 latency-bound 로 대략 이 수준(수천 페이지
  // 워크스페이스에서 ~100s)이므로, 순회가 이 시간을 넘기면 search 가 더 저렴해진다. 작은 볼트는
  // 이 예산 안에서 순회가 끝나 폴백 없이 빠르게 완료된다. (단위: ms)
  private static readonly DISCOVERY_RECURSIVE_BUDGET_MS = 90_000;

  // pull 발견 단계에서 모든 페이지의 부모를 해소하며 채우는 "자식을 가진 페이지" 집합
  // (정규화된 page id). 폴더노트/폴더 판정의 단일 신뢰 원천 — 얕은 블록 검사로 callout·
  // column 등 컨테이너에 중첩된 자식 페이지를 놓쳐 폴더노트를 file 로 오분류하던 결함
  // (본문이 최상위로 밀려 ' (1).md' 로 분리)을 차단한다. detectRemoteChanges* 진입 시 재구성.
  private readonly _childParentIds = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly observation: RunObservation,
  ) {}

  /** 이번 감지에서 자식 페이지를 가진 것으로 본 페이지인가 — 폴더노트 판정의 1차 근거. */
  hasChildPages(pageId: string): boolean {
    return this._childParentIds.has(normalizeNotionId(pageId));
  }

  /**
   * 이번 실행이 원격을 얼마나 훑을지(ADR-027) — pull 과 status 가 같은 규칙을 읽는다: 둘이 갈리면
   * status 가 「원격 변경 없음」 이라고 한 것을 pull 이 받는다.
   *
   * 증분의 기준 시각은 `last_pull_at` 뿐이다. push 도 올리는 `last_sync_at` 은 «그 앞의 원격 변경을
   * 받았다» 는 뜻이 아니다 — push 만 한 볼트가 그 시각부터 증분으로 조회하면 그 전에 원격에만 있던
   * 페이지를 영영 받지 못한다.
   */
  remoteScan(options: { readonly force: boolean; readonly deferDue: boolean }): RemoteScan {
    return chooseRemoteScan(
      {
        lastPullAt: this.stateDb.getMeta("last_pull_at"),
        lastFullPullAt: this.stateDb.getMeta(LAST_FULL_PULL_META_KEY),
        trackedRecords: this.stateDb.getAll().length,
        databaseMode: isDatabaseMode(this.config),
        fullReconcileIntervalSec: this.config.sync.fullReconcileInterval,
      },
      { force: options.force, now: Date.now(), deferDue: options.deferDue },
    );
  }

  /**
   * 원격 변경을 찾는다 — 전체 대조면 모두 훑고({@link detectRemoteChanges}), 아니면 바뀐 것만
   * ({@link detectRemoteChangesIncremental}). 취소하면 {@link OperationAbortedError} 를 던진다.
   *
   * @param options.databases 바뀐 DB 도 찾는다(pull · dry-run). 상태 확인은 DB 를 조회하지 않아 찾지 않는다.
   */
  async detectRemote(
    scan: RemoteScan,
    options: { readonly signal?: AbortLike; readonly databases: boolean },
  ): Promise<RemoteDetection> {
    if (scan.kind === "full") {
      return { changes: await this.detectRemoteChanges(options.signal), databaseIds: null };
    }
    return this.detectRemoteChangesIncremental(scan.since, options);
  }

  /**
   * 전체 대조 — 루트 아래 페이지를 모두 훑고 추적 중인데 목록에 없는 페이지를 원격에 물어 삭제를
   * 가른다. 취소하면 {@link OperationAbortedError} 를 던진다 — 다 훑지 못한 목록으로 삭제를 가르지
   * 않는다.
   */
  async detectRemoteChanges(signal?: AbortLike): Promise<RemoteChange[]> {
    const changes: RemoteChange[] = [];
    this._childParentIds.clear();
    const lastPull = this.stateDb.getMeta("last_pull_at");
    const syncedRecords = this.stateDb.getAll();
    const trackedPageIds = new Set(
      syncedRecords.filter((r) => r.notionPageId).map((r) => r.notionPageId!),
    );

    let remotePages: Array<RemotePageStamp & { readonly id: string }>;
    // 새 페이지의 제목 — 볼트 경로가 아직 없어 화면이 이름으로 보인다.
    const titles = new Map<string, string>();
    if (isDatabaseMode(this.config)) {
      // R11-A: 전 data source 를 순회하는 SSOT(queryAllDatabasePages)로 열거한다. 1차 data
      // source 만 페이지네이션하면 2번째+ 소스의 행이 **원격에 없는 것으로 보여**, 미발견에
      // 그치지 않고 deleteSync 시 로컬 파일이 고아로 판정돼 지워진다(pullDatabase 는 이미
      // 전 소스를 훑어 그 행들을 정상 기록하므로, 같은 행을 한 경로는 만들고 다른 경로는
      // 지우는 진동이 된다). 열거 계약을 한 메서드로 모아 경로 간 비대칭을 없앤다.
      const allPages = await this.notionClient.queryAllDatabasePages(
        this.config.notion.databaseId!,
      );
      for (const page of allPages)
        titles.set(normalizeNotionId(page.id), this.notionClient.extractTitle(page));
      remotePages = allPages.map(remoteStampOf);
    } else {
      // 디스커버리 이중 전략(비용 상한 하이브리드):
      //  1) 기본 — root 서브트리 직접 BFS 순회(getChildPagesRecursive). 비용이 실제 동기화
      //     대상(서브트리)에 비례해, 작은 볼트가 수천 페이지 워크스페이스에 있어도 빠르다
      //     (I10: 2-파일 볼트 pull ~12s). 단 비용은 서브트리 **전체 블록 수**에 비례하므로,
      //  2) 콘텐츠가 많은 대규모 서브트리에서는 시간 예산(DISCOVERY_RECURSIVE_BUDGET_MS)을
      //     초과할 수 있다. 그 경우 워크스페이스 search 기반 디스커버리를 **덧붙인다**(비용이
      //     워크스페이스 페이지 수에 비례·예측가능·유한).
      //
      // 두 경로를 경합시키지 않고 **합집합**을 쓰는 이유(R12-A): 둘은 같은 집합을 낸다고
      // 가정할 수 없다. search 는 워크스페이스 색인에 의존해 갓 만든 페이지가 빠질 수 있고,
      // 직접 순회는 마감 때문에 깊은 가지가 빠질 수 있다. 그런데 어느 쪽이 도는지를 90초
      // 벽시계가 정한다 — 실제로 같은 볼트에서 첫 pull 은 폴백(search), 재 pull 은 순회로
      // 돌았고 페이지 수가 회차마다 흔들렸다. 더 나쁜 건 이걸 멱등성 게이트가 못 본다는
      // 점이다: 두 번째 실행이 더 **적게** 찾아도 created/updated 는 0 이라 churn 0 이다.
      // 그리고 deleteSync 가 켜져 있으면 아래 orphan 판정이 그 차집합을 **삭제**한다.
      // 합집합은 이 경합을 없앤다. 순회 부분 결과는 이미 치른 비용이라 추가 요청도 없다.
      let underRoot: PageObjectResponse[];
      try {
        underRoot = await this.notionClient.getChildPagesRecursive(this.config.notion.rootPageId, {
          deadlineMs: Date.now() + RemoteDetector.DISCOVERY_RECURSIVE_BUDGET_MS,
          signal,
        });
      } catch (error) {
        if (!(error instanceof DiscoveryTooLargeError)) throw error;
        getLogger().info(
          `[Im-Nobsidian] 서브트리가 큼(${error.message}) → 순회 부분 결과 ${error.partial.length}건에 ` +
            `워크스페이스 search 기반 디스커버리를 합칩니다`,
        );
        const viaSearch = await this.notionClient.getPagesUnderRootViaSearch(
          this.config.notion.rootPageId,
          signal,
        );
        // id 로 디듀프한다 — 아래 remotePages 차단점도 디듀프하지만, 그 전에 도는
        // _childParentIds 루프의 extractParentId 가 block 부모마다 API 를 부를 수 있어
        // 중복을 여기서 먼저 없애야 요청이 두 배로 새지 않는다.
        const byId = new Map<string, PageObjectResponse>();
        for (const page of [...error.partial, ...viaSearch]) {
          byId.set(normalizeNotionId(page.id), page);
        }
        underRoot = [...byId.values()];
        getLogger().info(
          `[Im-Nobsidian] 디스커버리 합집합: 순회 ${error.partial.length} ∪ search ${viaSearch.length} → ${underRoot.length}건`,
        );
      }
      // 폴더 판정용 _childParentIds: 발견된 각 페이지의 부모(자식을 가진 페이지)를 수집한다.
      // 부모가 page_id 면 추가 API 호출 없이 즉시 해석(공통 경로), block 중첩만 1회 조회.
      this._childParentIds.add(normalizeNotionId(this.config.notion.rootPageId));
      for (const page of underRoot) {
        throwIfAborted(signal);
        const parentId = await extractParentId(this.notionClient, page);
        if (parentId) this._childParentIds.add(normalizeNotionId(parentId));
      }
      for (const page of underRoot)
        titles.set(normalizeNotionId(page.id), this.notionClient.extractTitle(page));
      remotePages = underRoot.map(remoteStampOf);
    }

    // 원격 페이지 목록을 page_id 로 디듀프한다. search API(페이지 모드)·data source 쿼리
    // (DB 모드) 모두 페이지네이션 사이 재정렬로 같은 페이지를 중복 반환할 수 있고, 중복이 changes 로
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
          title: titles.get(key),
          lastEdited: page.last_edited_time,
          previousEdited: null,
        });
      } else {
        const modified = this.observation.modification(record, page);
        if (modified) changes.push(modified);
      }

      trackedPageIds.delete(page.id);
    }

    if (this.config.sync.deleteSync && lastPull) {
      // 조회하는 DB 의 행은 여기서 가르지 않는다 — 페이지 순회는 행을 보지 못해 행은 늘 목록에 없다.
      // 그 DB 를 조회하는 pull 이 조회 결과로 가른다(DatabaseSyncer). 예전에는 행이 매 pull 마다
      // «사라진 페이지» 가 돼 파일이 지워졌다가 이어지는 DB pull 이 다시 만들었다 — 올리지 않은
      // 로컬 편집이 그 사이에 사라졌다(S-12).
      const queriedDatabases = this.rowQueriedDatabaseIds();
      const orphans = syncedRecords.filter(
        (r) =>
          r.notionPageId !== null &&
          trackedPageIds.has(r.notionPageId) &&
          !(
            r.fileType === "db-row" &&
            r.notionParentId !== null &&
            queriedDatabases.has(normalizeNotionId(r.notionParentId))
          ),
      );
      changes.push(...(await this.confirmedDeletions(orphans, seenRemoteIds, signal)));
    }

    return changes;
  }

  /**
   * 이번 pull 이 조회할 DB(ADR-027).
   *
   * - 전체 대조 · 경로를 좁힌 pull → 모두. 경로를 좁혔으면 범위에 닿는 DB 만 조회된다 — 사용자가 고른
   *   것이고, 범위가 비용을 묶는다.
   * - 증분 → 바뀐 것이 보인 DB · 지난번에 받지 못한 DB(대기) · 볼트에서 행이 사라진 DB. 행을 되살리는
   *   것은 DB 조회다 — deleteSync 가 꺼져 있을 때만: 켜져 있으면 지운 것은 원격에도 지우라는 뜻이라
   *   되살리지 않는다({@link detectMissingLocalFiles} 와 같다).
   */
  databaseSelection(
    detection: RemoteDetection,
    localChanges: readonly LocalChange[] | null,
    pending: ReadonlySet<string>,
    paths: readonly string[] | undefined,
  ): DatabaseSelection {
    if (!detection.databaseIds || paths) return ALL_DATABASES;
    const ids = new Set([...detection.databaseIds, ...pending]);
    if (!this.config.sync.deleteSync && localChanges) {
      for (const change of localChanges) {
        if (change.type !== "deleted") continue;
        const record = this.stateDb.getByPath(change.path);
        if (record?.fileType === "db-row" && record.notionParentId) {
          ids.add(compactNotionId(record.notionParentId));
        }
      }
    }
    return { kind: "changed", ids };
  }

  /** 다음 pull 이 바뀐 것이 없어도 조회할 DB 를 적는다 — 바뀐 때만. */
  savePendingDatabases(ledger: DatabasePullLedger): void {
    const serialized = serializePendingDatabases(ledger.nextPending());
    const saved = this.stateDb.getMeta(PENDING_DATABASES_META_KEY);
    if ((saved ?? serializePendingDatabases(new Set())) !== serialized) {
      this.stateDb.setMeta(PENDING_DATABASES_META_KEY, serialized);
    }
  }

  /**
   * 증분 원격 변경 감지 — `since` 이후 수정된 페이지만 search 로 받아 created/modified 만
   * 만든다. **삭제는 감지하지 않는다**: search API 는 in_trash/archived 페이지를 반환하지 않아
   * (=사라진 것을 증분만으로는 구분 불가) 삭제는 전체 대조(`detectRemoteChanges`)가 가른다.
   * 전체 대조는 주기마다 돈다(ADR-027 — 예전에는 deleteSync 가 켜져 있으면 매번 돌았다. I10).
   *
   * 바뀐 행 · 새 행 · 스키마를 고친 DB 도 모은다 — pull 은 그 DB 만 조회한다. 새 행은 페이지로 받지
   * 않는다: DB 조회가 행 속성과 함께 받는다. 그래서 부모를 묻지 않는다(행마다 요청 1회 이상 아낀다).
   *
   * @param options.databases pull · dry-run — 바뀐 DB 를 모으고, 추적 중인 행은 DB 조회에 맡긴다.
   *   false(상태 확인)면 DB 를 찾지 않고 고친 행도 원격 변경으로 싣는다.
   */
  private async detectRemoteChangesIncremental(
    since: string,
    options: { readonly signal?: AbortLike; readonly databases: boolean },
  ): Promise<RemoteDetection> {
    const changes: RemoteChange[] = [];
    const databaseIds = new Set<string>();
    this._childParentIds.clear();
    // 안전창만큼 과거로 되돌려 조회(F20). 넓어진 창에 들어온 무변경 페이지는 아래
    // last_edited 비교가 걸러내므로 재처리 비용 없이 멱등하다.
    const searchSince = incrementalSearchSince(since);
    const recentPages = await this.notionClient.searchRecentPages(searchSince, options.signal);
    const untracked: Array<{
      page: (typeof recentPages)[number];
      parentId: string;
      title: string;
    }> = [];

    for (const page of recentPages) {
      const record = this.stateDb.getByNotionId(page.id);
      if (!record) {
        if (page.parentDatabaseId) {
          databaseIds.add(compactNotionId(page.parentDatabaseId));
          continue;
        }
        throwIfAborted(options.signal);
        try {
          const fullPage = await this.notionClient.getPage(page.id);
          const parentId = await extractParentId(this.notionClient, fullPage);
          if (parentId) {
            this._childParentIds.add(normalizeNotionId(parentId));
            untracked.push({ page, parentId, title: this.notionClient.extractTitle(fullPage) });
          }
        } catch {
          // inaccessible page
        }
        continue;
      }
      // 조회 창(기준 시각 − 안전창 15분)은 가라앉지 않은 레코드의 수정 시각을 늘 담는다 — 가라앉지
      // 않았다는 것은 그 시각이 마지막으로 본 때(기준 시각 뒤)보다 2분 안쪽이라는 뜻이다.
      const modified = this.observation.modification(record, page);
      // 바뀐 행의 DB 만 조회한다 — 창에 다시 든 그대로인 행으로 조회하면 안전창 동안 pull 마다 같은
      // DB 를 다시 조회한다.
      const rowDatabase =
        page.parentDatabaseId ?? (record.fileType === "db-row" ? record.notionParentId : null);
      if (modified && rowDatabase) databaseIds.add(compactNotionId(rowDatabase));
      // pull 은 추적 중인 행도 그 DB 를 조회해 받는다 — 페이지로도 받으면 같은 행을 두 번 받는다(같은
      // 분 안의 편집은 DB 조회가 한 번 더 받아 견준다). 상태 확인은 DB 를 조회하지 않으니 원격 변경으로 둔다.
      if (options.databases && record.fileType === "db-row") continue;
      if (modified) changes.push(modified);
    }

    // 새 페이지는 부모가 루트 · 추적 중이거나, 이번에 함께 받는 새 페이지일 때 받는다(S-08).
    // 예전에는 앞의 둘만 봐서, 새 하위 트리는 맨 위 한 장만 오고 그 아래는 빠졌다 — 다음
    // 실행의 조회 창(마지막 pull − 안전창)은 그 페이지의 수정 시각보다 뒤라 영영 다시 보이지
    // 않았다. 부모가 받아질 때마다 한 바퀴 더 돌아 여러 층을 받고, 부모가 자식보다 먼저 줄에 선다.
    const accepted = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const { page, parentId, title } of untracked) {
        const id = normalizeNotionId(page.id);
        if (accepted.has(id)) continue;
        if (!this.isTrackedParent(parentId) && !accepted.has(normalizeNotionId(parentId))) continue;
        accepted.add(id);
        grew = true;
        changes.push({
          pageId: page.id,
          type: "created",
          title,
          lastEdited: page.last_edited_time,
          previousEdited: null,
        });
      }
    }

    // 스키마를 고친 DB — 행이 그대로여도 `.base` 와 행의 속성을 다시 받아야 한다. 행을 고쳐도 DB 의
    // 수정 시각은 그대로고, 스키마를 고치면 data source 의 수정 시각이 바뀐다(실측 2026-09-28).
    if (options.databases) {
      for (const source of await this.notionClient.searchRecentDataSources(
        searchSince,
        options.signal,
      )) {
        if (source.databaseId) databaseIds.add(compactNotionId(source.databaseId));
      }
    }

    return { changes, databaseIds };
  }

  /**
   * 행의 삭제를 DB 조회로 가르는 DB — 이번 pull 이 조회하는 DB 다. 설정된 DB 와, 페이지 모드면 자동
   * 발견된 DB(접근 불가로 뺀 것 제외). {@link DatabaseDiscovery.pullDiscoveredDatabases} 가 조회하는 목록과 같다.
   */
  private rowQueriedDatabaseIds(): Set<string> {
    const ids = (this.config.notion.databases ?? []).map((d) => d.databaseId);
    if (!isDatabaseMode(this.config)) {
      const inaccessible = loadInaccessibleDbIds(this.stateDb);
      for (const c of parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY))) {
        if (!inaccessible.has(c.databaseId.replace(/-/g, ""))) ids.push(c.databaseId);
      }
    }
    return new Set(ids.map(normalizeNotionId));
  }

  /**
   * 목록에 없던 추적 페이지 가운데 원격에서 정말 사라진 것만 삭제로 낸다(S-12) — {@link remotePresence}.
   *
   * - 휴지통 · 보관 · 없음(404) → 삭제.
   * - 살아 있고 부모가 동기화 범위(루트 · 목록에 있던 페이지 · 이렇게 살아 있다고 확인된 페이지) →
   *   목록이 빠뜨린 것이다. 둔다.
   * - 살아 있지만 범위 밖(다른 곳 · 워크스페이스 맨 위)으로 옮겨졌다 → 삭제(예전과 같다).
   * - 묻지 못했거나 부모를 알 수 없다 → 이번에는 둔다. 다음 전체 대조가 다시 묻는다.
   *
   * 부모가 목록에서 빠진 페이지면 그 부모가 살아 있다고 확인돼야 범위 안이다 — 범위가 더 늘지
   * 않을 때까지 되풀이한다.
   */
  private async confirmedDeletions(
    orphans: readonly SyncRecord[],
    listed: ReadonlySet<string>,
    signal?: AbortLike,
  ): Promise<RemoteChange[]> {
    const scope = new Set<string>([normalizeNotionId(this.config.notion.rootPageId), ...listed]);
    if (isDatabaseMode(this.config)) scope.add(normalizeNotionId(this.config.notion.databaseId!));

    const deleted: SyncRecord[] = [];
    const alive = new Map<SyncRecord, string>();
    for (const record of orphans) {
      throwIfAborted(signal);
      const pageId = record.notionPageId!;
      try {
        const presence = await remotePresence(this.notionClient, pageId);
        if (presence.kind === "gone") {
          deleted.push(record);
          continue;
        }
        const parent = presence.page.parent as { type?: string; database_id?: string };
        if (parent.type === "workspace") {
          deleted.push(record);
          continue;
        }
        const parentId =
          parent.database_id ?? (await extractParentId(this.notionClient, presence.page));
        if (parentId) {
          alive.set(record, normalizeNotionId(parentId));
        } else {
          getLogger().warn(
            `[Im-Nobsidian] 목록에 없는 ${record.obsidianPath} — 부모를 알 수 없어 이번에는 지우지 않음`,
          );
        }
      } catch (error) {
        getLogger().warn(
          `[Im-Nobsidian] 목록에 없는 ${record.obsidianPath} — 원격을 확인하지 못해 이번에는 지우지 않음:`,
          error,
        );
      }
    }

    for (let grew = true; grew;) {
      grew = false;
      for (const [record, parentId] of alive) {
        if (!scope.has(parentId)) continue;
        scope.add(normalizeNotionId(record.notionPageId!));
        alive.delete(record);
        grew = true;
        getLogger().info(
          `[Im-Nobsidian] 목록에 없던 ${record.obsidianPath} 는 Notion 에 그대로 있음 — 지우지 않음`,
        );
      }
    }
    // 남은 것은 살아 있지만 범위 밖으로 옮겨졌다.
    deleted.push(...alive.keys());

    return deleted.map((record) => remoteDeletionChange(record));
  }

  private isTrackedParent(parentId: string): boolean {
    if (notionIdsEqual(parentId, this.config.notion.rootPageId)) return true;
    return !!this.stateDb.getByNotionId(parentId);
  }
}
