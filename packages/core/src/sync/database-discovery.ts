import type { Conflict, FailedOperation } from "../types/sync.js";
import type { Config } from "../types/config.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { NotionClient } from "../notion/client.js";
import { isNotionAccessDenied, isNotionObjectNotFound } from "../notion/client.js";
import type { DatabaseSyncer, RowProgress } from "./database-syncer.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
import { compactNotionId, notionIdsEqual, normalizeNotionId } from "../utils/id.js";
import type { AbortLike } from "../utils/pool.js";
import { extractInlineDbIds } from "../utils/inline-db-refs.js";
import { resolveDbFolderPath, repairDbFolderCollisions } from "../utils/db-folder-path.js";
import { rewriteDbPlaceholders, type DbEmbedTarget } from "./db-placeholder-rewriter.js";
import type { DatabasePullLedger } from "./remote-scan.js";
import type { VaultFS } from "./vault-fs.js";
import { isDatabaseMode } from "./parent-mode.js";
import {
  DISCOVERED_DBS_META_KEY,
  INACCESSIBLE_DBS_META_KEY,
  LINKED_DBS_META_KEY,
  loadInaccessibleDbIds,
  loadLinkedDbMap,
  parseDiscoveredDbs,
  type DiscoveredDbConfig,
} from "./discovered-databases.js";

/** 자동 발견된 DB 설정 빌드 결과 — 동기화 가능/linked 해소/접근 불가/일시 오류를 구분한다. */
type DiscoveredDbOutcome =
  | { kind: "ok"; config: DiscoveredDbConfig }
  | { kind: "linked"; originalDbId: string }
  | { kind: "inaccessible" }
  | { kind: "error"; error: string };

/**
 * 발견하다 읽지 못해 다음 pull 이 다시 볼 것을 보존하는 상태 메타 키. 캐시가 차면 블록 스캔을 다시
 * 하지 않으므로, 따로 적어 두지 않으면 한 번 읽지 못한 DB 는 `--force` 전까지 발견되지 않는다.
 * DB 행 조회 실패는 여기 두지 않는다 — 그 DB 는 캐시에 남아 다음 pull 이 다시 받는다.
 */
const DISCOVERY_RETRY_META_KEY = "discovery_retry";

/**
 * 하위 DB 블록 스캔을 마친 시각을 두는 상태 메타 키. 스캔은 추적 페이지마다 요청 1회라 처음 한 번만
 * 한다 — 그 뒤에 생긴 DB 는 받은 페이지의 본문(`<database>` 태그)으로 찾는다. 예전에는 «발견한 DB
 * 캐시가 비었는가» 로 가려, DB 가 하나도 없는 볼트는 원격이 그대로여도 pull 마다 모든 페이지를 다시
 * 훑었다.
 */
const DISCOVERY_SCANNED_META_KEY = "discovery_scanned_at";

interface DiscoveryRetry {
  /** 자식 DB 를 확인하지 못한 페이지. */
  readonly parents: string[];
  /** 찾았지만 설정(제목 · 조회 가능 여부)을 읽지 못한 DB. */
  readonly dbs: Array<{ dbId: string; parentPageId: string }>;
}

function parseDiscoveryRetry(raw: string | null): DiscoveryRetry {
  if (!raw) return { parents: [], dbs: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<DiscoveryRetry>;
    return {
      parents: Array.isArray(parsed.parents) ? parsed.parents : [],
      dbs: Array.isArray(parsed.dbs) ? parsed.dbs : [],
    };
  } catch {
    return { parents: [], dbs: [] };
  }
}

/**
 * 페이지 모드 볼트의 DB 자동 발견 — 추적 페이지 안의 child_database 를 찾아 등록하고, 등록한 DB 를
 * 폴더 + `.base` 로 받는다. 설정에 적지 않은 DB 도 페이지 안에 있으면 볼트에 온다.
 *
 * 찾는 길은 둘이다. 처음 한 번은 추적 페이지의 블록을 훑고, 그 뒤로는 pull 이 받은 페이지 본문의
 * `<database>` 태그와 행 본문의 보존 마커로 찾는다 — 페이지마다 요청하지 않는다.
 */
export class DatabaseDiscovery {
  // pull 중 각 페이지 markdown(<database url=.../>)에서 추출한 인라인 DB 참조.
  // key: 하이픈 제거 databaseId, value: 그 DB가 박힌 부모 페이지 id.
  // 블록 트리 재귀 없이 markdown 신호만으로 컬럼/synced_block 등 깊이 중첩된
  // child_database 까지 발견해 폴더+.base 동기화 대상으로 등록한다.
  private readonly _inlineDbRefs = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
    private readonly databaseSyncer: DatabaseSyncer,
  ) {}

  /** 이번 pull 이 받은 페이지 본문에서 모은 인라인 DB 참조를 비운다 — pull 마다 새로 모은다. */
  clearInlineRefs(): void {
    this._inlineDbRefs.clear();
  }

  // Markdown API는 인라인 데이터베이스를 <database url="..." ...>Title</database> 로 렌더한다
  // (컬럼/콜아웃/synced_block 내부 포함). url 의 32자리 hex 가 databaseId 이므로 블록 트리
  // 재귀 없이 이 신호만으로 깊이 중첩된 child_database 를 발견한다. url 호스트는
  // www.notion.so / app.notion.com/p 두 형태가 실측돼 고정하지 않는다 — 규칙은
  // extractInlineDbIds(blocks-API 폴백 마커 겸용) 참조.
  collectInlineDbRefs(parentPageId: string, rawMarkdown: string): void {
    for (const dbId of extractInlineDbIds(rawMarkdown)) {
      this._inlineDbRefs.set(dbId, parentPageId);
    }
  }

  /**
   * 자동 발견한 DB 를 받는다 — 새로 발견한 DB 를 등록하고, 등록된 DB 가운데 `ledger` 가 고른 것과
   * 이번에 새로 등록한 것만 조회한다(ADR-027). 조회하지 않은 DB 는 목록에 그대로 남는다.
   *
   * @param options.forceRediscovery `--force` — 블록을 다시 훑고 접근 불가 DB 를 다시 확인한다.
   * @param options.ledger 조회할 DB 와 DB 마다의 결과. 없으면 모든 DB 를 조회한다.
   * @param options.signal 취소하면 다음 DB 를 조회하지 않는다 — 닿지 못한 DB 는 대기로 남는다.
   */
  async pullDiscoveredDatabases(
    writtenPaths: string[],
    failed: FailedOperation[],
    conflicts: Conflict[],
    options: {
      readonly forceRediscovery?: boolean;
      readonly paths?: readonly string[];
      readonly progress?: RowProgress;
      readonly ledger?: DatabasePullLedger;
      readonly signal?: AbortLike;
    } = {},
  ): Promise<{ created: number; updated: number; deleted: number; restored: number }> {
    if (isDatabaseMode(this.config)) return { created: 0, updated: 0, deleted: 0, restored: 0 };
    const { paths, progress, ledger, signal } = options;
    const forceRediscovery = options.forceRediscovery === true;

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let restored = 0;

    try {
      const dbConfigs = parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY));

      const configuredIds = new Set(
        (this.config.notion.databases ?? []).map((d) => d.databaseId.replace(/-/g, "")),
      );
      const knownIds = new Set<string>([
        ...configuredIds,
        ...dbConfigs.map((c) => c.databaseId.replace(/-/g, "")),
      ]);
      let changed = false;
      // 이번 pull 이 새로 등록한 DB — 받은 적이 없어 바뀐 것이 보이지 않아도 조회한다.
      const registeredNow = new Set<string>();

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
      const inaccessibleIds = loadInaccessibleDbIds(this.stateDb);
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
      const linkedMap = loadLinkedDbMap(this.stateDb);
      let linkedChanged = false;

      // 발견하다 읽지 못한 것 — 이유와 함께 실패로 싣고 다음 pull 이 다시 본다. 읽지 못한 것을
      // 없다고 하면 pull 이 성공으로 끝나, 사용자는 그 DB 를 받지 못한 줄 모른다.
      const retry = parseDiscoveryRetry(this.stateDb.getMeta(DISCOVERY_RETRY_META_KEY));
      const nextRetry: DiscoveryRetry = { parents: [], dbs: [] };
      const pathOf = (pageId: string): string =>
        notionIdsEqual(pageId, this.config.notion.rootPageId)
          ? ""
          : (this.stateDb.getByNotionId(pageId)?.obsidianPath ?? pageId);
      const unreadParent = (pageId: string, error: string): void => {
        nextRetry.parents.push(pageId);
        failed.push({
          path: pathOf(pageId),
          operation: "update",
          error: `하위 DB 를 확인하지 못함 — 다음 pull 이 다시 확인한다: ${error}`,
        });
      };
      const retryLater = (dbId: string, parentPageId: string, error: string): void => {
        nextRetry.dbs.push({ dbId, parentPageId });
        failed.push({
          path: pathOf(parentPageId),
          operation: "create",
          error: `DB ${compactNotionId(dbId).slice(0, 8)} 를 읽지 못함 — 다음 pull 이 다시 본다: ${error}`,
        });
      };

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
            registeredNow.add(origNohyph);
            changed = true;
          } else if (outcome.kind === "error") {
            retryLater(origId, parentPageId, outcome.error);
          } else {
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
          registeredNow.add(nohyph);
          changed = true;
        } else if (outcome.kind === "linked") {
          const origNohyph = outcome.originalDbId.replace(/-/g, "");
          linkedMap.set(nohyph, origNohyph);
          linkedChanged = true;
          await registerOriginal(origNohyph);
        } else if (outcome.kind === "inaccessible") {
          degrade(dbId);
        } else if (outcome.kind === "error") {
          retryLater(dbId, parentPageId, outcome.error);
        }
      };

      // (1) 블록 스캔 기반 발견 — 추적 페이지마다 직속 children 1회 조회로 비용이 크므로
      //     한 번도 훑지 않았을 때(최초 full pull)만 수행한다. 이후 생긴 신규 child DB 는 이
      //     게이트 탓에 복구 경로가 없었으므로(F21), --force 시에는 재스캔을 허용한다.
      //     지난번에 읽지 못한 페이지 · DB 는 캐시가 있어도 다시 본다. 캐시가 찬 볼트는 이 표시가
      //     생기기 전에 훑었다 — 다시 훑지 않는다.
      const scanAll =
        forceRediscovery ||
        (dbConfigs.length === 0 && !this.stateDb.getMeta(DISCOVERY_SCANNED_META_KEY));
      if (signal?.aborted) {
        // 취소했으면 훑지 않는다 — 페이지마다 요청 1회라 첫 pull 에서는 분 단위다. 다시 볼 것은
        // 그대로 남긴다(캐시가 비어 있으면 다음 pull 이 처음부터 훑는다).
        nextRetry.parents.push(...retry.parents);
        nextRetry.dbs.push(...retry.dbs);
      } else {
        const scanIds = scanAll
          ? [
              this.config.notion.rootPageId,
              ...this.stateDb
                .getAll()
                .filter((r) => r.notionPageId)
                .map((r) => r.notionPageId!),
            ]
          : retry.parents;
        if (scanIds.length > 0) {
          const { found, unread } = await this.discoverChildDatabases(scanIds);
          for (const { dbId, parentPageId } of found) {
            await register(dbId, parentPageId);
          }
          for (const { pageId, error } of unread) unreadParent(pageId, error);
        }
        for (const { dbId, parentPageId } of retry.dbs) {
          await register(dbId, parentPageId);
        }
        // 다 훑었다 — 읽지 못한 페이지는 위에서 다시 볼 것으로 적었다.
        if (scanAll) this.stateDb.setMeta(DISCOVERY_SCANNED_META_KEY, new Date().toISOString());
      }

      // (2) markdown 기반 발견 — 추가 API 호출 없이 컬럼/synced_block 내부 깊이 중첩된
      //     child_database 까지 포착한다. 이번 pull 에서 재취득된 페이지에 한해 채워지므로
      //     캐시 유무와 무관하게 항상 병합한다(증분 pull·업그레이드 시 신규 DB 흡수).
      //     취소했어도 등록한다 — 받은 페이지는 다시 받지 않으니 여기서 놓치면 그 DB 는 페이지를
      //     다시 고치거나 `--force` 할 때까지 발견되지 않는다. 조회는 아래에서 취소를 따른다.
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
          const nohyph = dbConfig.databaseId.replace(/-/g, "");
          if (inaccessibleIds.has(nohyph)) continue;
          // 바뀐 것이 보이지 않은 DB 는 조회하지 않는다(ADR-027) — 목록에는 그대로 둔다.
          if (ledger && !registeredNow.has(nohyph) && !ledger.selects(dbConfig.databaseId)) {
            ledger.skip();
            stillSyncable.push(dbConfig);
            continue;
          }
          if (signal?.aborted) {
            ledger?.retry(dbConfig.databaseId);
            stillSyncable.push(dbConfig);
            continue;
          }
          try {
            const dbResult = await this.databaseSyncer.pullDatabase(dbConfig, {
              resolveDbFolder,
              paths,
              progress,
            });
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
              ledger?.settle(dbConfig.databaseId);
              getLogger().info(
                `[Im-Nobsidian] DB ${dbConfig.databaseId}: linked view 컨테이너 감지 → 행은 원본 ${dbResult.linkedOriginalDbId} 폴더가 단일 소유(F25)`,
              );
              continue;
            }
            created += dbResult.created;
            updated += dbResult.updated;
            deleted += dbResult.deleted;
            restored += dbResult.restored;
            conflicts.push(...dbResult.conflicts);
            failed.push(...dbResult.failed);
            // M3: 슬라이스 추정 대신 실제 기록된 행 경로를 후처리 대상으로 받는다.
            writtenPaths.push(...dbResult.writtenPaths);
            roundRowPaths.push(...dbResult.writtenPaths);
            stillSyncable.push(dbConfig);
            // 받지 못한 행이 있으면 다음 pull 이 다시 조회한다 — 그 행의 수정 시각은 다음 조회 창 밖이다.
            if (dbResult.failed.length > 0) ledger?.retry(dbConfig.databaseId);
            else ledger?.settle(dbConfig.databaseId);
          } catch (error) {
            if (isNotionObjectNotFound(error)) {
              // 캐시에 있었지만 이제 행 조회가 404 — 링크드/미공유/삭제로 강등(스택트레이스 억제).
              degrade(dbConfig.databaseId);
              ledger?.settle(dbConfig.databaseId);
            } else {
              // 일시적/실제 오류 — 캐시에 유지해 다음 pull 에 재시도한다. 이유는 실패로 싣는다.
              ledger?.retry(dbConfig.databaseId);
              getLogger().warn(`[Im-Nobsidian] DB ${dbConfig.databaseId} 동기화 실패:`, error);
              failed.push({
                path: dbConfig.localFolder,
                operation: "update",
                error: error instanceof Error ? error.message : String(error),
              });
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
          // 대기로 적는다 — 다음 pull 은 바뀐 DB 만 조회하므로 적지 않으면 받지 못한 채로 남는다.
          getLogger().warn(
            `[Im-Nobsidian] 중첩 DB 발견 라운드 한도(${MAX_DISCOVERY_ROUNDS}) 도달 — ${queue.length}개는 다음 pull 에서 동기화`,
          );
          for (const dbConfig of queue) ledger?.retry(dbConfig.databaseId);
          stillSyncable.push(...queue);
          break;
        }
        if (queue.length > 0) {
          getLogger().info(
            `[Im-Nobsidian] DB row 본문에서 중첩 DB ${queue.length}개 추가 발견(라운드 ${round + 1})`,
          );
        }
      }

      // 대기는 이제 동기화하는 DB 만 — 설정에서 뺐거나 · 접근 불가로 뺀 DB 를 영영 들고 있지 않는다.
      ledger?.keepOnly([...configuredIds, ...stillSyncable.map((c) => c.databaseId)]);

      // 발견·강등·정리 결과를 캐시에 1회 반영(접근 불가 DB 는 stillSyncable 에서 빠져 제거됨).
      if (changed || inaccessibleChanged || stillSyncable.length !== dbConfigs.length) {
        this.stateDb.setMeta(DISCOVERED_DBS_META_KEY, JSON.stringify(stillSyncable));
      }
      if (inaccessibleChanged) {
        this.stateDb.setMeta(INACCESSIBLE_DBS_META_KEY, JSON.stringify([...inaccessibleIds]));
      }
      if (linkedChanged) {
        this.stateDb.setMeta(LINKED_DBS_META_KEY, JSON.stringify(Object.fromEntries(linkedMap)));
      }
      if (
        retry.parents.length + retry.dbs.length + nextRetry.parents.length + nextRetry.dbs.length >
        0
      ) {
        this.stateDb.setMeta(DISCOVERY_RETRY_META_KEY, JSON.stringify(nextRetry));
      }

      // 이번 pull 산출 md 의 인라인 DB placeholder 를 .base 임베드로 재작성한다(F22).
      // .base 생성(위 pullDatabase)이 끝난 뒤여야 임베드가 깨진 링크가 되지 않는다.
      await this.rewriteDbPlaceholderEmbeds(writtenPaths, stillSyncable, linkedMap);
    } catch (error) {
      getLogger().warn("[Im-Nobsidian] child_database 자동 발견 실패:", error);
      failed.push({
        path: "",
        operation: "update",
        error: `DB 자동 발견이 멈춤: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return { created, updated, deleted, restored };
  }

  private async discoverChildDatabases(pageIds: readonly string[]): Promise<{
    found: Array<{ dbId: string; parentPageId: string }>;
    unread: Array<{ pageId: string; error: string }>;
  }> {
    const found: Array<{ dbId: string; parentPageId: string }> = [];
    const unread: Array<{ pageId: string; error: string }> = [];
    const seen = new Set<string>();

    for (const parentId of pageIds) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      try {
        const dbIds = await this.notionClient.getChildDatabaseIds(parentId);
        for (const dbId of dbIds) {
          found.push({ dbId, parentPageId: parentId });
        }
      } catch (error) {
        // 공유하지 않은 블록(404 · 403)은 건너뛴다. 그 밖에 읽지 못한 것은 없다고 하지 않는다.
        if (isNotionObjectNotFound(error) || isNotionAccessDenied(error)) continue;
        unread.push({
          pageId: parentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { found, unread };
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
      return { kind: "error", error: error instanceof Error ? error.message : String(error) };
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
}
