import {
  getLogger,
  IGNORE_FILE,
  inAnyPathScope,
  isMarkdownPath,
  isRemoteDeletion,
  notionIdsEqual,
  SyncBusyError,
} from "@im-nobsidian/core";
import { NOTICE_PREFIX } from "../constants.js";
import type {
  SyncOrchestrator,
  GatedOperation,
  ProgressCallback,
  ChangeDiff,
  LocalChange,
  FolderMoveChange,
  RemoteChange,
  Conflict,
  PullResult,
  PushResult,
  RenameKind,
  ResolutionChoice,
  StatusResult,
  SyncDirection,
  SyncRecord,
} from "@im-nobsidian/core";
import { choiceText } from "../conflict-choices.js";
import { directionBlocks, type DirectionBlocks } from "./direction.js";

/** 동기화 표시 상태 (상태바·사이드바 공용 단일 진실원). */
export type SyncPhase = "ready" | "syncing" | "error" | "conflict";
export type SyncOperation = "pull" | "push" | "sync";

/** 사이드바 대시보드가 그리는 동기화 상태의 정규 형태. */
export interface SyncDashboardState {
  lastSyncAt: string | null;
  /** 마지막으로 원격을 전체 대조한 때 — Notion 에서 지운 노트는 그때 볼트에 반영된다 (ADR-027). */
  lastFullScanAt: string | null;
  localChanges: LocalChange[];
  /** 옮긴 폴더 — 그 안의 노트는 `localChanges` 에 옮김으로 따로 있다. */
  folderMoves: FolderMoveChange[];
  remoteChanges: RemoteChange[];
  /**
   * 충돌로 표시된 노트 — 상태 DB 의 충돌 기록이다. 원격을 읽지 않아도 알므로 로컬 새로고침도 싣는다
   * (CLI `status` 와 같다). 예전에는 원격까지 본 `Conflict` 를 실어, 로컬 새로고침이 늘 빈 목록으로
   * 덮었다 — 패널이 「충돌 0건」 을 보이고 충돌 해결 단추가 사라졌다.
   */
  conflictRecords: SyncRecord[];
  syncState: SyncPhase;
  operationType: SyncOperation | null;
  progress: { current: number; total: number; currentPath: string } | null;
  errorMessage: string | null;
  completionSummary: string | null;
  /** 동기화 방향이 막는 Push · Pull — 패널은 그 단추를 끄고 까닭을 보인다. */
  blocked: DirectionBlocks;
}

export type SyncStatePatch = Partial<SyncDashboardState>;

/** 아무것도 모를 때의 패널 — 처음 열 때와 연결을 바꿀 때 이것에서 시작한다. */
export const EMPTY_DASHBOARD_STATE: SyncDashboardState = {
  lastSyncAt: null,
  lastFullScanAt: null,
  localChanges: [],
  folderMoves: [],
  remoteChanges: [],
  conflictRecords: [],
  syncState: "ready",
  operationType: null,
  progress: null,
  errorMessage: null,
  completionSummary: null,
  blocked: { push: null, pull: null },
};

/** 패널이 지금 보이는 단계 · 진행 · 오류 — 도는 작업이나 끝난 작업이 정한다. */
type ShownPhase = Pick<
  SyncDashboardState,
  "syncState" | "operationType" | "progress" | "errorMessage"
>;

/**
 * 컨트롤러가 바깥(플러그인 셸)으로 내보내는 부수효과 훅.
 * 어떤 UI 프레임워크·Obsidian API 와도 결합되지 않도록, 표시·알림은 전부 콜백으로 위임한다.
 */
export interface SyncControllerHooks {
  /** 사이드바 등 UI 상태 패치를 반영한다. */
  onState?: (patch: SyncStatePatch) => void;
  /** 사용자 알림(예: Obsidian Notice). */
  onNotice?: (message: string, durationMs?: number) => void;
  /** 상태바 표시 갱신. */
  onStatusBar?: (state: SyncPhase) => void;
}

/**
 * Push/Pull/Sync 오케스트레이션과 진행·상태·알림 방출을 한곳에 모은 UI 비종속 컨트롤러.
 *
 * 기존에는 플러그인 엔트리(main.ts)가 SyncOrchestrator 호출과 Obsidian Notice/사이드바/상태바
 * 갱신을 한 메서드 안에 뒤섞어 push/pull/sync 마다 동일 구조를 중복했다. 그 책임을 이 클래스로
 * 옮겨 ① 플러그인 셸은 배선만 담당하고 ② sync 실행 로직은 mock orchestrator + spy hooks 로
 * Obsidian 런타임 없이 단위 테스트할 수 있게 한다.
 */
/** 알림이 사용자가 읽고 고칠 것을 담을 때 — 기본보다 오래 둔다. */
const ACTIONABLE_NOTICE_MS = 8000;

/** 도는 작업 하나 — 취소하고 끝나기를 기다릴 때 쓴다. */
interface ActiveTask {
  readonly operation: GatedOperation;
  readonly abort: AbortController;
  /** 작업이 끝나면 풀린다 — 실패해도 거절되지 않는다. */
  readonly done: Promise<void>;
}

/** 충돌 하나를 무엇으로 풀지 묻는다. 고르지 않으면 null. 신호가 취소되면 묻기를 닫는다. */
export type ConflictChooser = (
  conflict: Conflict,
  signal: AbortSignal,
) => Promise<ResolutionChoice | null>;

export class SyncController {
  /**
   * 볼트 · 상태 DB · 원격을 만지는 작업은 한 번에 하나만 돈다(S-09). 수동 · 자동 · 볼트 이벤트
   * sync 와 충돌 해결 · 원격 상태 확인이 모두 이 줄에 선다. 예전에는 셋이 저마다 다른 표시로
   * 가드해, 수동 pull 중에 볼트 이벤트 sync 가 같은 오케스트레이터를 불렀다.
   */
  private active: ActiveTask | null = null;
  /** 도는 작업이 있어 미룬 볼트 이벤트 sync — 끝난 뒤 한 번 돈다. */
  private vaultSyncPending = false;
  /** {@link shutdown} 뒤 — 어떤 작업도 받지 않는다. */
  private closed = false;
  /** 패널에 보인 목록 읽기 실패 — 다음에 읽으면 걷는다({@link refreshLocal}). */
  private listReadError: string | null = null;
  /** 마지막 원격 확인이 본 원격 변경 — 받은 것을 목록에서 빼려고 둔다({@link dropPulled}). */
  private remoteChanges: RemoteChange[] = [];
  /** 패널에 보낸 단계 — 목록만 다시 읽는 새로고침은 이것을 덮지 않고 다시 싣는다({@link refreshLocal}). */
  private shown: ShownPhase = {
    syncState: "ready",
    operationType: null,
    progress: null,
    errorMessage: null,
  };

  /** 동기화 방향이 막는 동작 — 목록을 보낼 때 함께 싣는다(새로 연 패널도 받는다). */
  private readonly blocked: DirectionBlocks;

  constructor(
    private readonly orchestrator: SyncOrchestrator,
    private readonly hooks: SyncControllerHooks = {},
    direction: SyncDirection = "both",
  ) {
    this.blocked = directionBlocks(direction);
  }

  /** 작업이 도는 중인지 — 취소한 작업도 실제로 멈출 때까지 돈다. */
  isSyncing(): boolean {
    return this.active !== null;
  }

  /** 진행률 콜백 — core 의 진행 신호를 사이드바 상태 패치로 변환한다. */
  private progressCallback(): ProgressCallback {
    return (current, total, item) => {
      this.emitState({
        syncState: "syncing",
        progress: { current, total, currentPath: item.path },
      });
    };
  }

  /** 패널에 상태를 보낸다. 단계 · 진행 · 오류는 {@link shown} 에도 적는다. */
  private emitState(patch: SyncStatePatch): void {
    const { syncState, operationType, progress, errorMessage } = { ...this.shown, ...patch };
    this.shown = { syncState, operationType, progress, errorMessage };
    this.hooks.onState?.(patch);
  }

  /**
   * 사용자가 부른 작업을 받을 수 있나. 도는 작업이 있으면 무엇이 돌아 거절했는지 알린다 —
   * 기다리게 하지 않는다(실볼트 pull 은 500초가 걸린다).
   */
  private admit(requested: GatedOperation): boolean {
    if (this.closed) return false;
    if (!this.active) return true;
    this.hooks.onNotice?.(
      `${NOTICE_PREFIX}: ${new SyncBusyError(this.active.operation, requested).message}`,
    );
    return false;
  }

  /** 작업을 줄에 세워 돌린다. 부르기 전에 도는 작업이 없음을 확인한다({@link admit}). */
  private async exclusive(
    operation: GatedOperation,
    task: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const abort = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    this.active = { operation, abort, done };
    try {
      await task(abort.signal);
    } finally {
      this.active = null;
      settle();
      if (this.vaultSyncPending) {
        this.vaultSyncPending = false;
        void this.vaultSync();
      }
    }
  }

  /** 실행 직전 공통 상태 진입(시작 표시). */
  private begin(operation: SyncOperation, label: string): void {
    this.hooks.onStatusBar?.("syncing");
    this.emitState({
      syncState: "syncing",
      operationType: operation,
      progress: null,
      errorMessage: null,
      completionSummary: null,
    });
    this.hooks.onNotice?.(`${NOTICE_PREFIX}: ${label} 시작...`);
  }

  /** 실패 공통 처리(에러 표시 + 상태바 error). */
  private fail(label: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    this.hooks.onNotice?.(`${NOTICE_PREFIX} ${label} 실패: ${msg}`);
    this.hooks.onStatusBar?.("error");
    this.emitState({
      syncState: "error",
      operationType: null,
      progress: null,
      errorMessage: msg,
    });
  }

  /** 취소한 작업이 멈췄다 — 그때까지 처리한 것은 남는다. */
  private cancelled(label = "동기화", summary = "동기화가 취소되었습니다"): void {
    this.hooks.onNotice?.(`${NOTICE_PREFIX}: ${label} 취소됨`);
    this.hooks.onStatusBar?.("ready");
    this.emitState({
      syncState: "ready",
      operationType: null,
      progress: null,
      errorMessage: null,
      completionSummary: summary,
    });
  }

  /**
   * 사용자가 부른 push · pull · sync — 시작 · 완료 · 취소 · 실패를 알린다. `completed` 는 끝까지
   * 돈 작업에만 부른다 — 취소 · 실패한 작업은 무엇을 처리했는지 모른다.
   */
  private async runUserOperation<R extends { readonly duration: number }>(
    operation: SyncOperation,
    label: string,
    call: (options: { onProgress: ProgressCallback; signal: AbortSignal }) => Promise<R>,
    report: (result: R) => { summary: string; phase: SyncPhase; warning?: string | null },
    completed?: (result: R) => void,
  ): Promise<void> {
    if (!this.admit(operation)) return;
    await this.exclusive(operation, async (signal) => {
      this.begin(operation, label);
      try {
        const result = await call({ onProgress: this.progressCallback(), signal });
        if (signal.aborted) {
          this.cancelled();
        } else {
          const { summary, phase, warning } = report(result);
          this.hooks.onNotice?.(
            `${NOTICE_PREFIX}: ${summary} (${(result.duration / 1000).toFixed(1)}s)`,
          );
          if (warning) this.hooks.onNotice?.(`${NOTICE_PREFIX}: ${warning}`, ACTIONABLE_NOTICE_MS);
          this.hooks.onStatusBar?.(phase);
          // 패널도 상태바와 같은 단계로 둔다 — 아래 새로고침이 실패해도 「동기화 중」 에 남지 않는다.
          this.emitState({
            completionSummary: summary,
            syncState: phase,
            operationType: null,
            progress: null,
          });
          completed?.(result);
        }
        await this.refreshLocal(true);
      } catch (error) {
        this.fail(label, error);
      }
    });
  }

  /** Push. `paths` 를 주면 그 노트만 올린다 — 변경 패널의 항목별 올리기. */
  async push(paths?: string[]): Promise<void> {
    await this.runUserOperation(
      "push",
      "Push",
      (options) => this.orchestrator.push(paths ? { ...options, paths } : options),
      (result) => ({
        summary: `Push 완료 — 생성 ${result.created} / 수정 ${result.updated} / 삭제 ${result.deleted}${result.moved > 0 ? ` / 이동 ${result.moved}` : ""}${result.failed.length > 0 ? ` / 실패 ${result.failed.length}` : ""}`,
        phase: "ready",
        warning: warnings(
          renamedPropertyText(result),
          schemaEditText(result),
          viewEditText(result),
          placementChangeText(result),
          readOnlyText(result),
          unsentDeletionText(result),
        ),
      }),
    );
  }

  /**
   * Pull. `paths` 를 주면 그 노트만 받는다 — 변경 패널의 항목별 받기. `force` 는 원격을 전체 대조한다 —
   * Notion 에서 지운 노트를 주기를 기다리지 않고 반영한다(CLI `pull --force`, ADR-027).
   */
  async pull(
    paths?: string[],
    {
      force = false,
      rerender = false,
    }: { readonly force?: boolean; readonly rerender?: boolean } = {},
  ): Promise<void> {
    await this.runUserOperation(
      "pull",
      rerender ? "Pull(다시 그리기)" : force ? "Pull(전체 확인)" : "Pull",
      (options) =>
        this.orchestrator.pull({
          ...options,
          ...(paths ? { paths } : {}),
          ...(force ? { force } : {}),
          ...(rerender ? { rerender } : {}),
        }),
      (result) => ({
        summary: `Pull 완료 — 생성 ${result.created} / 수정 ${result.updated} / 삭제 ${result.deleted}${movedText(result)}${result.conflicts.length > 0 ? ` / 충돌 ${result.conflicts.length}` : ""}${result.failed.length > 0 ? ` / 실패 ${result.failed.length}` : ""}`,
        phase: result.conflicts.length > 0 ? "conflict" : "ready",
        warning: warnings(
          schemaFollowedText(result),
          heldSidecarText(result.heldSidecars ?? []),
          heldBaseText(result.heldBases ?? []),
          restoredText(result),
        ),
      }),
      (result) => this.dropPulled(result, paths),
    );
  }

  async sync(): Promise<void> {
    await this.runUserOperation(
      "sync",
      "Sync",
      (options) => this.orchestrator.sync(options),
      (result) => ({
        summary: `Sync 완료 — Pull(+${result.pull.created} ~${result.pull.updated} -${result.pull.deleted}${result.pull.moved?.length ? ` →${result.pull.moved.length}` : ""}) Push(+${result.push.created} ~${result.push.updated} -${result.push.deleted}${result.push.moved > 0 ? ` →${result.push.moved}` : ""})${result.conflicts.length > 0 ? ` / 충돌 ${result.conflicts.length}` : ""}`,
        phase: result.conflicts.length > 0 ? "conflict" : "ready",
        warning: warnings(
          schemaFollowedText(result.pull),
          restoredText(result.pull),
          renamedPropertyText(result.push),
          schemaEditText(result.push),
          viewEditText(result.push),
          placementChangeText(result.push),
          heldSidecarText(
            (result.pull.heldSidecars ?? []).filter(
              (path) => !(result.push.schemaEdits ?? []).some((edit) => edit.path === path),
            ),
          ),
          heldBaseText(
            (result.pull.heldBases ?? []).filter(
              (path) => !(result.push.viewEdits ?? []).some((edit) => edit.path === path),
            ),
          ),
          readOnlyText(result.push),
          unsentDeletionText(result.push),
        ),
      }),
      (result) => this.dropPulled(result.pull),
    );
  }

  /**
   * 받은 원격 변경을 목록에서 뺀다. 예전에는 받은 뒤에도 다시 확인할 때까지 「받을 것」 으로
   * 남았다. 원격을 다시 훑지 않는다 — 실볼트 전체 대조는 분 단위다.
   *
   * 실패 · 충돌한 것은 남긴다. 볼트 경로가 없는 새 페이지는 실패가 하나라도 있으면 어느 것이
   * 실패했는지 가를 수 없어 남긴다.
   */
  private dropPulled(result: PullResult, paths?: readonly string[]): void {
    if (this.remoteChanges.length === 0) return;
    const failedPaths = new Set(result.failed.map((failure) => failure.path));
    const pending = (change: RemoteChange): boolean =>
      result.conflicts.some((conflict) =>
        notionIdsEqual(conflict.remoteChange.pageId, change.pageId),
      ) || (change.path ? failedPaths.has(change.path) : result.failed.length > 0);
    const pulled = (change: RemoteChange): boolean =>
      change.path ? inAnyPathScope(change.path, paths) : !paths || paths.length === 0;
    const kept = this.remoteChanges.filter((change) => !pulled(change) || pending(change));
    if (kept.length === this.remoteChanges.length) return;
    this.remoteChanges = kept;
    this.emitState({ remoteChanges: kept });
  }

  /**
   * 자동 동기화 주기. 도는 작업이 있으면 조용히 건너뛴다 — 다음 주기에 돈다. 예전에는 긴 sync
   * 동안 주기가 돌아와 같은 오케스트레이터를 겹쳐 불렀다(S-09).
   */
  async autoSync(): Promise<void> {
    if (this.closed || this.active) return;
    await this.sync();
  }

  /**
   * 로컬 변경 하나를 지난 동기화 때의 글로 되돌린다(Git `restore`). 되돌릴 수 없으면 이유를 알린다.
   */
  async discard(path: string): Promise<void> {
    if (!this.admit("discard")) return;
    await this.exclusive("discard", async () => {
      try {
        await this.orchestrator.discardLocalChange(path);
        this.hooks.onNotice?.(`${NOTICE_PREFIX}: 되돌림 — ${path}`);
        await this.refreshLocal(true);
      } catch (error) {
        this.fail("되돌리기", error);
      }
    });
  }

  /**
   * 볼트의 노트 폴더를 다음 push 에서 Notion DB 로 만들도록 사이드카를 써 둔다(#75). Notion 에는 쓰지 않는다.
   * 거절은 사용자가 고를 수 있는 일(이미 올린 폴더 · 이미 DB)이라 오류 상태로 두지 않고 까닭만 알린다.
   *
   * @param configDir Obsidian 설정 폴더 — 속성 타입을 읽는다.
   */
  async prepareDatabase(folder: string, configDir: string): Promise<void> {
    if (!this.admit("prepare-database")) return;
    await this.exclusive("prepare-database", async () => {
      try {
        const report = await this.orchestrator.prepareFolderDatabase(folder, configDir);
        const skipped =
          report.skipped.length > 0 ? ` · 옮기지 않은 것 ${report.skipped.length}` : "";
        const pages =
          report.pagesToRows > 0
            ? ` 이미 올린 노트 ${report.pagesToRows}개는 같은 페이지째 행으로 옮깁니다.`
            : "";
        this.hooks.onNotice?.(
          `${NOTICE_PREFIX}: ${report.folder} 를 다음 push 에서 Notion DB 로 만듭니다 — 행 ${report.rows} · ` +
            `속성 ${report.properties.length} · 보기 ${report.views.length}${skipped}. ` +
            `속성 타입은 ${report.sidecarPath} 에서 고칠 수 있습니다.${pages}`,
        );
        await this.refreshLocal(true);
      } catch (error) {
        this.hooks.onNotice?.(
          `${NOTICE_PREFIX}: DB 로 올릴 준비를 하지 못함 — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  /**
   * 로컬 변경 하나의 두 글 — 지난 동기화 때의 글과 지금 볼트의 글(변경 패널의 줄 비교 창). 읽기만
   * 하므로 줄에 서지 않는다 — 긴 pull 이 도는 동안에도 볼 수 있다. 못 견주면 이유를 담아 거절한다.
   */
  localChangeDiff(change: LocalChange): Promise<ChangeDiff> {
    return this.orchestrator.localChangeDiff(change);
  }

  /** 원격 변경 하나의 두 글 — 지난 동기화 때의 글과 Notion 의 지금 글. Notion 을 읽기만 한다. */
  remoteChangeDiff(change: RemoteChange): Promise<ChangeDiff> {
    return this.orchestrator.remoteChangeDiff(change);
  }

  /**
   * Vault 이벤트 기반 자동 동기화. UI 트리거(push/pull/sync)와 달리 알림 · 진행 표시 없이 상태바만
   * 「동기화 중」 으로 둔다. 끝나면 패널의 목록을 새로고친다 — 예전에는 새로고치지 않아, 올린 노트가
   * 다음 새로고침까지 변경으로 남았다. 도는 작업이 있으면 끝난 뒤 한 번 돈다 — 그 사이의 편집을
   * 버리지 않는다. 충돌을 푸는 동안 병합 결과를 쓴 파일이 부른 것도 푼 뒤에 돈다.
   */
  async vaultSync(): Promise<void> {
    if (this.closed) return;
    if (this.active) {
      this.vaultSyncPending = true;
      return;
    }
    await this.exclusive("sync", async (signal) => {
      this.hooks.onStatusBar?.("syncing");
      try {
        const result = await this.orchestrator.sync({ signal });
        this.hooks.onStatusBar?.(result.conflicts.length > 0 ? "conflict" : "ready");
        if (!signal.aborted) {
          this.dropPulled(result.pull);
          await this.refreshLocal(true);
        }
      } catch (error) {
        // 알림은 띄우지 않는다(자동이다). 대신 이유를 사이드바에 남긴다 — 예전에는 상태바만 「오류」
        // 로 바꾸고 이유를 버려, 무엇을 고쳐야 하는지 알 수 없었다.
        this.hooks.onStatusBar?.("error");
        this.emitState({
          syncState: "error",
          operationType: null,
          progress: null,
          errorMessage: `자동 동기화 실패: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  }

  /**
   * 사이드바 상태 새로고침. fullCheck=true 면 원격까지 조회(status), 아니면 로컬만(statusLocal).
   * 원격 조회는 이번 실행의 원격 기준을 정하므로 도는 작업과 겹치지 않는다 — 도는 작업이 있으면
   * 알리고 로컬만 새로고친다.
   */
  async refreshStatus(fullCheck = false): Promise<void> {
    if (!fullCheck || !this.admit("status")) {
      await this.refreshLocal(false);
      return;
    }
    await this.exclusive("status", async (signal) => {
      try {
        this.emitState({
          syncState: "syncing",
          operationType: null,
          progress: null,
          errorMessage: null,
        });
        const status = await this.orchestrator.status({ signal });
        this.remoteChanges = status.remoteChanges;
        this.settle(status, { remoteChanges: status.remoteChanges });
        const pending = remoteStatusText(status);
        if (pending) this.hooks.onNotice?.(`${NOTICE_PREFIX}: ${pending}`, ACTIONABLE_NOTICE_MS);
      } catch (error) {
        // 취소한 것은 실패가 아니다 — 원격 목록은 지난번 것을 그대로 둔다.
        if (signal.aborted) this.cancelled("상태 확인", "상태 확인이 취소되었습니다");
        // 사용자가 누른 새로고침이다. 예전에는 무시해 사이드바가 「동기화 중」 에 남았다.
        else this.fail("상태 확인", error);
      }
    });
  }

  /**
   * 로컬만 보는 새로고침 — 목록(로컬 변경 · 옮긴 폴더 · 충돌 · 마지막 동기화)을 다시 읽는다. 도는 작업과
   * 함께 부를 수 있다.
   *
   * @param settle 방금 끝난 작업의 단계를 정한다({@link settle}). 아니면(볼트 편집 · 패널 열기) 도는
   *   작업의 진행과 지난 작업의 실패 이유를 덮지 않는다 — 예전에는 pull 이 쓴 노트의 볼트 이벤트가 이
   *   새로고침을 불러, 도는 동안 패널이 「준비됨」 으로 돌아가고 진행 막대가 사라졌다.
   */
  private async refreshLocal(settle: boolean): Promise<void> {
    let status: StatusResult;
    try {
      status = await this.orchestrator.statusLocal();
    } catch (error) {
      // 읽지 못한 것을 「바뀐 것 없음」 으로 두지 않는다 — 예전에는 버려, 패널이 옛 목록을 까닭 없이 보였다.
      // 도는 작업이 있으면 그 작업이 끝나며 다시 읽는다 — 그 진행을 덮지 않는다.
      if (this.closed || (!settle && this.active)) return;
      const message = `변경 목록을 읽지 못했습니다: ${errorMessage(error)}`;
      if (settle) {
        // 방금 끝난 작업은 이미 단계를 정했다(충돌이면 충돌 · 해결 단추). 그 단계를 지키고 알리기만 한다.
        this.hooks.onNotice?.(`${NOTICE_PREFIX}: ${message}`, ACTIONABLE_NOTICE_MS);
        return;
      }
      this.listReadError = message;
      this.hooks.onStatusBar?.("error");
      this.emitState({
        syncState: "error",
        operationType: null,
        progress: null,
        errorMessage: this.listReadError,
      });
      return;
    }
    // 보이는 오류가 지난번 목록 읽기의 것이면 다시 읽은 지금 걷는다 — 작업의 실패 이유는 그대로 둔다.
    const listErrorShown =
      this.shown.syncState === "error" && this.shown.errorMessage === this.listReadError;
    this.listReadError = null;
    if (settle || (!this.active && (this.shown.syncState !== "error" || listErrorShown))) {
      this.settle(status);
      return;
    }
    // 단계는 그대로 다시 싣는다 — 작업 중에 새로 연 패널도 진행 · 오류를 받는다.
    this.emitState({ ...listsOf(status), blocked: this.blocked, ...this.shown });
  }

  /** 끝났다 — 충돌이 남았으면 충돌, 아니면 준비됨. 패널과 상태바가 같은 단계를 보인다. */
  private settle(status: StatusResult, patch: SyncStatePatch = {}): void {
    const phase: SyncPhase = status.conflictRecords.length > 0 ? "conflict" : "ready";
    this.hooks.onStatusBar?.(phase);
    this.emitState({
      ...listsOf(status),
      blocked: this.blocked,
      ...patch,
      syncState: phase,
      operationType: null,
      progress: null,
      errorMessage: null,
    });
  }

  /**
   * 도는 작업을 취소한다. 잠금은 작업이 실제로 멈출 때까지 쥔다 — 처리 중인 항목은 끝까지 가므로,
   * 예전처럼 바로 풀면 멈추는 중인 작업과 새 작업이 겹쳤다(S-09). 취소됐다는 표시는 멈춘 뒤에 한다.
   */
  cancel(): void {
    const active = this.active;
    if (!active || active.abort.signal.aborted) return;
    active.abort.abort();
    this.hooks.onNotice?.(`${NOTICE_PREFIX}: 취소하는 중 — 처리 중인 항목을 마친 뒤 멈춥니다`);
  }

  /**
   * 플러그인을 내리거나 설정이 바뀌어 오케스트레이터를 새로 만들 때 부른다. 도는 작업을 취소하고
   * 끝나기를 기다린다 — 부른 쪽은 그 뒤에 상태 DB 를 닫는다. 예전에는 도는 sync 아래에서 DB 를
   * 닫았다. 그 뒤로는 어떤 작업도 받지 않는다.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.vaultSyncPending = false;
    const active = this.active;
    if (!active) return;
    active.abort.abort();
    await active.done;
  }

  /**
   * 볼트의 rename 이벤트(S-11). 노트 · 폴더의 이름 변경을 옛 경로와 함께 적어 둔다 — 다음
   * 동기화가 옮긴 노트를 짝지을 때 쓴다. 이름과 내용을 함께 바꾼 노트도 새 페이지가 아니라
   * 원래 페이지를 옮기는 것으로 올라간다. 노트를 노트가 아닌 파일로 바꾼 것은 지운 것과 같다.
   *
   * @returns 동기화할 변경인가 — 노트 · 폴더면 참.
   */
  onVaultRename(oldPath: string, newPath: string, isFolder: boolean): boolean {
    if (isFolder) {
      this.recordRename(oldPath, newPath, "folder");
      return true;
    }
    if (isMarkdownPath(newPath)) {
      this.recordRename(oldPath, newPath, "file");
      return true;
    }
    if (isMarkdownPath(oldPath)) {
      this.recordDelete(oldPath);
      return true;
    }
    return false;
  }

  /** 볼트에서 노트 · 폴더를 지웠다 — 그 자리를 새 경로로 적은 이름 변경 기록을 버린다. */
  recordDelete(path: string): void {
    try {
      this.orchestrator.recordLocalDelete(path);
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 지운 경로의 이름 변경 기록을 지우지 못함 (${path}): ${errorMessage(error)}`,
      );
    }
  }

  /** 기록하지 못해도 동기화는 계속된다 — 내용이 그대로인 노트는 기록 없이도 짝을 찾는다. */
  private recordRename(oldPath: string, newPath: string, kind: RenameKind): void {
    try {
      this.orchestrator.recordLocalRename(oldPath, newPath, kind);
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 이름 변경을 적지 못함 (${oldPath} → ${newPath}): ${errorMessage(error)}`,
      );
    }
  }

  /**
   * 상태 조회(상태 표시 커맨드용 — 표시 포맷은 셸이 담당). 원격까지 보므로 도는 작업이 있으면
   * {@link SyncBusyError} 로 거절한다 — 무엇이 돌고 있는지는 오류가 말한다. 취소하면 알리고 null.
   */
  async getStatus(): Promise<Awaited<ReturnType<SyncOrchestrator["status"]>> | null> {
    if (this.closed)
      throw new Error(`${NOTICE_PREFIX} 을 다시 불러오는 중입니다 — 잠시 뒤 다시 시도하세요`);
    if (this.active) throw new SyncBusyError(this.active.operation, "status");
    let status: Awaited<ReturnType<SyncOrchestrator["status"]>> | null = null;
    await this.exclusive("status", async (signal) => {
      try {
        status = await this.orchestrator.status({ signal });
      } catch (error) {
        if (!signal.aborted) throw error;
        this.hooks.onNotice?.(`${NOTICE_PREFIX}: 상태 확인 취소됨`);
      }
    });
    return status;
  }

  /**
   * 충돌을 하나씩 물어 푼다 — CLI `resolve` 와 같은 순서(N-06).
   *
   * - 목록은 충돌로 표시된 노트만 읽는다. 예전에는 pull 을 돌려 목록을 얻었다 — 풀기도 전에 다른
   *   노트를 원격으로 덮어썼다.
   * - 양쪽이 이미 같아진 충돌은 묻지 않고 표시만 푼다.
   * - 푸는 것은 오케스트레이터다 — 고른 결과를 Notion 에 올리고, 올리지 못하면 충돌로 남긴다.
   *   예전에는 ConflictResolver 만 불러 볼트와 상태 DB 만 바꿨고, 다음 sync 가 바뀐 원격으로
   *   고른 로컬 · 병합 결과를 덮었다.
   *
   * 도는 작업이 있으면 알리고 풀지 않는다. 푸는 동안 온 볼트 이벤트 sync 는 푼 뒤에 돈다.
   *
   * @param choose 충돌 하나를 무엇으로 풀지 묻는다(모달). 고르지 않으면 null — 그 충돌은 남는다.
   *   플러그인을 내리면 신호가 취소된다 — 묻던 창을 닫고 남은 충돌은 묻지 않는다.
   */
  async resolveConflicts(choose: ConflictChooser): Promise<void> {
    if (!this.admit("resolve")) return;
    await this.exclusive("resolve", async (signal) => {
      await this.resolveEach(choose, signal);
      await this.refreshLocal(true);
    });
  }

  private async resolveEach(choose: ConflictChooser, signal: AbortSignal): Promise<void> {
    let conflicts: Conflict[];
    try {
      conflicts = await this.orchestrator.listConflicts();
    } catch (error) {
      this.hooks.onNotice?.(
        `${NOTICE_PREFIX}: 충돌 목록을 읽지 못함 — ${errorMessage(error)}`,
        ACTIONABLE_NOTICE_MS,
      );
      return;
    }
    if (conflicts.length === 0) {
      this.hooks.onNotice?.(`${NOTICE_PREFIX}: 충돌이 없습니다.`);
      this.hooks.onStatusBar?.("ready");
      return;
    }

    const cleared = new Set(this.orchestrator.clearStaleConflicts(conflicts));
    let resolved = 0;
    let remaining = 0;
    let failed = 0;
    for (const conflict of conflicts) {
      const path = conflict.syncRecord.obsidianPath;
      if (cleared.has(path)) continue;
      const choice = signal.aborted ? null : await choose(conflict, signal);
      if (!choice) {
        remaining++;
        continue;
      }
      try {
        const result = await this.orchestrator.resolveConflict(conflict, choice);
        if (result.success) {
          resolved++;
          this.hooks.onNotice?.(
            `${NOTICE_PREFIX}: ${path} → ${choiceText(conflict, choice).label}`,
          );
        } else {
          remaining++;
          this.hooks.onNotice?.(
            `${NOTICE_PREFIX}: 자동 병합이 겹치는 줄을 남겼습니다 — ${path} 에서 충돌 표시(<<<<<<<)를 고친 뒤 다시 해결하세요.`,
            ACTIONABLE_NOTICE_MS,
          );
        }
      } catch (error) {
        failed++;
        this.hooks.onNotice?.(
          // Notion 에서 지운 노트는 충돌로 되돌리지 않는다 — 무엇이 남았는지는 오류가 말한다.
          isRemoteDeletion(conflict)
            ? `${NOTICE_PREFIX}: ${errorMessage(error)}`
            : `${NOTICE_PREFIX}: 충돌을 해결하지 못함 (${path}) — ${errorMessage(error)}. 충돌로 남겨 두었습니다.`,
          ACTIONABLE_NOTICE_MS,
        );
      }
    }

    const parts = [`해결 ${resolved}건`, `남음 ${remaining}건`];
    if (failed > 0) parts.push(`실패 ${failed}건`);
    if (cleared.size > 0) parts.push(`양쪽이 이미 같아 표시만 푼 ${cleared.size}건`);
    this.hooks.onNotice?.(`${NOTICE_PREFIX}: 충돌 해결 — ${parts.join(" · ")}`);
    this.hooks.onStatusBar?.(remaining + failed > 0 ? "conflict" : "ready");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 상태 조회가 준 목록 — 로컬 변경 · 옮긴 폴더 · 충돌 · 마지막 동기화 · 마지막 전체 대조. */
function listsOf(status: StatusResult): SyncStatePatch {
  return {
    lastSyncAt: status.lastSyncAt,
    lastFullScanAt: status.lastFullScanAt,
    localChanges: status.localChanges,
    folderMoves: [...status.folderMoves],
    conflictRecords: status.conflictRecords,
  };
}

/**
 * 받으며 옮긴 것 — Notion 에서 옮긴 페이지와 바꾼 제목으로 이름을 바꾼 노트를 따로 센다(ADR-040). 고친 링크와 범위 밖이라
 * 받지 않은 새 페이지도.
 */
function movedText(result: PullResult): string {
  const moves = result.moved ?? [];
  const renamed = moves.filter((move) => move.renamed).length;
  const moved = moves.length - renamed;
  return (
    (moved > 0 ? ` / 이동 ${moved}` : "") +
    (renamed > 0 ? ` / 이름 변경 ${renamed}` : "") +
    (result.relinked?.length ? ` / 링크 고침 ${result.relinked.length}` : "") +
    (result.excluded?.length ? ` / 받지 않음 ${result.excluded.length}(동기화 범위 밖)` : "")
  );
}

/**
 * 볼트에서 고쳤지만 올리지 않은 읽기 전용 속성(수식 · 롤업 · ID …) — 다음 Pull 이 Notion 값으로 되돌린다. 예전에는
 * 로그에만 남아 고친 값이 말없이 사라졌다.
 */
function readOnlyText(result: PushResult): string | null {
  const skips = result.readOnlySkipped ?? [];
  if (skips.length === 0) return null;
  const names = [...new Set(skips.flatMap((skip) => skip.properties))];
  return (
    `읽기 전용 속성은 Notion 이 값을 정해 올리지 않았습니다 — 다음 Pull 이 Notion 값으로 되돌립니다: ` +
    `${names.slice(0, 3).join(", ")}${names.length > 3 ? " …" : ""} (노트 ${skips.length}개)`
  );
}

/** 볼트에서 바꾼 DB 속성 이름을 Notion 의 열 이름으로 바꾼 것(ADR-045) — 행 값은 그대로라 수정 수에 들지 않는다. */
function renamedPropertyText(result: PushResult): string | null {
  const renames = result.renamedProperties ?? [];
  if (renames.length === 0) return null;
  return `볼트에서 바꾼 속성 이름을 Notion 열에 옮겼습니다: ${renames
    .map(({ from, to }) => `${from} → ${to}`)
    .join(", ")}`;
}

/** 고친 사이드카의 속성을 Notion DB 에 올린 것(ADR-045). */
function schemaEditText(result: PushResult): string | null {
  const edits = result.schemaEdits ?? [];
  if (edits.length === 0) return null;
  const changes = edits.flatMap((edit) => [
    ...edit.added.map((name) => `${name} 더함`),
    ...edit.removed.map((name) => `${name} 지움`),
    ...edit.renamed.map(([from, to]) => `${from} → ${to}`),
    ...edit.retyped.map(([name, type]) => `${name} 타입 ${type}`),
    ...edit.redefined.map((name) => `${name} 설정`),
    ...(edit.renamedOptions ?? []).map(([name, from, to]) => `${name} 옵션 ${from} → ${to}`),
    ...(edit.droppedOptions ?? []).map(
      ([name, options]) => `${name} 옵션 ${options.join(", ")} 지움(그 값의 행은 빈 값)`,
    ),
  ]);
  return (
    `사이드카에서 고친 속성을 Notion 에 올렸습니다: ` +
    `${changes.slice(0, 3).join(", ")}${changes.length > 3 ? " …" : ""}`
  );
}

/** 고친 `.base` 의 보기를 Notion 보기에 올린 것(ADR-046). */
function viewEditText(result: PushResult): string | null {
  const edits = result.viewEdits ?? [];
  if (edits.length === 0) return null;
  const names = edits.map((edit) => (edit.from ? `${edit.from} → ${edit.view}` : edit.view));
  return (
    `.base 에서 고친 보기를 Notion 에 올렸습니다: ` +
    `${names.slice(0, 3).join(", ")}${names.length > 3 ? " …" : ""}`
  );
}

/**
 * 옮겨서 Notion 에서 행 · 페이지가 된 노트(ADR-047). 다른 DB 에서 온 행이 대상 DB 에 더한 열을 함께 알린다 — 그 열은
 * Notion 이 더했고, 지우려면 Notion 에서 지운다.
 */
function placementChangeText(result: PushResult): string | null {
  const changes = result.placementChanges ?? [];
  if (changes.length === 0) return null;
  const rows = changes.filter((change) => change.becomes === "row").length;
  const pages = changes.length - rows;
  const columns = [...new Set(changes.flatMap((change) => change.addedColumns ?? []))];
  return (
    `옮긴 노트를 Notion 에서 ${[rows > 0 ? `행 ${rows}개` : "", pages > 0 ? `페이지 ${pages}개` : ""].filter(Boolean).join(" · ")}로 바꿨습니다` +
    (columns.length > 0
      ? ` — 대상 DB 에 더해진 열: ${columns.slice(0, 5).join(", ")}${columns.length > 5 ? " …" : ""}`
      : "") +
    `: ${listedPaths(changes.map((change) => change.path))}`
  );
}

/** 볼트에서 보기를 고쳐 Pull 이 덮어쓰지 않은 `.base`(ADR-046) — Push 해야 Notion 에 간다. */
function heldBaseText(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  return `보기를 고친 .base 는 덮어쓰지 않았습니다 — Push 하면 고친 보기 이름 · 열 · 정렬 · 필터를 Notion 에 올립니다: ${listedPaths(paths)}`;
}

/** 볼트에서 고쳐 Pull 이 덮어쓰지 않은 사이드카(ADR-045) — Push 해야 Notion 에 간다. */
function heldSidecarText(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  return `고친 사이드카는 덮어쓰지 않았습니다 — Push 하면 고친 속성을 Notion 에 올립니다: ${listedPaths(paths)}`;
}

/** 볼트에서 지웠지만 Notion 에서 지우지 않은 노트(deleteSync 꺼짐) — 다음 Pull 이 되살린다(D8). */
function unsentDeletionText(result: PushResult): string | null {
  const paths = result.unsentDeletions ?? [];
  if (paths.length === 0) return null;
  return (
    `볼트에서 지운 노트 ${paths.length}개는 Notion 에서 지우지 않았습니다(삭제 동기화 꺼짐) — 다음 Pull 이 되살립니다: ` +
    listedPaths(paths)
  );
}

/** Pull 이 Notion 에서 되살린 노트 — 볼트에서 지웠지만 Notion 에 그대로 있던 것(D8). */
function restoredText(result: PullResult): string | null {
  const paths = result.restoredPaths ?? [];
  if (paths.length === 0) return null;
  return (
    `볼트에서 지운 노트 ${paths.length}개를 Notion 에서 되살렸습니다 — 삭제 동기화가 꺼져 있어 Notion 에 보내지 않습니다: ` +
    listedPaths(paths)
  );
}

/**
 * Notion 에서 이름을 바꾸거나 지운 DB 속성을 행 노트의 키에 옮긴 것(ADR-045) — 노트의 키가 말없이 바뀌지 않게. 지운 속성에
 * 올리지 않은 값이 있어 남긴 노트도 함께.
 */
function schemaFollowedText(result: PullResult): string | null {
  const followed = result.schemaFollowed ?? [];
  if (followed.length === 0) return null;
  const changes = followed.flatMap((db) => [
    ...db.renamed.map(([from, to]) => `${from} → ${to}`),
    ...db.removed.map((name) => `${name} 지움`),
  ]);
  const rows = followed.reduce((sum, db) => sum + db.rows, 0);
  const kept = followed.flatMap((db) => db.kept.map(({ path, key }) => `${path} (${key})`));
  return (
    `Notion 에서 바뀐 속성을 행 노트 ${rows}개에 옮겼습니다: ` +
    `${changes.slice(0, 3).join(", ")}${changes.length > 3 ? " …" : ""}` +
    (kept.length > 0
      ? `\n지운 속성에 올리지 않은 값이 있어 남겼습니다(Notion 에는 그 열이 없습니다): ${listedPaths(kept)}`
      : "")
  );
}

/** 알림에 늘어놓는 경로 — 셋까지, 나머지는 수로. */
function listedPaths(paths: readonly string[]): string {
  return `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` 외 ${paths.length - 3}개` : ""}`;
}

/** 경고 여럿을 한 알림으로 — 없으면 null. */
function warnings(...texts: (string | null)[]): string | null {
  const present = texts.filter((text): text is string => text !== null);
  return present.length > 0 ? present.join("\n") : null;
}

/**
 * 원격까지 본 상태 확인이 찾은, 다음 Pull 이 볼트에서 옮기거나 이름을 바꿀 노트와 받지 않을 새 페이지 — 없으면 null.
 * 원격 변경 목록에는 들지 않는 것이라 알림으로 알린다.
 */
function remoteStatusText(status: StatusResult): string | null {
  const moves = status.remoteMoves ?? [];
  const renamed = moves.filter((move) => move.renamed).length;
  const parts = [
    moves.length - renamed > 0 ? `Notion 에서 옮긴 노트 ${moves.length - renamed}` : "",
    renamed > 0 ? `Notion 에서 제목을 바꾼 노트 ${renamed}` : "",
    status.remoteMoveSkipped?.length ? `옮기지 못할 노트 ${status.remoteMoveSkipped.length}` : "",
  ].filter(Boolean);
  const excluded = status.remoteExcluded?.length ?? 0;
  const lines = [
    parts.length > 0 ? `다음 Pull 이 볼트에 반영합니다 — ${parts.join(" · ")}` : "",
    excluded > 0
      ? `Notion 의 새 페이지 ${excluded}개는 동기화 범위(경로 패턴 · ${IGNORE_FILE}) 밖이라 받지 않습니다: ${status.remoteExcluded!.slice(0, 3).join(", ")}${excluded > 3 ? " …" : ""}`
      : "",
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : null;
}
