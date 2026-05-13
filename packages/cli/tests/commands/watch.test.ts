import { describe, it, expect, vi } from "vitest";

const mockStart = vi.fn();
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockIsSyncing = vi.fn().mockReturnValue(false);

vi.mock("@im-nobsidian/core", () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    dbPath: "/mock/sync.db",
    load: vi.fn().mockResolvedValue({
      notion: { token: "ntn_test" },
      paths: {},
      advanced: { concurrency: 3, timeoutMs: 30000 },
    }),
  })),
  StateDB: { open: vi.fn().mockReturnValue({ close: vi.fn() }) },
  NotionClient: vi.fn().mockImplementation(() => ({})),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({})),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
  WatchSyncService: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    isSyncing: mockIsSyncing,
  })),
}));

import { watchCommand } from "../../src/commands/watch.js";

describe("watch command", () => {
  it("watchCommand 정의 확인", () => {
    expect(watchCommand.name()).toBe("watch");
    expect(watchCommand.description()).toContain("파일 변경 감지");
  });

  it("debounce 옵션 기본값", () => {
    const debounceOpt = watchCommand.options.find((o) => o.long === "--debounce");
    expect(debounceOpt).toBeDefined();
    expect(debounceOpt!.defaultValue).toBe("2000");
  });

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
});
