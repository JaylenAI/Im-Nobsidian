import { getLogger } from "@im-nobsidian/core";
import type {
  SyncOrchestrator,
  ProgressCallback,
  LocalChange,
  RemoteChange,
  Conflict,
  RenameKind,
  ResolutionChoice,
} from "@im-nobsidian/core";
import { RESOLUTION_CHOICES } from "../conflict-choices.js";

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
/** 알림이 사용자가 읽고 고칠 것을 담을 때 — 기본보다 오래 둔다. */
const ACTIONABLE_NOTICE_MS = 8000;

export class SyncController {
  private abortController: AbortController | null = null;
  private vaultSyncing = false;
  private resolving = false;

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
    // 충돌을 푸는 동안에는 끼어들지 않는다 — 병합 결과를 쓴 파일이 이 동기화를 부른다.
    if (this.vaultSyncing || this.resolving) return;
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

  /** 상태 조회 패스스루(상태 표시 커맨드용 — 표시 포맷은 셸이 담당). */
  getStatus(): ReturnType<SyncOrchestrator["status"]> {
    return this.orchestrator.status();
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
   * @param choose 충돌 하나를 무엇으로 풀지 묻는다(모달). 고르지 않으면 null — 그 충돌은 남는다.
   */
  async resolveConflicts(
    choose: (conflict: Conflict) => Promise<ResolutionChoice | null>,
  ): Promise<void> {
    if (this.isSyncing() || this.vaultSyncing || this.resolving) {
      this.hooks.onNotice?.("Im-Nobsidian: 동기화가 끝난 뒤 충돌을 해결하세요.");
      return;
    }
    this.resolving = true;
    try {
      await this.resolveEach(choose);
    } finally {
      this.resolving = false;
    }
    await this.refreshStatus();
  }

  private async resolveEach(
    choose: (conflict: Conflict) => Promise<ResolutionChoice | null>,
  ): Promise<void> {
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
      const choice = await choose(conflict);
      if (!choice) {
        remaining++;
        continue;
      }
      try {
        const result = await this.orchestrator.resolveConflict(conflict, choice);
        if (result.success) {
          resolved++;
          this.hooks.onNotice?.(`Im-Nobsidian: ${path} → ${RESOLUTION_CHOICES[choice].label}`);
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
          `Im-Nobsidian: 충돌을 해결하지 못함 (${path}) — ${errorMessage(error)}. 충돌로 남겨 두었습니다.`,
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
