import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

/*
 * resolve 명령은 충돌 목록을 **orchestrator.listConflicts()** 로 얻고(예전엔 목록을 얻겠다고
 * 전체 pull 을 돌렸다 — 해소하기 전에 볼트를 원격으로 덮어쓰는 순서였다), 해소는
 * resolveAllConflicts / resolveConflict 로 라우팅한다(R4/I8). 목이 StateDB.getByStatus 를
 * 흉내 내던 시절 명세는 명령이 바뀐 뒤 죽은 매핑이라, 실제로는 listConflicts 가 없어서 나는
 * TypeError 를 "충돌이 없습니다 미출력"으로 잘못 읽게 만들었다.
 */
const {
  mockListConflicts,
  mockClearStale,
  mockResolveAll,
  mockResolveConflict,
  mockGenerateDiff,
  mockClose,
} = vi.hoisted(() => ({
  mockListConflicts: vi.fn(),
  mockClearStale: vi.fn(),
  mockResolveAll: vi.fn(),
  mockResolveConflict: vi.fn(),
  mockGenerateDiff: vi.fn(),
  mockClose: vi.fn(),
}));

// 무거운 것만 갈아 끼우고 나머지 core export 는 원본을 그대로 편다 — 손으로 나열하면
// 명령이 유틸 하나를 더 가져오는 순간 목 명세만 낡아 거짓 실패가 난다(diff.test.ts 와 동일).
vi.mock("@im-nobsidian/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@im-nobsidian/core")>()),
  ConfigManager: vi.fn().mockImplementation(() => ({
    dbPath: "/mock/sync.db",
    load: vi.fn().mockResolvedValue({
      notion: { token: "ntn_test" },
      paths: {},
      advanced: { concurrency: 3, timeoutMs: 30000 },
    }),
  })),
  StateDB: { open: vi.fn().mockReturnValue({ close: mockClose }) },
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    listConflicts: mockListConflicts,
    clearStaleConflicts: mockClearStale,
    resolveAllConflicts: mockResolveAll,
    resolveConflict: mockResolveConflict,
    generateConflictDiff: mockGenerateDiff,
  })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@inquirer/prompts", () => ({
  select: vi.fn().mockResolvedValue("local"),
  confirm: vi.fn().mockResolvedValue(true),
}));

import { resolveCommand } from "../../src/commands/resolve.js";

/** 충돌 픽스처 — 명령이 읽는 필드(syncRecord.obsidianPath)만 채운다. */
function conflict(path: string) {
  return { syncRecord: { obsidianPath: path } };
}

function runResolve(...args: string[]) {
  const program = new Command();
  program.addCommand(resolveCommand);
  return program.parseAsync(["node", "cli", "resolve", ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListConflicts.mockResolvedValue([]);
  mockClearStale.mockReturnValue([]);
  mockResolveAll.mockResolvedValue([]);
  mockGenerateDiff.mockReturnValue("");
  process.exitCode = undefined;
});

describe("resolve command", () => {
  it("충돌 없으면 '충돌이 없습니다' 출력", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve();
    expect(spy).toHaveBeenCalledWith("충돌이 없습니다.");
    spy.mockRestore();
  });

  it("strategy + --yes 로 일괄 해결", async () => {
    mockListConflicts.mockResolvedValueOnce([conflict("a.md")]);
    mockResolveAll.mockResolvedValueOnce([{ path: "a.md", choice: "local-first", success: true }]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve("--strategy", "local-first", "--yes");
    expect(mockResolveAll).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith("\n충돌 해결 완료 — 1건");
    spy.mockRestore();
  });

  it("충돌 발견 시 건수 출력", async () => {
    mockListConflicts.mockResolvedValueOnce([conflict("a.md"), conflict("b.md")]);
    mockResolveAll.mockResolvedValueOnce([
      { path: "a.md", choice: "local-first", success: true },
      { path: "b.md", choice: "local-first", success: true },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve("--strategy", "local-first", "--yes");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("충돌 2건 발견"));
    spy.mockRestore();
  });

  it("해결 완료 후 DB 닫기", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve();
    expect(mockClose).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ── R4 에서 들어온 동작들 — 여기 잠그지 않으면 다시 조용히 퇴화한다 ──

  it("양쪽이 이미 같아진 충돌은 물어보지 않고 표시만 해제", async () => {
    // 남겨 두면 push 가 그 파일을 영영 건너뛰어(충돌 상태는 push 제외) 편집이 정체한다.
    mockListConflicts.mockResolvedValueOnce([conflict("a.md")]);
    mockClearStale.mockReturnValueOnce(["a.md"]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve();
    expect(mockResolveAll).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1건 모두 이미 해소된 상태"));
    spy.mockRestore();
  });

  it("비대화형에서 --yes 없는 일괄 해결은 거부하고 exitCode 1", async () => {
    // TTY 가 없는 곳(파이프·cron·CI)에서 프롬프트를 띄우면 원인 불명으로 멎는다.
    mockListConflicts.mockResolvedValueOnce([conflict("a.md")]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runResolve("--strategy", "local-first");
    expect(mockResolveAll).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("--yes"));
    expect(process.exitCode).toBe(1);
    log.mockRestore();
    err.mockRestore();
  });

  it("알 수 없는 전략은 실행 전에 거부", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runResolve("--strategy", "no-such-strategy", "--yes");
    expect(mockListConflicts).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    err.mockRestore();
  });

  it("일부 실패하면 '완료'라고 말하지 않고 exitCode 1", async () => {
    mockListConflicts.mockResolvedValueOnce([conflict("a.md"), conflict("b.md")]);
    mockResolveAll.mockResolvedValueOnce([
      { path: "a.md", choice: "local-first", success: true },
      { path: "b.md", choice: "local-first", success: false },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve("--strategy", "local-first", "--yes");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("1건 해결 · 1건 미해결"));
    expect(process.exitCode).toBe(1);
    spy.mockRestore();
  });
});
