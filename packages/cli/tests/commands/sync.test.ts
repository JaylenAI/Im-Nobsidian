import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

const mockPull = vi.fn().mockResolvedValue({
  created: 1,
  updated: 2,
  deleted: 0,
  conflicts: [],
  writtenPaths: [],
  failed: [],
  duration: 500,
  imageCount: 0,
  fileCount: 0,
  linkCount: 0,
});

const mockPush = vi.fn().mockResolvedValue({
  created: 0,
  updated: 1,
  deleted: 0,
  failed: [],
  duration: 300,
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
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    pull: mockPull,
    push: mockPush,
  })),
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
    expect(mockPull).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Sync complete"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Pull:"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Push:"));
    spy.mockRestore();
  });

  it("dry-run 옵션 전달", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync("--dry-run");
    expect(mockPull).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    spy.mockRestore();
  });

  it("충돌 발생 시 안내", async () => {
    mockPull.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [{ syncRecord: {} }],
      writtenPaths: [],
      failed: [],
      duration: 100,
      imageCount: 0,
      fileCount: 0,
      linkCount: 0,
    });
    mockPush.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 0,
      failed: [],
      duration: 100,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1 conflicts"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nobsi resolve"));
    spy.mockRestore();
  });
});
