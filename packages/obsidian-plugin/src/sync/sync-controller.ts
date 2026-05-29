import type {
  SyncOrchestrator,
  ProgressCallback,
  LocalChange,
  RemoteChange,
  Conflict,
} from "@im-nobsidian/core";

/** 동기화 표시 상태 (상태바·사이드바 공용 단일 진실원). */
export type SyncPhase = "ready" | "syncing" | "error" | "conflict";
export type SyncOperation = "pull" | "push" | "sync";

/** 사이드바 대시보드가 그리는 동기화 상태의 정규 형태. */
export interface SyncDashboardState {
  lastSyncAt: string | null;
  localChanges: LocalChange[];
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
export class SyncController {
  private abortController: AbortController | null = null;
  private vaultSyncing = false;

  constructor(
    private readonly orchestrator: SyncOrchestrator,
    private readonly hooks: SyncControllerHooks = {},
  ) {}

  /** UI 트리거(push/pull/sync) 가 진행 중인지. */
  isSyncing(): boolean {
    return this.abortController !== null;
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

  /** 실행 직전 공통 상태 진입(취소 토큰 발급 + 시작 표시). */
  private begin(operation: SyncOperation, label: string): AbortSignal {
    this.abortController = new AbortController();
    this.hooks.onStatusBar?.("syncing");
    this.hooks.onState?.({
      syncState: "syncing",
      operationType: operation,
      progress: null,
      errorMessage: null,
      completionSummary: null,
    });
    this.hooks.onNotice?.(`Im-Nobsidian: ${label} 시작...`);
    return this.abortController.signal;
  }

  /** 실패 공통 처리(에러 표시 + 상태바 error). */
  private fail(label: string, error: unknown): void {
    this.abortController = null;
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

  async push(): Promise<void> {
    const signal = this.begin("push", "Push");
    try {
      const result = await this.orchestrator.push({
        onProgress: this.progressCallback(),
        signal,
      });
      this.abortController = null;

      const summary = `Push 완료 — 생성 ${result.created} / 수정 ${result.updated} / 삭제 ${result.deleted}${result.failed.length > 0 ? ` / 실패 ${result.failed.length}` : ""}`;
      this.hooks.onNotice?.(`Im-Nobsidian: ${summary} (${(result.duration / 1000).toFixed(1)}s)`);
      this.hooks.onStatusBar?.("ready");
      this.hooks.onState?.({ completionSummary: summary, operationType: null });
      await this.refreshStatus();
    } catch (error) {
      this.fail("Push", error);
    }
  }

  async pull(): Promise<void> {
    const signal = this.begin("pull", "Pull");
    try {
      const result = await this.orchestrator.pull({
        onProgress: this.progressCallback(),
        signal,
      });
      this.abortController = null;

      const summary = `Pull 완료 — 생성 ${result.created} / 수정 ${result.updated} / 삭제 ${result.deleted}${result.conflicts.length > 0 ? ` / 충돌 ${result.conflicts.length}` : ""}${result.failed.length > 0 ? ` / 실패 ${result.failed.length}` : ""}`;
      this.hooks.onNotice?.(`Im-Nobsidian: ${summary} (${(result.duration / 1000).toFixed(1)}s)`);
      this.hooks.onStatusBar?.(result.conflicts.length > 0 ? "conflict" : "ready");
      this.hooks.onState?.({ completionSummary: summary, operationType: null });
      await this.refreshStatus();
    } catch (error) {
      this.fail("Pull", error);
    }
  }

  async sync(): Promise<void> {
    const signal = this.begin("sync", "Sync");
    try {
      const result = await this.orchestrator.sync({
        onProgress: this.progressCallback(),
        signal,
      });
      this.abortController = null;

      const summary = `Sync 완료 — Pull(+${result.pull.created} ~${result.pull.updated} -${result.pull.deleted}) Push(+${result.push.created} ~${result.push.updated} -${result.push.deleted})${result.conflicts.length > 0 ? ` / 충돌 ${result.conflicts.length}` : ""}`;
      this.hooks.onNotice?.(`Im-Nobsidian: ${summary} (${(result.duration / 1000).toFixed(1)}s)`);
      this.hooks.onStatusBar?.(result.conflicts.length > 0 ? "conflict" : "ready");
      this.hooks.onState?.({ completionSummary: summary, operationType: null });
      await this.refreshStatus();
    } catch (error) {
      this.fail("Sync", error);
    }
  }

  /**
   * Vault 이벤트 기반 자동 동기화. UI 트리거(push/pull/sync)와 달리 사이드바/알림은 건드리지
   * 않고 상태바만 갱신하며, 재진입을 자체 가드로 막는다.
   */
  async vaultSync(): Promise<void> {
    if (this.vaultSyncing) return;
    this.vaultSyncing = true;
    this.hooks.onStatusBar?.("syncing");
    try {
      const result = await this.orchestrator.sync();
      this.hooks.onStatusBar?.(result.conflicts.length > 0 ? "conflict" : "ready");
    } catch {
      this.hooks.onStatusBar?.("error");
    } finally {
      this.vaultSyncing = false;
    }
  }

  /** 사이드바 상태 새로고침. fullCheck=true 면 원격까지 조회(status), 아니면 로컬만(statusLocal). */
  async refreshStatus(fullCheck = false): Promise<void> {
    try {
      if (fullCheck) {
        this.hooks.onState?.({
          syncState: "syncing",
          operationType: null,
          progress: null,
          errorMessage: null,
        });
        const status = await this.orchestrator.status();
        const syncState: SyncPhase = status.conflictRecords.length > 0 ? "conflict" : "ready";
        this.hooks.onState?.({
          lastSyncAt: status.lastSyncAt,
          localChanges: status.localChanges,
          remoteChanges: status.remoteChanges,
          conflicts: status.conflicts,
          syncState,
          progress: null,
          errorMessage: null,
        });
      } else {
        const status = await this.orchestrator.statusLocal();
        const syncState: SyncPhase = status.conflictRecords.length > 0 ? "conflict" : "ready";
        this.hooks.onState?.({
          lastSyncAt: status.lastSyncAt,
          localChanges: status.localChanges,
          conflicts: status.conflicts,
          syncState,
          progress: null,
          errorMessage: null,
        });
      }
    } catch {
      // 사이드바 새로고침은 best-effort — 실패해도 무시.
    }
  }

  /** 진행 중인 UI 트리거 동기화를 취소한다. */
  cancel(): void {
    if (!this.abortController) return;
    this.abortController.abort();
    this.abortController = null;
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

  /** 상태 조회 패스스루(상태 표시 커맨드용 — 표시 포맷은 셸이 담당). */
  getStatus(): ReturnType<SyncOrchestrator["status"]> {
    return this.orchestrator.status();
  }

  /** 충돌 해결 흐름용 무알림 pull — 결과의 conflicts 로 모달을 띄우는 건 셸이 담당. */
  pullForResolve(): ReturnType<SyncOrchestrator["pull"]> {
    return this.orchestrator.pull();
  }
}
