import type { SyncOrchestrator } from "../sync/orchestrator.js";
import type { SyncResult } from "../types/sync.js";
import { FileWatcher } from "./file-watcher.js";
import type { WatchEvent } from "./file-watcher.js";

export interface WatchSyncOptions {
  readonly debounceMs?: number;
  readonly syncDirection?: "push" | "pull" | "both";
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

    this.syncing = true;
    const changedPaths = [...this.pendingChanges.keys()];
    this.pendingChanges.clear();

    try {
      this.options.onSyncStart?.();

      const result = await this.orchestrator.sync({
        paths: changedPaths.length > 0 ? changedPaths : undefined,
      });

      this.options.onSyncComplete?.(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.onSyncError?.(err);
    } finally {
      this.syncing = false;

      if (this.syncQueued) {
        this.syncQueued = false;
        void this.executeSync();
      }
    }
  }
}
