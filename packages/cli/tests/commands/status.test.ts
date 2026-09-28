import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

const { mockStatus, mockGetAll } = vi.hoisted(() => ({
  mockStatus: vi.fn().mockResolvedValue({
    localChanges: [],
    folderMoves: [],
    remoteChanges: [],
    conflicts: [],
    conflictRecords: [],
    pendingOperations: 0,
    lastSyncAt: null,
  }),
  mockGetAll: vi.fn().mockReturnValue([]),
}));

// 무거운 것만 갈아 끼우고 나머지 core export 는 원본을 그대로 편다(resolve.test.ts 와 같다).
vi.mock("@im-nobsidian/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@im-nobsidian/core")>()),
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
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    statusLocal: mockStatus,
    status: mockStatus,
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
      folderMoves: [],
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
      folderMoves: [],
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
      folderMoves: [],
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

  it("옮긴 폴더 · 노트와 지운 노트를 경로로 보이고, 옮긴 노트는 synced 로 세지 않는다", async () => {
    mockGetAll.mockReturnValueOnce([
      { obsidianPath: "A/x.md", status: "synced" },
      { obsidianPath: "gone.md", status: "synced" },
      { obsidianPath: "keep.md", status: "synced" },
    ]);
    mockStatus.mockResolvedValueOnce({
      localChanges: [
        { path: "B/x.md", type: "moved", movedFrom: "A/x.md", currentHash: "a", previousHash: "a" },
        { path: "gone.md", type: "deleted", currentHash: "", previousHash: "b" },
      ],
      folderMoves: [{ from: "A", to: "B" }],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
      lastSyncAt: null,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus();
    const lines = spy.mock.calls.map(([line]) => String(line));
    spy.mockRestore();

    expect(lines).toContainEqual(expect.stringMatching(/synced\s+1$/));
    expect(lines).toContainEqual(expect.stringMatching(/moved\s+1$/));
    expect(lines).toContainEqual(expect.stringContaining("A/ → B/ (folder)"));
    expect(lines).toContainEqual(expect.stringContaining("A/x.md → B/x.md"));
    expect(lines).toContainEqual(expect.stringContaining("Deleted files:"));
    expect(lines).toContainEqual(expect.stringMatching(/- gone\.md$/));
    expect(lines).not.toContainEqual(expect.stringContaining("Everything up to date"));
    expect(lines).toContainEqual(expect.stringContaining("nobsi discard <path>"));
  });

  it("폴더 이동만 있어도 변경으로 본다", async () => {
    mockStatus.mockResolvedValueOnce({
      localChanges: [],
      folderMoves: [{ from: "Tasks", to: "Work/Tasks" }],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
      lastSyncAt: null,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus();
    const lines = spy.mock.calls.map(([line]) => String(line));
    spy.mockRestore();

    expect(lines).toContainEqual(expect.stringContaining("Tasks/ → Work/Tasks/ (folder)"));
    expect(lines).not.toContainEqual(expect.stringContaining("Everything up to date"));
    // 옮김은 discard 로 되돌리지 않는다 — 안내하지 않는다.
    expect(lines).not.toContainEqual(expect.stringContaining("nobsi discard"));
  });

  it("--full 의 원격 변경은 노트 경로나 Notion 제목으로 보이고, 옮김은 따로 센다", async () => {
    mockStatus.mockResolvedValueOnce({
      localChanges: [],
      folderMoves: [],
      remoteChanges: [
        {
          pageId: "11111111-aaaa",
          type: "modified",
          path: "notes/a.md",
          lastEdited: "",
          previousEdited: null,
        },
        {
          pageId: "22222222-bbbb",
          type: "created",
          title: "Fresh",
          lastEdited: "",
          previousEdited: null,
        },
        {
          pageId: "33333333-cccc",
          type: "moved",
          path: "b.md",
          lastEdited: "",
          previousEdited: null,
        },
        { pageId: "44444444-dddd", type: "deleted", lastEdited: "", previousEdited: null },
      ],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
      lastSyncAt: null,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus("--full");
    const lines = spy.mock.calls.map(([line]) => String(line));
    spy.mockRestore();

    expect(lines).toContainEqual(expect.stringMatching(/~ notes\/a\.md \(modified\)$/));
    expect(lines).toContainEqual(expect.stringMatching(/\+ Fresh \(new page\) \(created\)$/));
    expect(lines).toContainEqual(expect.stringMatching(/→ b\.md \(moved\)$/));
    expect(lines).toContainEqual(expect.stringMatching(/moved\s+1$/));
    // 경로도 제목도 없을 때만 내부 id 를 줄여 보인다.
    expect(lines).toContainEqual(expect.stringMatching(/- 44444444\.\.\. \(deleted\)$/));
    expect(lines.join("\n")).not.toContain("11111111");
  });

  it("--full 은 Notion 에서 지운 노트의 충돌을 따로 적는다", async () => {
    mockStatus.mockResolvedValueOnce({
      localChanges: [],
      folderMoves: [],
      remoteChanges: [],
      conflicts: [
        { syncRecord: { obsidianPath: "gone.md" }, remoteChange: { type: "deleted" } },
        { syncRecord: { obsidianPath: "both.md" }, remoteChange: { type: "modified" } },
      ],
      conflictRecords: [{ obsidianPath: "gone.md" }, { obsidianPath: "both.md" }],
      pendingOperations: 2,
      lastSyncAt: null,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStatus("--full");
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/gone\.md.*\(deleted in Notion, local edits not pushed\)/),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/both\.md.*\(both sides changed\)/));
    spy.mockRestore();
  });
});
