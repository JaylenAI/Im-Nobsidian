import type { SyncOrchestrator } from "../sync/orchestrator.js";
import type { SyncResult } from "../types/sync.js";
import { FileWatcher } from "./file-watcher.js";
import type { WatchEvent } from "./file-watcher.js";

export interface WatchSyncOptions {
  readonly debounceMs?: number;
  readonly onSyncStart?: () => void;
  readonly onSyncComplete?: (result: SyncResult) => void;
  readonly onSyncError?: (error: Error) => void;
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
  private running = false;

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

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.clearDebounce();
    this.pendingChanges.clear();

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
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
    if (!path.endsWith(".md")) return;

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
    if (this.pendingChanges.size === 0) return;

    this.syncing = true;
    // 처리 대상을 스냅샷으로 떠 두고 큐를 비운다. 실패 시 되돌릴 수 있도록 이벤트까지 보존.
    const batch = new Map(this.pendingChanges);
    this.pendingChanges.clear();

    try {
      this.options.onSyncStart?.();

      const result = await this.orchestrator.sync({ paths: [...batch.keys()] });

      this.options.onSyncComplete?.(result);
    } catch (error) {
      // 동기화 실패 시 처리하던 경로를 큐로 되돌려 다음 트리거에서 재시도한다. 단,
      // 동기화 도중 같은 경로에 더 최신 이벤트가 들어왔다면 그것을 덮어쓰지 않는다.
      for (const [path, event] of batch) {
        if (!this.pendingChanges.has(path)) this.pendingChanges.set(path, event);
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.onSyncError?.(err);
    } finally {
      this.syncing = false;

      if (this.syncQueued) {
        this.syncQueued = false;
        void this.executeSync();
      } else if (this.pendingChanges.size > 0) {
        // 동기화 중 새로 들어왔거나 실패로 되돌린 경로가 있으면 재동기화를 예약한다.
        this.scheduleSync();
      }
    }
  }
}
