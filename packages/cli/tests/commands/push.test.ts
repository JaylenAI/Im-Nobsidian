import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

const mockPush = vi.fn().mockResolvedValue({
  created: 2,
  updated: 1,
  deleted: 0,
  failed: [],
  duration: 1500,
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
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ push: mockPush })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("ora", () => ({
  default: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    text: "",
  }),
}));

import { pushCommand } from "../../src/commands/push.js";

function runPush(...args: string[]) {
  const program = new Command();
  program.addCommand(pushCommand);
  return program.parseAsync(["node", "cli", "push", ...args]);
}

describe("push command", () => {
  it("기본 push 성공 출력", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPush();
    expect(mockPush).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Push 완료"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("생성: 2"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("수정: 1"));
    spy.mockRestore();
  });

  it("dry-run 옵션 전달", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPush("--dry-run");
    expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    spy.mockRestore();
  });

  it("path 필터 옵션 전달", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPush("-p", "notes/");
    expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ paths: ["notes/"] }));
    spy.mockRestore();
  });

  it("삭제 건수 출력", async () => {
    mockPush.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 3,
      failed: [],
      duration: 200,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPush();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("삭제: 3"));
    spy.mockRestore();
  });

  it("실패 항목 출력", async () => {
    mockPush.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      deleted: 0,
      failed: [{ path: "broken.md", operation: "create", error: "API error" }],
      duration: 500,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPush();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("실패: 1"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("API error"));
    spy.mockRestore();
  });
});
