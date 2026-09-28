import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const pullResult = {
  created: 0,
  updated: 0,
  deleted: 0,
  restored: 2,
  conflicts: [],
  writtenPaths: ["a.md", "b.md"],
  failed: [],
  duration: 1200,
  imageCount: 0,
  fileCount: 0,
  linkCount: 1,
};
const pushResult = { created: 0, updated: 3, deleted: 0, moved: 0, failed: [], duration: 800 };

const mockPull = vi.fn();
const mockPush = vi.fn();
const mockSetLogger = vi.fn();

vi.mock("@im-nobsidian/core", () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    dbPath: "/mock/sync.db",
    load: vi.fn().mockResolvedValue({ notion: { token: "ntn_test" }, paths: {}, advanced: {} }),
  })),
  StateDB: { open: vi.fn().mockReturnValue({ close: vi.fn() }) },
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    pull: mockPull,
    push: mockPush,
    // CLI sync 는 오케스트레이터의 sync 하나를 부른다(F-j) — 결과는 위 두 모의가 정한다.
    sync: async (options: unknown) => {
      const pull = await mockPull(options);
      const push = await mockPush(options);
      return { pull, push, conflicts: pull.conflicts, duration: pull.duration + push.duration };
    },
  })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
  setLogger: (...args: unknown[]) => mockSetLogger(...args),
}));

import { pullCommand } from "../../src/commands/pull.js";
import { pushCommand } from "../../src/commands/push.js";
import { syncCommand } from "../../src/commands/sync.js";

function run(command: Command, name: string, ...args: string[]) {
  const program = new Command();
  program.addCommand(command);
  return program.parseAsync(["node", "cli", name, ...args]);
}

/** stdout 에 쓴 것 전부를 모아 JSON 한 줄로 해석한다 — 여러 줄이면 계약 위반이다. */
function stdoutJson(write: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const text = write.mock.calls.map((c) => String(c[0])).join("");
  const lines = text.split("\n").filter((l) => l.length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("--json 출력 계약", () => {
  let write: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockPull.mockResolvedValue(pullResult);
    mockPush.mockResolvedValue(pushResult);
    mockSetLogger.mockClear();
    process.exitCode = undefined;
    write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    write.mockRestore();
    log.mockRestore();
    process.exitCode = undefined;
  });

  it("pull: 복원도 churn 에 센다 — 사람용 요약은 복원을 따로 적어 grep 이 놓쳤다", async () => {
    await run(pullCommand, "pull", "--json");
    const out = stdoutJson(write);
    expect(out).toMatchObject({ restored: 2, churn: 2, conflicts: 0, links: 1, durationMs: 1200 });
    expect(log).not.toHaveBeenCalled();
    expect(mockSetLogger).toHaveBeenCalledTimes(1);
    expect(mockPull).toHaveBeenCalledWith(expect.objectContaining({ onProgress: undefined }));
  });

  it("push --dry-run: churn 은 생성·수정·삭제·옮김의 합", async () => {
    mockPush.mockResolvedValueOnce({ ...pushResult, created: 1, deleted: 1, moved: 2 });
    await run(pushCommand, "push", "--dry-run", "--json");
    expect(stdoutJson(write)).toMatchObject({
      created: 1,
      updated: 3,
      deleted: 1,
      moved: 2,
      churn: 7,
    });
    expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(log).not.toHaveBeenCalled();
  });

  it("sync: Pull 이 무변경이어도 Push 변경을 churn 으로 센다", async () => {
    mockPull.mockResolvedValueOnce({ ...pullResult, restored: 0, writtenPaths: [] });
    await run(syncCommand, "sync", "--json");
    const out = stdoutJson(write) as { pull: { churn: number }; push: { churn: number } };
    expect(out.pull.churn).toBe(0);
    expect(out.push.churn).toBe(3);
    expect(out).toMatchObject({ churn: 3, conflicts: 0, durationMs: 2000 });
    expect(log).not.toHaveBeenCalled();
  });

  it("실패가 있으면 JSON 을 쓰고 종료 코드를 1 로 남긴다", async () => {
    mockPush.mockResolvedValueOnce({
      ...pushResult,
      failed: [{ path: "x.md", operation: "update", error: "boom" }],
    });
    await run(pushCommand, "push", "--json");
    expect(stdoutJson(write)).toMatchObject({ failed: [{ path: "x.md", error: "boom" }] });
    expect(process.exitCode).toBe(1);
  });

  it("--json 이 없으면 로거를 바꾸지 않는다", async () => {
    await run(pullCommand, "pull");
    expect(mockSetLogger).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});
