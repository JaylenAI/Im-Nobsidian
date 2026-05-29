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
  imageCount: 0,
  fileCount: 0,
  linkCount: 0,
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
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ pull: mockPull })),
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
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Pull complete"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("3 created"));
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
      imageCount: 0,
      fileCount: 0,
      linkCount: 0,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1 conflicts"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nobsi resolve"));
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
      imageCount: 0,
      fileCount: 0,
      linkCount: 0,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
    spy.mockRestore();
  });

  it("이미지/파일/링크 카운트 출력", async () => {
    mockPull.mockResolvedValueOnce({
      created: 1,
      updated: 0,
      deleted: 0,
      conflicts: [],
      writtenPaths: ["a.md"],
      failed: [],
      duration: 500,
      imageCount: 5,
      fileCount: 2,
      linkCount: 3,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("5 images"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("2 files"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("3 links resolved"));
    spy.mockRestore();
  });
});
