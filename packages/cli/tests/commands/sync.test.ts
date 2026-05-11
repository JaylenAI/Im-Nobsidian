import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

const mockSync = vi.fn().mockResolvedValue({
  pull: {
    created: 1,
    updated: 2,
    deleted: 0,
    conflicts: [],
    writtenPaths: [],
    failed: [],
    duration: 500,
  },
  push: { created: 0, updated: 1, deleted: 0, failed: [], duration: 300 },
  conflicts: [],
  duration: 800,
});

vi.mock("@obsinotion/core", () => ({
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
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ sync: mockSync })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("ora", () => ({
  default: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    text: "",
  }),
}));

import { syncCommand } from "../../src/commands/sync.js";

function runSync(...args: string[]) {
  const program = new Command();
  program.addCommand(syncCommand);
  return program.parseAsync(["node", "cli", "sync", ...args]);
}

describe("sync command", () => {
  it("기본 sync 성공 출력", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync();
    expect(mockSync).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("동기화 완료"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Pull:"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Push:"));
    spy.mockRestore();
  });

  it("dry-run 옵션 전달", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync("--dry-run");
    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    spy.mockRestore();
  });

  it("충돌 발생 시 안내", async () => {
    mockSync.mockResolvedValueOnce({
      pull: {
        created: 0,
        updated: 0,
        deleted: 0,
        conflicts: [],
        writtenPaths: [],
        failed: [],
        duration: 100,
      },
      push: { created: 0, updated: 0, deleted: 0, failed: [], duration: 100 },
      conflicts: [{ syncRecord: {} }],
      duration: 200,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("충돌 1건"));
    spy.mockRestore();
  });
});
