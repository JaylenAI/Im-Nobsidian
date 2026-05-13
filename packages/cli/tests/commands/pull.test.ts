import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

const mockPull = vi.fn().mockResolvedValue({
  created: 3,
  updated: 1,
  deleted: 0,
  conflicts: [],
  writtenPaths: ["a.md", "b.md", "c.md", "d.md"],
  failed: [],
  duration: 2000,
});

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
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ pull: mockPull })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("ora", () => ({
  default: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    text: "",
  }),
}));

import { pullCommand } from "../../src/commands/pull.js";

function runPull(...args: string[]) {
  const program = new Command();
  program.addCommand(pullCommand);
  return program.parseAsync(["node", "cli", "pull", ...args]);
}

describe("pull command", () => {
  it("기본 pull 성공 출력", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPull();
    expect(mockPull).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Pull 완료"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("생성: 3"));
    spy.mockRestore();
  });

  it("dry-run 옵션 전달", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPull("--dry-run");
    expect(mockPull).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    spy.mockRestore();
  });

  it("충돌 발생 시 안내 메시지", async () => {
    mockPull.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [{ syncRecord: {}, localChange: {}, remoteChange: {} }],
      writtenPaths: [],
      failed: [],
      duration: 100,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("충돌: 1"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("resolve"));
    spy.mockRestore();
  });

  it("실패 항목 출력", async () => {
    mockPull.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [],
      writtenPaths: [],
      failed: [{ path: "bad.md", operation: "create", error: "timeout" }],
      duration: 100,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("실패: 1"));
    spy.mockRestore();
  });
});
