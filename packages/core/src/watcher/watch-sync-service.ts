import type { SyncOrchestrator } from "../sync/orchestrator.js";
import type { SyncResult } from "../types/sync.js";
import { FileWatcher } from "./file-watcher.js";
import type { WatchEvent } from "./file-watcher.js";

/** 한 번의 sync 가 무엇을 보나 — 바뀐 파일만(파일 변경) · 볼트 전체(주기 sync). */
export type WatchSyncScope = "changes" | "full";

export interface WatchSyncOptions {
  readonly debounceMs?: number;
  readonly onSyncStart?: (scope: WatchSyncScope) => void;
  readonly onSyncComplete?: (result: SyncResult, scope: WatchSyncScope) => void;
  /** 감시를 멈춰 도중에 취소한 sync — `result` 는 그때까지 처리한 것이다. */
  readonly onSyncCancelled?: (result: SyncResult, scope: WatchSyncScope) => void;
  readonly onSyncError?: (error: Error, scope: WatchSyncScope) => void;
  readonly onFileChange?: (event: WatchEvent, path: string) => void;
}

const DEFAULT_DEBOUNCE_MS = 2000;

export class WatchSyncService {
  private readonly debounceMs: number;
  private readonly options: WatchSyncOptions;
  private watcher: FileWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges: Map<string, WatchEvent> = new Map();
  private syncing = false;
  private syncQueued = false;
  private fullSyncQueued = false;
  private running = false;
  // 도는 sync — 멈출 때 취소하고 끝나기를 기다린다(부른 쪽이 그 뒤에 상태 DB 를 닫는다).
  private inFlight: { controller: AbortController; done: Promise<void> } | null = null;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly rootPath: string,
    private readonly orchestrator: SyncOrchestrator,
    options: WatchSyncOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.options = options;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.watcher = new FileWatcher(this.rootPath, (event, path) => {
      this.handleFileChange(event, path);
    });
    this.watcher.start();
  }

  /**
   * 감시를 멈춘다. 도는 sync 는 취소하고 끝나기를 기다린다 — 예전에는 기다리지 않아, 부른 쪽이
   * sync 도중에 상태 DB 를 닫았다(S-09).
   */
  async stop(): Promise<void> {
    // 멈추는 중에 다시 부르면 같은 것을 기다린다 — 먼저 끝났다고 알리면 부른 쪽이 DB 를 닫는다.
    if (this.stopping) return this.stopping;
    if (!this.running) return;

    this.stopping = this.halt();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  private async halt(): Promise<void> {
    this.running = false;
    this.clearDebounce();
    this.pendingChanges.clear();
    this.fullSyncQueued = false;
    this.syncQueued = false;

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }

    const inFlight = this.inFlight;
    if (inFlight) {
      inFlight.controller.abort();
      await inFlight.done;
    }
  }

  /**
   * 볼트 전체 sync 를 요청한다 — CLI `watch --interval` 의 주기 sync(S-09).
   *
   * 파일 변경 sync 와 같은 줄에 선다. 예전에는 주기 sync 가 이 서비스 밖에서 오케스트레이터를
   * 불러, 도는 중에 들어온 파일 변경 sync · 다음 주기 sync 와 겹쳤다. 도는 sync 가 있으면 끝난 뒤
   * 한 번만 돈다 — 요청이 쌓여도 한 번이다.
   */
  requestFullSync(): void {
    if (!this.running) return;
    this.fullSyncQueued = true;
    void this.executeSync();
  }

  isRunning(): boolean {
    return this.running;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  getPendingCount(): number {
    return this.pendingChanges.size;
  }

  private handleFileChange(event: WatchEvent, path: string): void {
    // 감시를 멈추는 동안(파일 감시를 닫는 사이)에 온 이벤트는 받지 않는다 — 멈춘 뒤에 sync 가 돈다.
    if (!this.running || !path.endsWith(".md")) return;

    this.pendingChanges.set(path, event);
    this.options.onFileChange?.(event, path);
    this.scheduleSync();
  }

  private scheduleSync(): void {
    this.clearDebounce();

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.executeSync();
    }, this.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async executeSync(): Promise<void> {
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }

    // 동기화를 시작하므로 대기 중인 debounce 타이머를 정리한다. 이 타이머가
    // pendingChanges 가 비워진 뒤 뒤늦게 발화하면 아래 가드에 걸려 무시되지만,
    // 미리 취소해 불필요한 재진입 자체를 없앤다.
    this.clearDebounce();

    // 누적된 변경이 없으면 아무것도 하지 않는다. 실제 파일 변경 기반 동기화는 항상
    // 경로를 동반하므로, 빈 상태로 진입했다는 것은 stale 타이머·중복 트리거라는 뜻이다.
    // 이때 sync() 를 경로 없이 호출하면 의도치 않은 전체 볼트 동기화가 된다.
    // 볼트 전체는 주기 sync 가 요청했을 때만 본다(requestFullSync).
    const scope: WatchSyncScope = this.fullSyncQueued ? "full" : "changes";
    if (scope === "changes" && this.pendingChanges.size === 0) return;

    this.syncing = true;
    this.fullSyncQueued = false;
    // 처리 대상을 스냅샷으로 떠 두고 큐를 비운다. 실패 시 되돌릴 수 있도록 이벤트까지 보존.
    // 볼트 전체 sync 는 쌓인 경로도 함께 본다.
    const batch = new Map(this.pendingChanges);
    this.pendingChanges.clear();
    const controller = new AbortController();
    const done = this.runBatch(scope, batch, controller.signal);
    this.inFlight = { controller, done };
    await done;
    this.inFlight = null;
    this.syncing = false;

    // 멈춘 뒤에는 큐가 비어 다시 돌지 않는다(stop · 실패 경로 복원이 멈춤을 본다).
    if (this.syncQueued) {
      this.syncQueued = false;
      void this.executeSync();
    } else if (this.pendingChanges.size > 0) {
      // 동기화 중 새로 들어왔거나 실패로 되돌린 경로가 있으면 재동기화를 예약한다.
      this.scheduleSync();
    }
  }

  private async runBatch(
    scope: WatchSyncScope,
    batch: ReadonlyMap<string, WatchEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.options.onSyncStart?.(scope);

      const result = await this.orchestrator.sync(
        scope === "full" ? { signal } : { paths: [...batch.keys()], signal },
      );

      // 취소된 sync 는 도중에 멈춘 것이다 — 완료로 알리지 않는다.
      if (signal.aborted) this.options.onSyncCancelled?.(result, scope);
      else this.options.onSyncComplete?.(result, scope);
    } catch (error) {
      // 동기화 실패 시 처리하던 경로를 큐로 되돌려 다음 트리거에서 재시도한다. 단,
      // 동기화 도중 같은 경로에 더 최신 이벤트가 들어왔다면 그것을 덮어쓰지 않는다.
      if (this.running) {
        for (const [path, event] of batch) {
          if (!this.pendingChanges.has(path)) this.pendingChanges.set(path, event);
        }
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.onSyncError?.(err, scope);
    }
  }
}
