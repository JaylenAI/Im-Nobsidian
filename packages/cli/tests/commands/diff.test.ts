import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

const mockStatus = vi.fn().mockResolvedValue({
  localChanges: [],
  remoteChanges: [],
  conflicts: [],
  conflictRecords: [],
  pendingOperations: 0,
  lastSyncAt: null,
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
  StateDB: {
    open: vi.fn().mockReturnValue({
      getByPath: vi.fn().mockReturnValue(null),
      close: vi.fn(),
    }),
  },
  NotionClient: vi.fn().mockImplementation(() => ({})),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ statusLocal: mockStatus })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({
    readFile: vi.fn().mockResolvedValue("# New\n\nContent"),
  })),
}));

vi.mock("diff", () => ({
  createTwoFilesPatch: vi
    .fn()
    .mockReturnValue("--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,3 @@\n+# New\n+\n+Content\n"),
}));

import { diffCommand } from "../../src/commands/diff.js";

function runDiff(...args: string[]) {
  const program = new Command();
  program.addCommand(diffCommand);
  return program.parseAsync(["node", "cli", "diff", ...args]);
}

describe("diff command", () => {
  it("변경사항 없으면 '변경사항 없음' 출력", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDiff();
    expect(spy).toHaveBeenCalledWith("변경사항 없음");
    spy.mockRestore();
  });

  it("새 파일 diff 출력", async () => {
    mockStatus.mockResolvedValueOnce({
      localChanges: [{ path: "new.md", type: "created", currentHash: "abc", previousHash: null }],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
      lastSyncAt: null,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDiff();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("+++"));
    spy.mockRestore();
  });

  it("경로 필터링", async () => {
    mockStatus.mockResolvedValueOnce({
      localChanges: [
        { path: "notes/a.md", type: "created", currentHash: "a", previousHash: null },
        { path: "other/b.md", type: "created", currentHash: "b", previousHash: null },
      ],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
      lastSyncAt: null,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDiff("notes/");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
