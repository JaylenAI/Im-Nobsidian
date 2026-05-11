import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

const { mockPull, mockStatus, mockGetByStatus, mockResolveAll, mockClose } = vi.hoisted(() => ({
  mockPull: vi.fn().mockResolvedValue({
    created: 0,
    updated: 0,
    deleted: 0,
    conflicts: [],
    writtenPaths: [],
    failed: [],
    duration: 100,
  }),
  mockStatus: vi.fn().mockResolvedValue({
    localChanges: [],
    remoteChanges: [],
    conflicts: [],
    conflictRecords: [],
    pendingOperations: 0,
    lastSyncAt: null,
  }),
  mockGetByStatus: vi.fn().mockReturnValue([]),
  mockResolveAll: vi.fn().mockResolvedValue([]),
  mockClose: vi.fn(),
}));

vi.mock("@obsinotion/core", () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    dbPath: "/mock/sync.db",
    load: vi.fn().mockResolvedValue({
      notion: { token: "ntn_test" },
      paths: {},
      advanced: { concurrency: 3, timeoutMs: 30000 },
    }),
  })),
  StateDB: {
    open: vi.fn().mockReturnValue({
      getByStatus: mockGetByStatus,
      close: mockClose,
    }),
  },
  NotionClient: vi.fn().mockImplementation(() => ({})),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    pull: mockPull,
    status: mockStatus,
  })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
  ConflictResolver: vi.fn().mockImplementation(() => ({
    resolveAll: mockResolveAll,
  })),
}));

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn().mockResolvedValue("local"),
  confirm: vi.fn().mockResolvedValue(true),
}));

import { resolveCommand } from "../../src/commands/resolve.js";

function runResolve(...args: string[]) {
  const program = new Command();
  program.addCommand(resolveCommand);
  return program.parseAsync(["node", "cli", "resolve", ...args]);
}

describe("resolve command", () => {
  it("충돌 없으면 '충돌이 없습니다' 출력", async () => {
    mockGetByStatus.mockReturnValueOnce([]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve();
    expect(spy).toHaveBeenCalledWith("충돌이 없습니다.");
    spy.mockRestore();
  });

  it("strategy 옵션으로 일괄 해결", async () => {
    mockGetByStatus.mockReturnValueOnce([{ obsidianPath: "a.md", status: "conflict" }]);
    mockResolveAll.mockResolvedValueOnce([{ path: "a.md", choice: "local-first", success: true }]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve("--strategy", "local-first");
    expect(mockResolveAll).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith("\n충돌 해결 완료");
    spy.mockRestore();
  });

  it("충돌 발견 시 건수 출력", async () => {
    mockGetByStatus.mockReturnValueOnce([
      { obsidianPath: "a.md", status: "conflict" },
      { obsidianPath: "b.md", status: "conflict" },
    ]);
    mockResolveAll.mockResolvedValueOnce([
      { path: "a.md", choice: "local-first", success: true },
      { path: "b.md", choice: "local-first", success: true },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve("--strategy", "local-first");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("충돌 2건 발견"));
    spy.mockRestore();
  });

  it("해결 완료 후 DB 닫기", async () => {
    mockGetByStatus.mockReturnValueOnce([]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve();
    expect(mockClose).toHaveBeenCalled();
    spy.mockRestore();
  });
});
