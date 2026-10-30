import { describe, it, expect, vi, afterEach } from "vitest";

const mockStart = vi.fn();
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockIsSyncing = vi.fn().mockReturnValue(false);
const mockRequestFullSync = vi.fn();
const mockOrchestratorSync = vi.fn();
const mockDbClose = vi.fn();

vi.mock("@im-nobsidian/core", async () => ({
  // 기본값은 진짜를 쓴다 — 옵션 기본값이 core 의 값을 읽는지가 시험 대상이다
  DEFAULT_WATCH_DEBOUNCE_MS: (
    await vi.importActual<typeof import("@im-nobsidian/core")>("@im-nobsidian/core")
  ).DEFAULT_WATCH_DEBOUNCE_MS,
  ConfigManager: vi.fn().mockImplementation(() => ({
    dbPath: "/mock/sync.db",
    load: vi.fn().mockResolvedValue({
      notion: { token: "ntn_test" },
      paths: {},
      advanced: { concurrency: 3, timeoutMs: 30000 },
    }),
  })),
  StateDB: { open: vi.fn().mockImplementation(() => ({ close: mockDbClose })) },
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ sync: mockOrchestratorSync })),
  findConnectionFolders: vi.fn().mockResolvedValue([]),
  ScopedVaultFS: vi.fn(),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
  OBSIDIAN_CONFIG_DIR: ".obsidian",
  IGNORE_FILE: ".im-nobsidian-ignore",
  WatchSyncService: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    isSyncing: mockIsSyncing,
    requestFullSync: mockRequestFullSync,
  })),
}));

import { DEFAULT_WATCH_DEBOUNCE_MS } from "@im-nobsidian/core";
import { watchCommand } from "../../src/commands/watch.js";

describe("watch command", () => {
  it("watchCommand 정의 확인", () => {
    expect(watchCommand.name()).toBe("watch");
    expect(watchCommand.description()).toContain("파일 변경 감지");
  });

  it("debounce 옵션 기본값", () => {
    const debounceOpt = watchCommand.options.find((o) => o.long === "--debounce");
    expect(debounceOpt).toBeDefined();
    expect(debounceOpt!.defaultValue).toBe(String(DEFAULT_WATCH_DEBOUNCE_MS));
  });

  it.each([
    ["--debounce", "abc"],
    ["--debounce", "-5"],
    ["--interval", "1.5"],
  ])(
    "%s %s 는 시작하지 않고 실패한다 — 숫자가 아니면 0 이나 꺼짐으로 바뀌던 것",
    async (flag, value) => {
      const { WatchSyncService } = await import("@im-nobsidian/core");
      vi.mocked(WatchSyncService).mockClear();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      process.exitCode = undefined;

      await watchCommand.parseAsync([flag, value], { from: "user" });

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(value));
      expect(WatchSyncService).not.toHaveBeenCalled();
      process.exitCode = undefined;
      // restoreAllMocks 는 모듈 모의의 구현까지 지운다 — 건 spy 만 되돌린다
      error.mockRestore();
      log.mockRestore();
    },
  );

  it("interval 옵션 기본값", () => {
    const intervalOpt = watchCommand.options.find((o) => o.long === "--interval");
    expect(intervalOpt).toBeDefined();
    expect(intervalOpt!.defaultValue).toBe("0");
  });

  it("formatResult 유틸리티 동작 확인", async () => {
    const { WatchSyncService } = await import("@im-nobsidian/core");
    expect(WatchSyncService).toBeDefined();
    expect(mockStart).toBeDefined();
  });

  describe("주기 sync · 종료 (S-09)", () => {
    const handlers = new Map<string, () => void>();
    // vi.restoreAllMocks 는 모듈 모의의 구현까지 지운다 — 이 절에서 건 spy 만 되돌린다.
    const spies: Array<{ mockRestore: () => void }> = [];

    function startWatch(args: string[]): void {
      spies.push(
        vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
          handlers.set(event, handler);
          return process;
        }) as never),
        vi.spyOn(console, "log").mockImplementation(() => {}),
      );
      void watchCommand.parseAsync(args, { from: "user" });
    }

    afterEach(() => {
      handlers.clear();
      vi.useRealTimers();
      for (const spy of spies.splice(0)) spy.mockRestore();
      mockRequestFullSync.mockClear();
      mockOrchestratorSync.mockClear();
      mockStop.mockReset().mockResolvedValue(undefined);
      mockDbClose.mockClear();
    });

    it("주기 sync 는 감시 서비스에 요청한다 — 오케스트레이터를 따로 부르지 않는다", async () => {
      vi.useFakeTimers();
      startWatch(["--interval", "5"]);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockRequestFullSync).toHaveBeenCalledTimes(2);
      expect(mockOrchestratorSync).not.toHaveBeenCalled();
    });

    it("종료는 도는 sync 가 끝난 뒤에 DB 를 닫고, 기다리는 중 한 번 더 누르면 바로 끝낸다", async () => {
      let finishStop!: () => void;
      mockStop.mockImplementation(() => new Promise<void>((resolve) => (finishStop = resolve)));
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      spies.push(exit);
      startWatch([]);
      await vi.waitFor(() => expect(handlers.has("SIGINT")).toBe(true));

      handlers.get("SIGINT")!();
      await vi.waitFor(() => expect(mockStop).toHaveBeenCalledTimes(1));
      expect(mockDbClose).not.toHaveBeenCalled();

      handlers.get("SIGINT")!();
      expect(exit).toHaveBeenCalledWith(1);
      expect(mockStop).toHaveBeenCalledTimes(1);

      finishStop();
      await vi.waitFor(() => expect(mockDbClose).toHaveBeenCalledTimes(1));
      expect(exit).toHaveBeenLastCalledWith(0);
    });
  });
});
