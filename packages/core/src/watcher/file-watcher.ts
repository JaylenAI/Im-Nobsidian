import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";
import { INTERNAL_DIR_GLOB } from "../constants/paths.js";

export type WatchEvent = "add" | "change" | "unlink";

export interface WatchCallback {
  (event: WatchEvent, path: string): void;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly rootPath: string,
    private readonly callback: WatchCallback,
  ) {}

  start(): void {
    this.watcher = watch(this.rootPath, {
      ignored: [/(^|[/\\])\./, "**/node_modules/**", INTERNAL_DIR_GLOB],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (path) => this.callback("add", path));
    this.watcher.on("change", (path) => this.callback("change", path));
    this.watcher.on("unlink", (path) => this.callback("unlink", path));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
