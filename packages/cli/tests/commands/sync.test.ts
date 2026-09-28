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
  moved: 0,
  failed: [],
  duration: 300,
});

/**
 * CLI sync 는 오케스트레이터의 sync 하나만 부른다(F-j). 받기 · 올리기 결과는 위 두 모의가 정한다 —
 * 오케스트레이터에는 pull · push 가 없어, CLI 가 따로 부르면 시험이 깨진다.
 */
const mockSync = vi.fn(async (options: unknown) => {
  const pull = await mockPull(options);
  const push = await mockPush(options);
  return { pull, push, conflicts: pull.conflicts, duration: pull.duration + push.duration };
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
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ sync: mockSync })),
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
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Sync complete"));
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

  it("진행 항목을 받기 ▼ Pull · 올리기 ▲ Push 아래에 가르고, 옮김은 moved 로 보인다", async () => {
    mockSync.mockImplementationOnce(async (options: unknown) => {
      const { onProgress } = options as {
        onProgress: (current: number, total: number, item: object) => void;
      };
      onProgress(1, 1, { path: "Remote.md", operation: "create", direction: "pull" });
      onProgress(1, 2, { path: "B", operation: "move", direction: "push" });
      onProgress(2, 2, { path: "B/x.md", operation: "move", direction: "push" });
      return {
        pull: await mockPull(options),
        push: { created: 0, updated: 0, deleted: 0, moved: 2, failed: [], duration: 10 },
        conflicts: [],
        duration: 20,
      };
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync();
    const lines = spy.mock.calls.map((call) => String(call[0]));
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(at("▼ Pull")).toBeLessThan(at("Remote.md created"));
    expect(at("Remote.md created")).toBeLessThan(at("▲ Push"));
    expect(at("▲ Push")).toBeLessThan(at("B moved"));
    expect(lines.some((line) => line.includes("→ B/x.md moved"))).toBe(true);
    expect(lines.some((line) => line.includes("Push:") && line.includes("2 moved"))).toBe(true);
    spy.mockRestore();
  });

  it("올릴 것이 없어도 ▲ Push 머리글을 한 번 보인다", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync();
    const lines = spy.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("▲ Push"))).toHaveLength(1);
    spy.mockRestore();
  });

  it("받기가 바뀐 것만 찾았으면 원격 삭제가 언제 반영되는지 적는다", async () => {
    mockPull.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [],
      writtenPaths: [],
      failed: [],
      duration: 100,
      imageCount: 0,
      fileCount: 0,
      linkCount: 0,
      remoteScan: {
        kind: "incremental",
        lastFullAt: "2026-09-28T01:05:00.000Z",
        nextFullAt: null,
        deletionsDeferred: true,
        skippedDatabases: 1,
      },
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync();
    const lines = spy.mock.calls.map((call) => String(call[0]));
    spy.mockRestore();
    expect(lines).toContain("  Changes-only scan · 1 unchanged database skipped");
    expect(lines).toContain(
      "  Deletions in Notion apply at the next pull (full scan due) — or run nobsi pull --force",
    );
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
      moved: 0,
      failed: [],
      duration: 100,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1 conflicts"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nobsi resolve"));
    spy.mockRestore();
  });

  it("실패는 받기 ▼ · 올리기 ▲ 로 갈라 보이고, 볼트 최상위는 / 로 보인다", async () => {
    mockPull.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [],
      writtenPaths: [],
      failed: [{ path: "", operation: "update", error: "발견 멈춤" }],
      duration: 100,
      imageCount: 0,
      fileCount: 0,
      linkCount: 0,
    });
    mockPush.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 0,
      moved: 0,
      failed: [{ path: "a.md", operation: "update", error: "timeout" }],
      duration: 100,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSync();
    const lines = spy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("▼ /: ") && line.includes("발견 멈춤"))).toBe(true);
    expect(lines.some((line) => line.includes("▲ a.md: ") && line.includes("timeout"))).toBe(true);
    spy.mockRestore();
    process.exitCode = undefined;
  });
});
