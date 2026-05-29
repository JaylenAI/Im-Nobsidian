import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";
import { sep } from "node:path";
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
      // 이벤트 경로를 rootPath 기준 "볼트 상대경로"로 방출한다. 동기화 엔진의 변경
      // 감지·paths 필터는 모두 볼트 상대경로(listMarkdownFileStats 기준)를 쓰므로,
      // 절대경로를 그대로 넘기면 push 의 startsWith 스코프 필터에서 누락돼 변경 파일이
      // 실제로 동기화되지 않는다(증분 watch 의 핵심 버그).
      cwd: this.rootPath,
      ignored: [/(^|[/\\])\./, "**/node_modules/**", INTERNAL_DIR_GLOB],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (path) => this.callback("add", this.toVaultPath(path)));
    this.watcher.on("change", (path) => this.callback("change", this.toVaultPath(path)));
    this.watcher.on("unlink", (path) => this.callback("unlink", this.toVaultPath(path)));
  }

  // 볼트 경로는 항상 "/" 구분자를 사용한다. Windows 백슬래시를 정규화.
  private toVaultPath(path: string): string {
    return sep === "/" ? path : path.split(sep).join("/");
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
