import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

const { mockStatus, mockGetAll } = vi.hoisted(() => ({
  mockStatus: vi.fn().mockResolvedValue({
    localChanges: [],
    remoteChanges: [],
    conflicts: [],
    conflictRecords: [],
    pendingOperations: 0,
    lastSyncAt: null,
  }),
  mockGetAll: vi.fn().mockReturnValue([]),
}));

vi.mock("@im-nobsidian/core", () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    dbPath: "/mock/sync.db",
    load: vi.fn().mockResolvedValue({
      notion: { token: "ntn_test", rootPageId: "abcd1234-5678-90ef-ghij-klmnopqrstuv" },
      paths: {},
      sync: { direction: "both" },
      advanced: { concurrency: 3 },
    }),
  })),
  StateDB: { open: vi.fn().mockReturnValue({ close: vi.fn(), getAll: mockGetAll }) },
  NotionClient: vi.fn().mockImplementation(() => ({})),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ status: mockStatus })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("chalk", () => {
  const passthrough = (s: string) => s;
  const fn = Object.assign(passthrough, {
    green: passthrough,
    yellow: passthrough,
    red: passthrough,
    blue: passthrough,
    cyan: passthrough,
    magenta: passthrough,
    dim: passthrough,
    bold: passthrough,
  });
  return { default: fn };
});

import { statusCommand } from "../../src/commands/status.js";

function runStatus(...args: string[]) {
  const program = new Command();
  program.addCommand(statusCommand);
  return program.parseAsync(["node", "cli", "status", ...args]);
}

describe("status command", () => {
  it("동기화 이력 없을 때 출력", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Sync Status"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("never"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Everything up to date"));
    spy.mockRestore();
  });

  it("마지막 동기화 시간 표시", async () => {
    mockStatus.mockResolvedValueOnce({
      localChanges: [],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
      lastSyncAt: "2026-05-10T12:00:00.000Z",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Last sync:"));
    spy.mockRestore();
  });

  it("변경사항 표시", async () => {
    mockStatus.mockResolvedValueOnce({
      localChanges: [
        { path: "new.md", type: "created", currentHash: "a", previousHash: null },
        { path: "mod.md", type: "modified", currentHash: "b", previousHash: "c" },
        { path: "del.md", type: "deleted", currentHash: "d", previousHash: "e" },
      ],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
      lastSyncAt: null,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("modified"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("new"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("mod.md"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("new.md"));
    spy.mockRestore();
  });

  it("충돌 표시", async () => {
    mockStatus.mockResolvedValueOnce({
      localChanges: [],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [{ obsidianPath: "conflict.md" }],
      pendingOperations: 1,
      lastSyncAt: null,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("conflict"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("conflict.md"));
    spy.mockRestore();
  });
});
