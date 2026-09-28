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

import { select } from "@inquirer/prompts";
import { SavedStateDbError, StateDB } from "@im-nobsidian/core";
import { resolveCommand } from "../../src/commands/resolve.js";

/** 충돌 픽스처 — 명령이 읽는 필드(경로 · 원격 변경 종류)만 채운다. */
function conflict(path: string, remote: "modified" | "deleted" = "modified") {
  return { syncRecord: { obsidianPath: path }, remoteChange: { type: remote } };
}

/** 대화형 해결은 TTY 에서만 뜬다 — 이 시험 동안만 TTY 로 보이게 한다. */
function asTerminal(): () => void {
  const saved = [process.stdin.isTTY, process.stdout.isTTY];
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  return () => {
    Object.defineProperty(process.stdin, "isTTY", { value: saved[0], configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: saved[1], configurable: true });
  };
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

  it("상태 DB 파일이 깨져 열지 못하면 이유와 치우는 법을 보이고 exitCode 1", async () => {
    vi.mocked(StateDB.open).mockImplementationOnce(() => {
      throw SavedStateDbError.noTables(0);
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runResolve();

    expect(spy).toHaveBeenCalledWith(
      "오류:",
      "저장된 상태 DB 파일에 동기화 기록이 없음 (0바이트) — 볼트 폴더의 .im-nobsidian/sync.db 를 사본으로 " +
        "바꾸거나 다른 곳으로 옮긴 뒤 명령을 다시 실행하세요. 옮기면 처음부터 시작합니다 — 노트와 Notion " +
        "페이지의 짝을 잃어 다음 push 가 페이지를 새로 만듭니다.",
    );
    expect(process.exitCode).toBe(1);
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

  it("일괄 해결에서 못 푼 것은 이유와 함께 보이고 나머지는 푼 것으로 센다 · exitCode 1", async () => {
    mockListConflicts.mockResolvedValueOnce([conflict("a.md"), conflict("b.md")]);
    mockResolveAll.mockResolvedValueOnce([
      { path: "a.md", choice: "local", success: false, error: "Notion 502 bad gateway" },
      { path: "b.md", choice: "local", success: true },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve("--strategy", "local-first", "--yes");
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/a\.md → .* — Notion 502 bad gateway$/));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("충돌 1건 해결 · 1건 미해결"));
    expect(process.exitCode).toBe(1);
    spy.mockRestore();
    process.exitCode = undefined;
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

  // ── D: Notion 에서 지운 노트 — 합칠 원격이 없어 고를 수 있는 것이 다르다 ──

  it("원격 삭제 충돌은 로컬 유지(다시 만들기) · 삭제 따르기 둘만 묻고 줄 비교를 보이지 않는다", async () => {
    const restore = asTerminal();
    mockListConflicts.mockResolvedValueOnce([conflict("gone.md", "deleted")]);
    mockResolveConflict.mockResolvedValueOnce({ path: "gone.md", choice: "local", success: true });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runResolve();
    } finally {
      restore();
    }
    const { choices } = vi.mocked(select).mock.calls[0]![0] as {
      choices: Array<{ name: string; value: string }>;
    };
    expect(choices).toEqual([
      { name: "로컬 유지 (Notion 에 새 페이지로 다시 만들기)", value: "local" },
      { name: "삭제 따르기 (Obsidian 파일도 지우기)", value: "remote" },
    ]);
    expect(mockGenerateDiff).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Notion 에서 삭제된 노트입니다"));
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("gone.md → 로컬 유지 (Notion 에 새 페이지로 다시 만들기)"),
    );
    spy.mockRestore();
  });

  it("양쪽을 고친 충돌은 네 가지를 묻는다", async () => {
    const restore = asTerminal();
    mockListConflicts.mockResolvedValueOnce([conflict("both.md")]);
    mockResolveConflict.mockResolvedValueOnce({ path: "both.md", choice: "local", success: true });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runResolve();
    } finally {
      restore();
    }
    const { choices } = vi.mocked(select).mock.calls[0]![0] as {
      choices: Array<{ value: string }>;
    };
    expect(choices.map((c) => c.value)).toEqual(["local", "remote", "merge", "duplicate"]);
    expect(mockGenerateDiff).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("충돌 비교는 이름 줄 · 묶음 머리 · 로컬 줄 · 원격 줄을 색으로 가른다 — 구분선을 지운 줄도 지운 줄이다", async () => {
    const restore = asTerminal();
    mockListConflicts.mockResolvedValueOnce([conflict("both.md")]);
    mockResolveConflict.mockResolvedValueOnce({ path: "both.md", choice: "local", success: true });
    mockGenerateDiff.mockReturnValueOnce(
      [
        "--- local: both.md",
        "+++ remote: Notion (p)",
        "@@ -1,3 +1,2 @@",
        " 같음",
        "----",
        "-로컬",
        "+원격",
      ].join("\n"),
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runResolve();
    } finally {
      restore();
    }
    const printed = spy.mock.calls.map(([line]) => line);
    expect(printed).toEqual(
      expect.arrayContaining([
        "\x1b[1m--- local: both.md\x1b[0m",
        "\x1b[1m+++ remote: Notion (p)\x1b[0m",
        "\x1b[36m@@ -1,3 +1,2 @@\x1b[0m",
        " 같음",
        "\x1b[31m----\x1b[0m",
        "\x1b[31m-로컬\x1b[0m",
        "\x1b[32m+원격\x1b[0m",
      ]),
    );
    spy.mockRestore();
  });

  it("일괄 remote-first 는 원격 삭제 노트의 파일을 지운다고 먼저 알린다", async () => {
    mockListConflicts.mockResolvedValueOnce([conflict("gone.md", "deleted"), conflict("b.md")]);
    mockResolveAll.mockResolvedValueOnce([
      { path: "gone.md", choice: "remote", success: true },
      { path: "b.md", choice: "remote", success: true },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runResolve("--strategy", "remote-first", "--yes");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Notion 에서 삭제된 노트 1건 — Obsidian 파일도 지웁니다"),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("gone.md → 삭제 따르기"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("b.md → 원격 유지"));
    spy.mockRestore();
  });
});
