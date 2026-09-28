/**
 * 원격을 얼마나 훑을지 — 전체 대조인가, 바뀐 것만인가 (ADR-027).
 *
 * 전체 대조는 루트 아래 페이지를 모두 순회하고 동기화하는 DB 를 모두 조회한다. 원격에서 지운 것 ·
 * 범위 밖으로 옮긴 것은 이것으로만 보인다 — search 는 휴지통을 돌려주지 않는다. 대신 비싸다: 실볼트
 * (발견 DB 166개)에서 원격이 그대로인데도 재pull 이 523.5초 걸렸다(실측 2026-09-28). 예전에는
 * `deleteSync` 가 켜져 있으면 pull · 상태 확인마다 전체 대조를 했고, 플러그인은 늘 켠다.
 *
 * 그래서 전체 대조는 주기(`sync.fullReconcileInterval`)마다만 하고, 그 사이에는 지난 pull 뒤에 바뀐
 * 페이지 · 행 · DB 스키마만 search 로 찾아 그 DB 만 조회한다. 원격 삭제는 다음 전체 대조가 반영한다.
 */
import type { FullScanReason, RemoteScanInfo } from "../types/sync.js";
import { compactNotionId } from "../utils/id.js";

/** 마지막으로 전체 대조를 마친 pull 이 시작한 시각을 두는 상태 메타 키. */
export const LAST_FULL_PULL_META_KEY = "last_full_pull_at";

/**
 * 다음 pull 이 바뀐 것이 없어도 조회할 DB 를 두는 상태 메타 키 — 조회하다 실패했거나 · 행을 받지
 * 못했거나 · 취소로 닿지 못한 DB. 적어 두지 않으면 그 DB 는 원격이 다시 바뀌거나 전체 대조가 돌 때까지
 * 받지 못한 채로 남는다.
 */
export const PENDING_DATABASES_META_KEY = "db_pull_pending";

export type RemoteScan =
  | { readonly kind: "full"; readonly reason: FullScanReason }
  | {
      readonly kind: "incremental";
      /** 지난 pull 의 기준 시각 — 이 뒤에 바뀐 것을 찾는다. */
      readonly since: string;
      readonly lastFullAt: string | null;
      /** 다음 전체 대조 예정 시각. null 이면 이미 때가 됐다 — 다음 pull 이 한다. */
      readonly nextFullAt: string | null;
    };

export interface RemoteScanState {
  /** 증분 조회의 기준 시각(`last_pull_at`). */
  readonly lastPullAt: string | null;
  readonly lastFullPullAt: string | null;
  /** 추적 중인 레코드 수 — 0 이면 볼트에 받은 것이 없다. */
  readonly trackedRecords: number;
  /** DB 모드 — 루트가 DB 하나라 그 DB 조회가 곧 전체 대조다. */
  readonly databaseMode: boolean;
  /** 전체 대조 주기(초). 0 이면 pull 마다 전체 대조한다. */
  readonly fullReconcileIntervalSec: number;
}

export interface RemoteScanOptions {
  /** `--force` — 전체 대조한다. */
  readonly force: boolean;
  readonly now: number;
  /**
   * 주기가 됐어도 이번에는 전체 대조하지 않는다 — 상태 확인 · 경로를 좁힌 pull. 둘은 볼트 전체를
   * 받지 않으므로 전체 대조를 마친 것으로 적을 수 없고, 상태 확인마다 분 단위를 쓰게 된다.
   */
  readonly deferDue?: boolean;
}

export function chooseRemoteScan(state: RemoteScanState, options: RemoteScanOptions): RemoteScan {
  if (options.force) return { kind: "full", reason: "forced" };
  if (state.databaseMode) return { kind: "full", reason: "database-mode" };
  if (!state.lastPullAt || state.trackedRecords === 0) return { kind: "full", reason: "first" };
  // 주기를 읽을 수 없으면(손으로 만든 설정 등) 예전처럼 pull 마다 전체 대조한다 — 덜 훑지 않는다.
  if (!Number.isFinite(state.fullReconcileIntervalSec) || state.fullReconcileIntervalSec <= 0) {
    return { kind: "full", reason: "every-pull" };
  }

  const nextFullAt = nextFullReconcileAt(state.lastFullPullAt, state.fullReconcileIntervalSec);
  if (nextFullAt === null || Date.parse(nextFullAt) <= options.now) {
    if (!options.deferDue) return { kind: "full", reason: "due" };
    return {
      kind: "incremental",
      since: state.lastPullAt,
      lastFullAt: state.lastFullPullAt,
      nextFullAt: null,
    };
  }
  return {
    kind: "incremental",
    since: state.lastPullAt,
    lastFullAt: state.lastFullPullAt,
    nextFullAt,
  };
}

/** 다음 전체 대조 예정 시각 — 한 번도 안 했거나 읽을 수 없는 시각이면 null(때가 됐다). */
function nextFullReconcileAt(lastFullPullAt: string | null, intervalSec: number): string | null {
  const last = lastFullPullAt === null ? NaN : Date.parse(lastFullPullAt);
  return Number.isFinite(last) ? new Date(last + intervalSec * 1000).toISOString() : null;
}

/**
 * 결과에 싣는 모양 — 화면이 「원격 삭제는 언제 반영되나」 를 알린다.
 *
 * @param deleteSync 원격 삭제를 볼트에 반영하는 설정인가 — 꺼져 있으면 미룰 삭제도 없다.
 */
export function remoteScanInfo(
  scan: RemoteScan,
  lastFullPullAt: string | null,
  deleteSync: boolean,
): RemoteScanInfo {
  return scan.kind === "full"
    ? {
        kind: "full",
        reason: scan.reason,
        lastFullAt: lastFullPullAt,
        nextFullAt: null,
        deletionsDeferred: false,
      }
    : {
        kind: "incremental",
        lastFullAt: scan.lastFullAt,
        nextFullAt: scan.nextFullAt,
        deletionsDeferred: deleteSync,
      };
}

/**
 * 이번 pull 이 조회할 DB. `all` — 전체 대조. `changed` — 바뀐 것이 보인 DB 만(id 는
 * {@link compactNotionId}). 새로 발견한 DB 는 어느 쪽이든 조회한다 — 받은 적이 없다.
 */
export type DatabaseSelection =
  { readonly kind: "all" } | { readonly kind: "changed"; readonly ids: ReadonlySet<string> };

export const ALL_DATABASES: DatabaseSelection = { kind: "all" };

export function selectsDatabase(selection: DatabaseSelection, databaseId: string): boolean {
  return selection.kind === "all" || selection.ids.has(compactNotionId(databaseId));
}

/** 상태 메타의 대기 DB. 없거나 깨졌으면 빈 목록 — 다음 전체 대조가 어차피 모두 조회한다. */
export function parsePendingDatabases(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((id): id is string => typeof id === "string").map((id) => compactNotionId(id)),
    );
  } catch {
    return new Set();
  }
}

export function serializePendingDatabases(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].sort());
}

/**
 * DB 마다 이번 pull 이 어떻게 끝났나 — 다음 pull 이 바뀐 것이 없어도 다시 조회할 DB
 * ({@link PENDING_DATABASES_META_KEY})를 가른다.
 *
 * 조회하다 실패했거나 · 받지 못한 행이 있거나 · 취소로 닿지 못한 DB 는 대기로 남는다. 받았거나 · 이제
 * 없어서 뺀 DB 는 대기에서 빠진다. 이번에 조회하지 않은 DB 의 대기는 그대로 남는다.
 */
export class DatabasePullLedger {
  private readonly settled = new Set<string>();
  private readonly unfinished = new Set<string>();
  private skippedCount = 0;
  /** 이제 동기화하는 DB — 알면 대기를 이것으로 좁힌다. */
  private syncing: Set<string> | null = null;

  constructor(
    private readonly selection: DatabaseSelection,
    private readonly pending: ReadonlySet<string>,
  ) {}

  /** 이 DB 를 조회하나 — 새로 발견한 DB 는 부른 쪽이 따로 조회한다(받은 적이 없다). */
  selects(databaseId: string): boolean {
    return selectsDatabase(this.selection, databaseId);
  }

  /** 바뀐 것이 보이지 않아 조회하지 않았다. */
  skip(): void {
    this.skippedCount++;
  }

  /** 받았거나 · 이제 없어서 뺐다 — 다시 조회할 것이 없다. */
  settle(databaseId: string): void {
    this.settled.add(compactNotionId(databaseId));
  }

  /** 조회하다 실패했거나 · 받지 못한 행이 있거나 · 취소로 닿지 못했다 — 다음 pull 이 다시 조회한다. */
  retry(databaseId: string): void {
    this.unfinished.add(compactNotionId(databaseId));
  }

  get skipped(): number {
    return this.skippedCount;
  }

  /**
   * 이제 동기화하는 DB 를 알린다 — 대기를 이것으로 좁힌다. 설정에서 뺐거나 접근 불가로 뺀 DB 를 영영
   * 들고 있지 않는다. 알리지 않으면(발견이 멈춤 등) 좁히지 않는다 — 모르는 것을 버리지 않는다.
   */
  keepOnly(databaseIds: Iterable<string>): void {
    this.syncing = new Set([...databaseIds].map((id) => compactNotionId(id)));
  }

  /** 다음 pull 의 대기 — 지난 대기에서 받은 것을 빼고 이번에 받지 못한 것을 더한다. */
  nextPending(): Set<string> {
    const next = new Set([...this.pending].filter((id) => !this.settled.has(id)));
    for (const id of this.unfinished) next.add(id);
    const syncing = this.syncing;
    return syncing ? new Set([...next].filter((id) => syncing.has(id))) : next;
  }
}
