import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const { mockStatus, mockLocalDiff, mockRemoteSnapshot, mockReadFile } = vi.hoisted(() => ({
  mockStatus: vi.fn(),
  mockLocalDiff: vi.fn(),
  mockRemoteSnapshot: vi.fn(),
  mockReadFile: vi.fn(),
}));

/*
 * 무거운 것(설정 로드·DB·Notion 클라이언트·오케스트레이터)만 갈아 끼우고 **나머지는 원본을
 * 그대로 편다**. 예전엔 팩토리에 필요한 심볼을 손으로 나열했는데, 명령이 core 에서 순수
 * 유틸을 하나 더 가져오는 순간(`matchesPathScope`) 목에 없다는 이유로 테스트가 죽었다 —
 * 프로덕션 코드는 멀쩡한데 목 명세만 낡아서 나는 거짓 실패다. 줄 비교(`diff`)도 실제 것을 쓴다.
 */
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
  StateDB: { open: vi.fn().mockReturnValue({ close: vi.fn() }) },
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    statusLocal: mockStatus,
    localChangeDiff: mockLocalDiff,
    renderRemoteSnapshot: mockRemoteSnapshot,
  })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({ readFile: mockReadFile })),
}));

import { diffCommand } from "../../src/commands/diff.js";

function runDiff(...args: string[]) {
  const program = new Command();
  program.addCommand(diffCommand);
  return program.parseAsync(["node", "cli", "diff", ...args]);
}

type Change = { path: string; type: string; movedFrom?: string };

function withChanges(...localChanges: Change[]): void {
  mockStatus.mockResolvedValue({
    localChanges: localChanges.map((c) => ({ currentHash: "h", previousHash: "p", ...c })),
    folderMoves: [],
    remoteChanges: [],
    conflicts: [],
    conflictRecords: [],
    pendingOperations: 0,
    lastSyncAt: null,
  });
}

describe("diff command", () => {
  let lines: string[];
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    withChanges();
    lines = [];
    // 색 코드를 벗겨 글만 본다.
    log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      // eslint-disable-next-line no-control-regex
      lines.push(String(line).replace(/\x1b\[[0-9;]*m/g, ""));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    log.mockRestore();
    process.exitCode = undefined;
  });

  it("변경사항 없으면 '변경사항 없음' 출력", async () => {
    await runDiff();
    expect(lines).toEqual(["변경사항 없음"]);
  });

  it("새 노트는 모든 줄을 더한 줄로 보인다", async () => {
    withChanges({ path: "new.md", type: "created" });
    mockLocalDiff.mockResolvedValue({
      path: "new.md",
      type: "created",
      before: null,
      after: "# New\n\nContent\n",
    });

    await runDiff();

    expect(lines).toEqual(
      expect.arrayContaining(["--- /dev/null", "+++ b/new.md", "+# New", "+", "+Content"]),
    );
  });

  it("고친 노트는 지난 동기화 때의 글과 지금 글의 차이를 보인다", async () => {
    withChanges({ path: "a.md", type: "modified" });
    mockLocalDiff.mockResolvedValue({
      path: "a.md",
      type: "modified",
      before: "같음\n옛 줄\n",
      after: "같음\n새 줄\n",
    });

    await runDiff();

    expect(lines).toEqual(
      expect.arrayContaining(["--- a/a.md", "+++ b/a.md", " 같음", "-옛 줄", "+새 줄"]),
    );
  });

  it("플러그인 변경 패널과 같은 비교 — 바뀐 줄 앞뒤로 같은 줄을 세 줄씩 보인다", async () => {
    const before = Array.from({ length: 11 }, (_, i) => `줄${i + 1}\n`).join("");
    withChanges({ path: "a.md", type: "modified" });
    mockLocalDiff.mockResolvedValue({
      path: "a.md",
      type: "modified",
      before,
      after: before.replace("줄6\n", "고침\n"),
    });

    await runDiff();

    expect(lines).toEqual([
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -3,7 +3,7 @@",
      " 줄3",
      " 줄4",
      " 줄5",
      "-줄6",
      "+고침",
      " 줄7",
      " 줄8",
      " 줄9",
      "",
    ]);
  });

  it("옮긴 노트는 옛 자리 · 새 자리를 적고, 내용이 같으면 비교 대신 그렇다고 알린다", async () => {
    withChanges({ path: "Moved/a.md", type: "moved", movedFrom: "a.md" });
    mockLocalDiff.mockResolvedValue({
      path: "Moved/a.md",
      type: "moved",
      movedFrom: "a.md",
      before: "본문\n",
      after: "본문\n",
    });

    await runDiff();

    expect(lines).toEqual([
      "rename from a.md",
      "rename to Moved/a.md",
      "(내용은 그대로입니다 — 자리만 옮겼습니다)",
      "",
    ]);
  });

  it("옮기며 고친 노트는 옛 자리의 글과 새 자리의 글을 견준다", async () => {
    withChanges({ path: "Moved/a.md", type: "moved", movedFrom: "a.md" });
    mockLocalDiff.mockResolvedValue({
      path: "Moved/a.md",
      type: "moved",
      movedFrom: "a.md",
      before: "옛 본문\n",
      after: "새 본문\n",
    });

    await runDiff();

    expect(lines).toEqual(
      expect.arrayContaining([
        "rename from a.md",
        "rename to Moved/a.md",
        "--- a/a.md",
        "+++ b/Moved/a.md",
        "-옛 본문",
        "+새 본문",
      ]),
    );
  });

  it("지운 노트는 모든 줄을 지운 줄로 보인다", async () => {
    withChanges({ path: "gone.md", type: "deleted" });
    mockLocalDiff.mockResolvedValue({
      path: "gone.md",
      type: "deleted",
      before: "지울 글\n",
      after: null,
    });

    await runDiff();

    expect(lines).toEqual(expect.arrayContaining(["--- a/gone.md", "+++ /dev/null", "-지울 글"]));
  });

  it("비교하지 못한 노트는 이유를 보이고 나머지는 보인 뒤 실패로 끝낸다", async () => {
    withChanges({ path: "a.md", type: "modified" }, { path: "b.md", type: "created" });
    mockLocalDiff
      .mockRejectedValueOnce(new Error("지난 동기화 사본이 없어 비교할 수 없습니다 — a.md"))
      .mockResolvedValueOnce({ path: "b.md", type: "created", before: null, after: "새 글\n" });

    await runDiff();

    expect(lines.slice(0, 2)).toEqual([
      "--- a/a.md",
      "(지난 동기화 사본이 없어 비교할 수 없습니다 — a.md)",
    ]);
    expect(lines).toContain("+새 글");
    expect(process.exitCode).toBe(1);
  });

  it("경로를 주면 그 아래의 변경만 보인다", async () => {
    withChanges({ path: "notes/a.md", type: "created" }, { path: "other/b.md", type: "created" });
    mockLocalDiff.mockImplementation(async (change: Change) => ({
      ...change,
      before: null,
      after: "글\n",
    }));

    await runDiff("notes/");

    expect(mockLocalDiff.mock.calls.map(([change]) => (change as Change).path)).toEqual([
      "notes/a.md",
    ]);
  });

  it("--remote: 옮긴 노트는 옛 자리의 Notion 글과 견준다 — 기록이 아직 옛 자리에 있다", async () => {
    withChanges({ path: "Moved/a.md", type: "moved", movedFrom: "a.md" });
    mockRemoteSnapshot.mockImplementation(async (path: string) =>
      path === "a.md" ? "Notion 글\n" : null,
    );
    mockReadFile.mockResolvedValue("로컬 글\n");

    await runDiff("--remote");

    expect(mockRemoteSnapshot.mock.calls).toEqual([["Moved/a.md"], ["a.md"]]);
    expect(lines).toEqual([
      "--- notion/a.md",
      "+++ b/Moved/a.md",
      "@@ -1,1 +1,1 @@",
      "-Notion 글",
      "+로컬 글",
      "",
    ]);
    expect(mockLocalDiff).not.toHaveBeenCalled();
  });

  it("--remote: Notion 과 같으면 이름 줄 뒤에 같다고 알린다", async () => {
    withChanges({ path: "Moved/a.md", type: "moved", movedFrom: "a.md" });
    mockRemoteSnapshot.mockImplementation(async (path: string) =>
      path === "a.md" ? "같은 글\n" : null,
    );
    mockReadFile.mockResolvedValue("같은 글\n");

    await runDiff("--remote");

    expect(lines).toEqual([
      "--- notion/a.md",
      "+++ b/Moved/a.md",
      "(Notion 과 내용이 같습니다)",
      "",
    ]);
  });
});
