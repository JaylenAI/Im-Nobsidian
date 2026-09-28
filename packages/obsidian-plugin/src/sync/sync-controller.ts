import {
  getLogger,
  inAnyPathScope,
  isRemoteDeletion,
  notionIdsEqual,
  SyncBusyError,
} from "@im-nobsidian/core";
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
  RenameKind,
  ResolutionChoice,
} from "@im-nobsidian/core";
import { choiceText } from "../conflict-choices.js";

/** 동기화 표시 상태 (상태바·사이드바 공용 단일 진실원). */
export type SyncPhase = "ready" | "syncing" | "error" | "conflict";
export type SyncOperation = "pull" | "push" | "sync";

/** 사이드바 대시보드가 그리는 동기화 상태의 정규 형태. */
export interface SyncDashboardState {
  lastSyncAt: string | null;
  localChanges: LocalChange[];
  /** 옮긴 폴더 — 그 안의 노트는 `localChanges` 에 옮김으로 따로 있다. */
  folderMoves: FolderMoveChange[];
  remoteChanges: RemoteChange[];
  conflicts: Conflict[];
  syncState: SyncPhase;
  operationType: SyncOperation | null;
  progress: { current: number; total: number; currentPath: string } | null;
  errorMessage: string | null;
  completionSummary: string | null;
}

export type SyncStatePatch = Partial<SyncDashboardState>;

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
  /** 마지막 원격 확인이 본 원격 변경 — 받은 것을 목록에서 빼려고 둔다({@link dropPulled}). */
  private remoteChanges: RemoteChange[] = [];

  constructor(
    private readonly orchestrator: SyncOrchestrator,
    private readonly hooks: SyncControllerHooks = {},
  ) {}

  /** 작업이 도는 중인지 — 취소한 작업도 실제로 멈출 때까지 돈다. */
  isSyncing(): boolean {
    return this.active !== null;
  }

  /** 진행률 콜백 — core 의 진행 신호를 사이드바 상태 패치로 변환한다. */
  private progressCallback(): ProgressCallback {
    return (current, total, item) => {
      this.hooks.onState?.({
        syncState: "syncing",
        progress: { current, total, currentPath: item.path },
      });
    };
  }

  /**
   * 사용자가 부른 작업을 받을 수 있나. 도는 작업이 있으면 무엇이 돌아 거절했는지 알린다 —
   * 기다리게 하지 않는다(실볼트 pull 은 500초가 걸린다).
   */
  private admit(requested: GatedOperation): boolean {
    if (this.closed) return false;
    if (!this.active) return true;
    this.hooks.onNotice?.(
      `Im-Nobsidian: ${new SyncBusyError(this.active.operation, requested).message}`,
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
    this.hooks.onState?.({
      syncState: "syncing",
      operationType: operation,
      progress: null,
      errorMessage: null,
      completionSummary: null,
    });
    this.hooks.onNotice?.(`Im-Nobsidian: ${label} 시작...`);
  }

  /** 실패 공통 처리(에러 표시 + 상태바 error). */
  private fail(label: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    this.hooks.onNotice?.(`Im-Nobsidian ${label} 실패: ${msg}`);
    this.hooks.onStatusBar?.("error");
    this.hooks.onState?.({
      syncState: "error",
      operationType: null,
      progress: null,
      errorMessage: msg,
    });
  }

  /** 취소한 작업이 멈췄다 — 그때까지 처리한 것은 남는다. */
  private cancelled(): void {
    this.hooks.onNotice?.("Im-Nobsidian: 동기화 취소됨");
    this.hooks.onStatusBar?.("ready");
    this.hooks.onState?.({
      syncState: "ready",
      operationType: null,
      progress: null,
      errorMessage: null,
      completionSummary: "동기화가 취소되었습니다",
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
    report: (result: R) => { summary: string; phase: SyncPhase },
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
          const { summary, phase } = report(result);
          this.hooks.onNotice?.(
            `Im-Nobsidian: ${summary} (${(result.duration / 1000).toFixed(1)}s)`,
          );
          this.hooks.onStatusBar?.(phase);
          this.hooks.onState?.({ completionSummary: summary, operationType: null });
          completed?.(result);
        }
        await this.refreshLocal();
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
      }),
    );
  }

  /** Pull. `paths` 를 주면 그 노트만 받는다 — 변경 패널의 항목별 받기. */
  async pull(paths?: string[]): Promise<void> {
    await this.runUserOperation(
      "pull",
      "Pull",
      (options) => this.orchestrator.pull(paths ? { ...options, paths } : options),
      (result) => ({
        summary: `Pull 완료 — 생성 ${result.created} / 수정 ${result.updated} / 삭제 ${result.deleted}${result.conflicts.length > 0 ? ` / 충돌 ${result.conflicts.length}` : ""}${result.failed.length > 0 ? ` / 실패 ${result.failed.length}` : ""}`,
        phase: result.conflicts.length > 0 ? "conflict" : "ready",
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
        summary: `Sync 완료 — Pull(+${result.pull.created} ~${result.pull.updated} -${result.pull.deleted}) Push(+${result.push.created} ~${result.push.updated} -${result.push.deleted}${result.push.moved > 0 ? ` →${result.push.moved}` : ""})${result.conflicts.length > 0 ? ` / 충돌 ${result.conflicts.length}` : ""}`,
        phase: result.conflicts.length > 0 ? "conflict" : "ready",
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
    this.hooks.onState?.({ remoteChanges: kept });
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
        this.hooks.onNotice?.(`Im-Nobsidian: 되돌림 — ${path}`);
        await this.refreshLocal();
      } catch (error) {
        this.fail("되돌리기", error);
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
   * Vault 이벤트 기반 자동 동기화. UI 트리거(push/pull/sync)와 달리 사이드바/알림은 건드리지
   * 않고 상태바만 갱신한다. 도는 작업이 있으면 끝난 뒤 한 번 돈다 — 그 사이의 편집을 버리지
   * 않는다. 충돌을 푸는 동안 병합 결과를 쓴 파일이 부른 것도 푼 뒤에 돈다.
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
        if (!signal.aborted) this.dropPulled(result.pull);
      } catch (error) {
        // 알림은 띄우지 않는다(자동이다). 대신 이유를 사이드바에 남긴다 — 예전에는 상태바만 「오류」
        // 로 바꾸고 이유를 버려, 무엇을 고쳐야 하는지 알 수 없었다.
        this.hooks.onStatusBar?.("error");
        this.hooks.onState?.({
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
      await this.refreshLocal();
      return;
    }
    await this.exclusive("status", async () => {
      try {
        this.hooks.onState?.({
          syncState: "syncing",
          operationType: null,
          progress: null,
          errorMessage: null,
        });
        const status = await this.orchestrator.status();
        this.remoteChanges = status.remoteChanges;
        const syncState: SyncPhase = status.conflictRecords.length > 0 ? "conflict" : "ready";
        this.hooks.onState?.({
          lastSyncAt: status.lastSyncAt,
          localChanges: status.localChanges,
          folderMoves: [...status.folderMoves],
          remoteChanges: status.remoteChanges,
          conflicts: status.conflicts,
          syncState,
          progress: null,
          errorMessage: null,
        });
      } catch (error) {
        // 사용자가 누른 새로고침이다. 예전에는 무시해 사이드바가 「동기화 중」 에 남았다.
        this.fail("상태 확인", error);
      }
    });
  }

  /** 로컬만 보는 새로고침 — 도는 작업과 함께 부를 수 있다. */
  private async refreshLocal(): Promise<void> {
    try {
      const status = await this.orchestrator.statusLocal();
      const syncState: SyncPhase = status.conflictRecords.length > 0 ? "conflict" : "ready";
      this.hooks.onState?.({
        lastSyncAt: status.lastSyncAt,
        localChanges: status.localChanges,
        folderMoves: [...status.folderMoves],
        conflicts: status.conflicts,
        syncState,
        progress: null,
        errorMessage: null,
      });
    } catch {
      // 사이드바 새로고침은 best-effort — 실패해도 무시.
    }
  }

  /**
   * 도는 작업을 취소한다. 잠금은 작업이 실제로 멈출 때까지 쥔다 — 처리 중인 항목은 끝까지 가므로,
   * 예전처럼 바로 풀면 멈추는 중인 작업과 새 작업이 겹쳤다(S-09). 취소됐다는 표시는 멈춘 뒤에 한다.
   */
  cancel(): void {
    const active = this.active;
    if (!active || active.abort.signal.aborted) return;
    active.abort.abort();
    this.hooks.onNotice?.("Im-Nobsidian: 취소하는 중 — 처리 중인 항목을 마친 뒤 멈춥니다");
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
    if (newPath.endsWith(".md")) {
      this.recordRename(oldPath, newPath, "file");
      return true;
    }
    if (oldPath.endsWith(".md")) {
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
   * {@link SyncBusyError} 로 거절한다 — 무엇이 돌고 있는지는 오류가 말한다.
   */
  async getStatus(): Promise<Awaited<ReturnType<SyncOrchestrator["status"]>>> {
    if (this.closed)
      throw new Error("Im-Nobsidian 을 다시 불러오는 중입니다 — 잠시 뒤 다시 시도하세요");
    if (this.active) throw new SyncBusyError(this.active.operation, "status");
    let status!: Awaited<ReturnType<SyncOrchestrator["status"]>>;
    await this.exclusive("status", async () => {
      status = await this.orchestrator.status();
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
      await this.refreshLocal();
    });
  }

  private async resolveEach(choose: ConflictChooser, signal: AbortSignal): Promise<void> {
    let conflicts: Conflict[];
    try {
      conflicts = await this.orchestrator.listConflicts();
    } catch (error) {
      this.hooks.onNotice?.(
        `Im-Nobsidian: 충돌 목록을 읽지 못함 — ${errorMessage(error)}`,
        ACTIONABLE_NOTICE_MS,
      );
      return;
    }
    if (conflicts.length === 0) {
      this.hooks.onNotice?.("Im-Nobsidian: 충돌이 없습니다.");
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
          this.hooks.onNotice?.(`Im-Nobsidian: ${path} → ${choiceText(conflict, choice).label}`);
        } else {
          remaining++;
          this.hooks.onNotice?.(
            `Im-Nobsidian: 자동 병합이 겹치는 줄을 남겼습니다 — ${path} 에서 충돌 표시(<<<<<<<)를 고친 뒤 다시 해결하세요.`,
            ACTIONABLE_NOTICE_MS,
          );
        }
      } catch (error) {
        failed++;
        this.hooks.onNotice?.(
          // Notion 에서 지운 노트는 충돌로 되돌리지 않는다 — 무엇이 남았는지는 오류가 말한다.
          isRemoteDeletion(conflict)
            ? `Im-Nobsidian: ${errorMessage(error)}`
            : `Im-Nobsidian: 충돌을 해결하지 못함 (${path}) — ${errorMessage(error)}. 충돌로 남겨 두었습니다.`,
          ACTIONABLE_NOTICE_MS,
        );
      }
    }

    const parts = [`해결 ${resolved}건`, `남음 ${remaining}건`];
    if (failed > 0) parts.push(`실패 ${failed}건`);
    if (cleared.size > 0) parts.push(`양쪽이 이미 같아 표시만 푼 ${cleared.size}건`);
    this.hooks.onNotice?.(`Im-Nobsidian: 충돌 해결 — ${parts.join(" · ")}`);
    this.hooks.onStatusBar?.(remaining + failed > 0 ? "conflict" : "ready");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
