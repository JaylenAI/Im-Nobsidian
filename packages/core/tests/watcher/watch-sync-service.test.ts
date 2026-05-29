import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WatchSyncService } from "../../src/watcher/watch-sync-service.js";
import type { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { SyncResult } from "../../src/types/sync.js";

let capturedCallback: ((event: string, path: string) => void) | null = null;
const mockWatcherStart = vi.fn();
const mockWatcherStop = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/watcher/file-watcher.js", () => ({
  FileWatcher: vi
    .fn()
    .mockImplementation((_root: string, cb: (event: string, path: string) => void) => {
      capturedCallback = cb;
      return { start: mockWatcherStart, stop: mockWatcherStop };
    }),
}));

function triggerFileChange(event: string, path: string): void {
  capturedCallback?.(event, path);
}

function createMockOrchestrator(): SyncOrchestrator {
  return {
    sync: vi.fn().mockResolvedValue({
      pull: {
        created: 0,
        updated: 0,
        deleted: 0,
        conflicts: [],
        writtenPaths: [],
        failed: [],
        duration: 100,
      },
      push: { created: 1, updated: 0, deleted: 0, failed: [], duration: 50 },
      conflicts: [],
      duration: 150,
    } satisfies SyncResult),
    push: vi.fn(),
    pull: vi.fn(),
    status: vi.fn(),
  } as unknown as SyncOrchestrator;
}

describe("WatchSyncService", () => {
  let service: WatchSyncService;
  let mockOrchestrator: SyncOrchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedCallback = null;
    mockOrchestrator = createMockOrchestrator();
  });

  afterEach(async () => {
    if (service?.isRunning()) {
      await service.stop();
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("start / stop", () => {
    it("시작 후 running 상태", () => {
      service = new WatchSyncService("/vault", mockOrchestrator);
      service.start();
      expect(service.isRunning()).toBe(true);
      expect(mockWatcherStart).toHaveBeenCalled();
    });

    it("정지 후 not running", async () => {
      service = new WatchSyncService("/vault", mockOrchestrator);
      service.start();
      await service.stop();
      expect(service.isRunning()).toBe(false);
    });

    it("중복 start 무시", () => {
      service = new WatchSyncService("/vault", mockOrchestrator);
      service.start();
      service.start();
      expect(service.isRunning()).toBe(true);
      expect(mockWatcherStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("debounce", () => {
    it("파일 변경 후 debounce 시간 내 sync 미호출", () => {
      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 2000 });
      service.start();

      triggerFileChange("change", "test.md");
      vi.advanceTimersByTime(1000);

      expect(mockOrchestrator.sync).not.toHaveBeenCalled();
    });

    it("debounce 시간 경과 후 sync 호출", async () => {
      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 500 });
      service.start();

      triggerFileChange("change", "test.md");
      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      expect(mockOrchestrator.sync).toHaveBeenCalledTimes(1);
    });

    it("연속 변경은 하나의 sync로 배치", async () => {
      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 500 });
      service.start();

      triggerFileChange("change", "a.md");
      vi.advanceTimersByTime(200);
      triggerFileChange("change", "b.md");
      vi.advanceTimersByTime(200);
      triggerFileChange("add", "c.md");
      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      expect(mockOrchestrator.sync).toHaveBeenCalledTimes(1);
    });

    it("md 파일이 아닌 변경은 무시", () => {
      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 100 });
      service.start();

      triggerFileChange("change", "image.png");
      triggerFileChange("add", "data.json");
      vi.advanceTimersByTime(200);

      expect(mockOrchestrator.sync).not.toHaveBeenCalled();
      expect(service.getPendingCount()).toBe(0);
    });
  });

  describe("callbacks", () => {
    it("onFileChange 호출", () => {
      const onFileChange = vi.fn();
      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 100, onFileChange });
      service.start();

      triggerFileChange("change", "test.md");

      expect(onFileChange).toHaveBeenCalledWith("change", "test.md");
    });

    it("onSyncStart / onSyncComplete 호출", async () => {
      const onSyncStart = vi.fn();
      const onSyncComplete = vi.fn();
      service = new WatchSyncService("/vault", mockOrchestrator, {
        debounceMs: 100,
        onSyncStart,
        onSyncComplete,
      });
      service.start();

      triggerFileChange("change", "test.md");
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onSyncStart).toHaveBeenCalledTimes(1);
      expect(onSyncComplete).toHaveBeenCalledTimes(1);
    });

    it("sync 에러 시 onSyncError 호출", async () => {
      const onSyncError = vi.fn();
      (mockOrchestrator.sync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("network"),
      );

      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 100, onSyncError });
      service.start();

      triggerFileChange("change", "test.md");
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(onSyncError).toHaveBeenCalledWith(expect.objectContaining({ message: "network" }));
    });
  });

  describe("sync 큐잉", () => {
    it("sync 진행 중 추가 변경은 큐에 보관 후 재실행", async () => {
      let resolveSync: (() => void) | null = null;
      (mockOrchestrator.sync as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () =>
          new Promise<SyncResult>((resolve) => {
            resolveSync = () =>
              resolve({
                pull: {
                  created: 0,
                  updated: 0,
                  deleted: 0,
                  conflicts: [],
                  writtenPaths: [],
                  failed: [],
                  duration: 0,
                },
                push: { created: 0, updated: 0, deleted: 0, failed: [], duration: 0 },
                conflicts: [],
                duration: 0,
              });
          }),
      );

      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 100 });
      service.start();

      triggerFileChange("change", "a.md");
      vi.advanceTimersByTime(200);
      await Promise.resolve();

      expect(service.isSyncing()).toBe(true);

      triggerFileChange("change", "b.md");
      vi.advanceTimersByTime(200);

      resolveSync!();
      await vi.runAllTimersAsync();

      expect(mockOrchestrator.sync).toHaveBeenCalledTimes(2);
    });
  });

  describe("pendingCount", () => {
    it("변경 추적 후 sync 완료 시 초기화", async () => {
      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 100 });
      service.start();

      triggerFileChange("change", "a.md");
      triggerFileChange("add", "b.md");
      expect(service.getPendingCount()).toBe(2);

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(service.getPendingCount()).toBe(0);
    });

    it("같은 파일 중복 변경은 1건으로 카운트", () => {
      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 1000 });
      service.start();

      triggerFileChange("change", "test.md");
      triggerFileChange("change", "test.md");
      triggerFileChange("change", "test.md");

      expect(service.getPendingCount()).toBe(1);
    });
  });

  describe("증분 정합성 (Phase 6)", () => {
    it("동기화 실패 시 변경 경로를 잃지 않고 재시도한다", async () => {
      // 1차 실패 → 경로를 큐로 되돌려 재시도. (기존엔 await 전에 clear 해 영구 유실)
      (mockOrchestrator.sync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("network"),
      );

      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 100 });
      service.start();

      triggerFileChange("change", "a.md");
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(mockOrchestrator.sync).toHaveBeenCalledTimes(2);
      expect(mockOrchestrator.sync).toHaveBeenNthCalledWith(1, { paths: ["a.md"] });
      expect(mockOrchestrator.sync).toHaveBeenNthCalledWith(2, { paths: ["a.md"] });
      expect(service.getPendingCount()).toBe(0);
    });

    it("큐 소진 후 stale debounce 타이머가 전체 동기화를 유발하지 않는다", async () => {
      // syncQueued 재실행이 큐를 비운 뒤 남은 stale 타이머가 발화하면, 기존 코드는
      // paths 미지정으로 전체 볼트를 동기화했다. 이제는 빈 큐 가드 + 진입 시 타이머 정리로 방지.
      let resolveFirst: (() => void) | null = null;
      (mockOrchestrator.sync as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () =>
          new Promise<SyncResult>((resolve) => {
            resolveFirst = () =>
              resolve({
                pull: {
                  created: 0,
                  updated: 0,
                  deleted: 0,
                  conflicts: [],
                  writtenPaths: [],
                  failed: [],
                  duration: 0,
                },
                push: { created: 0, updated: 0, deleted: 0, failed: [], duration: 0 },
                conflicts: [],
                duration: 0,
              });
          }),
      );

      service = new WatchSyncService("/vault", mockOrchestrator, { debounceMs: 100 });
      service.start();

      triggerFileChange("change", "a.md");
      vi.advanceTimersByTime(100); // 1차 동기화(a.md) 시작 — pending 비워짐
      await Promise.resolve();
      expect(service.isSyncing()).toBe(true);

      triggerFileChange("change", "b.md"); // 진행 중 변경 → pending={b}, 새 타이머
      vi.advanceTimersByTime(100); // 타이머 발화 → syncQueued=true (타이머 소비)
      triggerFileChange("change", "c.md"); // 또 변경 → pending={b,c}, stale 후보 타이머

      resolveFirst!(); // 1차 완료 → syncQueued 재실행이 b,c 처리 + stale 타이머 정리
      await vi.runAllTimersAsync();

      // 정확히 2회(a / b,c)만, 빈 경로(전체 동기화) 호출 없음
      expect(mockOrchestrator.sync).toHaveBeenCalledTimes(2);
      for (const call of (mockOrchestrator.sync as ReturnType<typeof vi.fn>).mock.calls) {
        const paths = (call[0] as { paths?: string[] } | undefined)?.paths;
        expect(paths && paths.length > 0).toBe(true);
      }
    });
  });
});
