import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

// resolve 명령은 충돌 해소를 SyncOrchestrator.resolveAllConflicts / resolveConflict 로
// 라우팅한다(rank1/I8 — 해소 후 Notion 재push·notionLastEdited 재조정까지 봉합). 따라서
// 목은 ConflictResolver 가 아니라 orchestrator 의 해소 메서드를 제공해야 실제 명령 경로와
// 일치한다. (옛 ConflictResolver.resolveAll 목은 명령 변경 후 죽은 매핑이었다.)
const { mockPull, mockStatus, mockGetByStatus, mockResolveAll, mockResolveConflict, mockClose } =
  vi.hoisted(() => ({
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
    mockResolveConflict: vi
      .fn()
      .mockResolvedValue({ path: "a.md", choice: "local", success: true }),
    mockClose: vi.fn(),
  }));

vi.mock("@im-nobsidian/core", () => ({
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
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    pull: mockPull,
    status: mockStatus,
    resolveAllConflicts: mockResolveAll,
    resolveConflict: mockResolveConflict,
    generateConflictDiff: vi.fn().mockReturnValue(""),
  })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
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
