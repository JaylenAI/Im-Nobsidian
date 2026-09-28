import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getLogger,
  setLogger,
  SyncBusyError,
  type Conflict,
  type ResolutionChoice,
  type SyncOrchestrator,
  type SyncRecord,
} from "@im-nobsidian/core";
import { SyncController } from "../../src/sync/sync-controller.js";
import type { SyncControllerHooks } from "../../src/sync/sync-controller.js";

interface MockOrchestrator {
  push: ReturnType<typeof vi.fn>;
  pull: ReturnType<typeof vi.fn>;
  sync: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  statusLocal: ReturnType<typeof vi.fn>;
  recordLocalRename: ReturnType<typeof vi.fn>;
  recordLocalDelete: ReturnType<typeof vi.fn>;
  listConflicts: ReturnType<typeof vi.fn>;
  clearStaleConflicts: ReturnType<typeof vi.fn>;
  resolveConflict: ReturnType<typeof vi.fn>;
  discardLocalChange: ReturnType<typeof vi.fn>;
  localChangeDiff: ReturnType<typeof vi.fn>;
  remoteChangeDiff: ReturnType<typeof vi.fn>;
}

function createMockOrchestrator(): MockOrchestrator {
  return {
    push: vi
      .fn()
      .mockResolvedValue({ created: 0, updated: 0, deleted: 0, moved: 0, failed: [], duration: 0 }),
    pull: vi.fn().mockResolvedValue({
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [],
      writtenPaths: [],
      failed: [],
      duration: 0,
    }),
    sync: vi.fn().mockResolvedValue({
      pull: { created: 0, updated: 0, deleted: 0 },
      push: { created: 0, updated: 0, deleted: 0, moved: 0 },
      conflicts: [],
      duration: 0,
    }),
    status: vi.fn().mockResolvedValue({
      lastSyncAt: null,
      localChanges: [],
      folderMoves: [],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
    }),
    discardLocalChange: vi.fn().mockResolvedValue(undefined),
    localChangeDiff: vi.fn(),
    remoteChangeDiff: vi.fn(),
    statusLocal: vi.fn().mockResolvedValue({
      lastSyncAt: null,
      localChanges: [],
      folderMoves: [],
      conflicts: [],
      conflictRecords: [],
    }),
    recordLocalRename: vi.fn(),
    recordLocalDelete: vi.fn(),
    listConflicts: vi.fn().mockResolvedValue([]),
    clearStaleConflicts: vi.fn(() => []),
    resolveConflict: vi.fn(async (conflict: Conflict, choice: ResolutionChoice) => ({
      path: conflict.syncRecord.obsidianPath,
      choice,
      success: true,
    })),
  };
}

/** 충돌 하나 — 컨트롤러는 경로와 원격 변경 종류만 본다. */
function conflictAt(path: string, remote: "modified" | "deleted" = "modified"): Conflict {
  return { syncRecord: { obsidianPath: path }, remoteChange: { type: remote } } as Conflict;
}

/** 상태 DB 의 충돌 기록 — 패널은 id 와 경로만 본다. */
function conflictRecord(path: string): SyncRecord {
  return { id: `record:${path}`, obsidianPath: path } as SyncRecord;
}

/** 로컬 새로고침(`statusLocal`)이 읽을 상태 DB — 충돌로 남은 노트를 준다. 원격을 읽지 않아 `conflicts` 는 늘 비었다. */
function localStatus(conflictPaths: string[] = [], overrides: Record<string, unknown> = {}) {
  return {
    lastSyncAt: null,
    localChanges: [],
    folderMoves: [],
    remoteChanges: [],
    conflicts: [],
    conflictRecords: conflictPaths.map(conflictRecord),
    pendingOperations: conflictPaths.length,
    ...overrides,
  };
}

function createHooks(): {
  hooks: Required<SyncControllerHooks>;
  onState: ReturnType<typeof vi.fn>;
  onNotice: ReturnType<typeof vi.fn>;
  onStatusBar: ReturnType<typeof vi.fn>;
} {
  const onState = vi.fn();
  const onNotice = vi.fn();
  const onStatusBar = vi.fn();
  return { hooks: { onState, onNotice, onStatusBar }, onState, onNotice, onStatusBar };
}

function makeController(mock: MockOrchestrator, hooks: SyncControllerHooks): SyncController {
  return new SyncController(mock as unknown as SyncOrchestrator, hooks);
}

describe("SyncController", () => {
  let mock: MockOrchestrator;

  beforeEach(() => {
    mock = createMockOrchestrator();
  });

  describe("push", () => {
    it("성공 시 시작·완료 상태와 요약 알림을 방출하고 상태를 새로고침한다", async () => {
      mock.push.mockResolvedValue({
        created: 1,
        updated: 2,
        deleted: 0,
        failed: [],
        duration: 1500,
      });
      const { hooks, onState, onNotice, onStatusBar } = createHooks();
      const controller = makeController(mock, hooks);

      await controller.push();

      // 시작: 상태바 syncing + operationType push
      expect(onStatusBar).toHaveBeenNthCalledWith(1, "syncing");
      expect(onState).toHaveBeenCalledWith(
        expect.objectContaining({ syncState: "syncing", operationType: "push" }),
      );
      expect(onNotice).toHaveBeenCalledWith("Im-Nobsidian: Push 시작...");
      // 완료: 요약 + ready
      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: Push 완료 — 생성 1 / 수정 2 / 삭제 0 (1.5s)",
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
      expect(onState).toHaveBeenCalledWith(
        expect.objectContaining({
          completionSummary: "Push 완료 — 생성 1 / 수정 2 / 삭제 0",
          operationType: null,
        }),
      );
      // 완료 후 로컬 상태 새로고침
      expect(mock.statusLocal).toHaveBeenCalledTimes(1);
      expect(controller.isSyncing()).toBe(false);
    });

    it("실패 건수를 요약에 포함한다", async () => {
      mock.push.mockResolvedValue({
        created: 0,
        updated: 0,
        deleted: 0,
        failed: [{ path: "a.md" }, { path: "b.md" }],
        duration: 0,
      });
      const { hooks, onNotice } = createHooks();
      await makeController(mock, hooks).push();

      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: Push 완료 — 생성 0 / 수정 0 / 삭제 0 / 실패 2 (0.0s)",
      );
    });

    it("옮긴 노트 · 폴더는 수정과 따로 「이동」 으로 요약한다", async () => {
      mock.push.mockResolvedValue({
        created: 0,
        updated: 1,
        deleted: 0,
        moved: 3,
        failed: [],
        duration: 0,
      });
      mock.sync.mockResolvedValue({
        pull: { created: 0, updated: 0, deleted: 0 },
        push: { created: 0, updated: 0, deleted: 0, moved: 2 },
        conflicts: [],
        duration: 0,
      });
      const { hooks, onNotice } = createHooks();
      const controller = makeController(mock, hooks);
      await controller.push();
      await controller.sync();

      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: Push 완료 — 생성 0 / 수정 1 / 삭제 0 / 이동 3 (0.0s)",
      );
      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: Sync 완료 — Pull(+0 ~0 -0) Push(+0 ~0 -0 →2) (0.0s)",
      );
    });

    it("진행률 콜백은 syncing 상태와 진행도를 방출한다", async () => {
      const { hooks, onState } = createHooks();
      await makeController(mock, hooks).push();

      const onProgress = mock.push.mock.calls[0]![0].onProgress as (
        c: number,
        t: number,
        i: { path: string },
      ) => void;
      onProgress(5, 10, { path: "note.md" });

      expect(onState).toHaveBeenCalledWith({
        syncState: "syncing",
        progress: { current: 5, total: 10, currentPath: "note.md" },
      });
    });

    it("실패 시 error 상태와 메시지를 방출한다", async () => {
      mock.push.mockRejectedValue(new Error("network down"));
      const { hooks, onNotice, onStatusBar, onState } = createHooks();
      const controller = makeController(mock, hooks);

      await controller.push();

      expect(onNotice).toHaveBeenCalledWith("Im-Nobsidian Push 실패: network down");
      expect(onStatusBar).toHaveBeenLastCalledWith("error");
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncState: "error", errorMessage: "network down" }),
      );
      expect(controller.isSyncing()).toBe(false);
    });
  });

  describe("pull", () => {
    it("충돌이 있으면 conflict 상태와 충돌 건수를 요약에 포함한다", async () => {
      mock.pull.mockResolvedValue({
        created: 1,
        updated: 0,
        deleted: 0,
        conflicts: [{ path: "x.md" }],
        writtenPaths: [],
        failed: [],
        duration: 2000,
      });
      mock.statusLocal.mockResolvedValue(localStatus(["x.md"]));
      const { hooks, onNotice, onStatusBar, onState } = createHooks();
      await makeController(mock, hooks).pull();

      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: Pull 완료 — 생성 1 / 수정 0 / 삭제 0 / 충돌 1 (2.0s)",
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          syncState: "conflict",
          conflictRecords: [conflictRecord("x.md")],
        }),
      );
    });

    it("끝난 뒤 로컬 새로고침이 실패해도 「동기화 중」 에 남지 않는다 — 작업이 정한 단계에 선다", async () => {
      mock.pull.mockResolvedValue({
        created: 0,
        updated: 0,
        deleted: 0,
        conflicts: [{ path: "x.md" }],
        writtenPaths: [],
        failed: [],
        duration: 0,
      });
      mock.statusLocal.mockRejectedValue(new Error("vault read failed"));
      const { hooks, onStatusBar, onState } = createHooks();
      await makeController(mock, hooks).pull();

      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncState: "conflict", operationType: null, progress: null }),
      );
    });
  });

  describe("sync", () => {
    it("Pull/Push 양방향 요약을 방출한다", async () => {
      mock.sync.mockResolvedValue({
        pull: { created: 2, updated: 1, deleted: 0 },
        push: { created: 3, updated: 0, deleted: 1 },
        conflicts: [],
        duration: 3000,
      });
      const { hooks, onNotice } = createHooks();
      await makeController(mock, hooks).sync();

      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: Sync 완료 — Pull(+2 ~1 -0) Push(+3 ~0 -1) (3.0s)",
      );
    });
  });

  describe("변경 패널 항목별 동작", () => {
    it("항목 올리기는 그 노트만 push 한다", async () => {
      const { hooks } = createHooks();
      await makeController(mock, hooks).push(["a/노트.md"]);
      expect(mock.push).toHaveBeenCalledWith(expect.objectContaining({ paths: ["a/노트.md"] }));
    });

    it("되돌리기는 그 노트를 되돌리고 로컬 변경을 새로고친다", async () => {
      const { hooks, onNotice } = createHooks();
      await makeController(mock, hooks).discard("노트.md");
      expect(mock.discardLocalChange).toHaveBeenCalledWith("노트.md");
      expect(mock.statusLocal).toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("노트.md"));
    });

    it("되돌리지 못하면 이유를 알린다", async () => {
      mock.discardLocalChange.mockRejectedValueOnce(
        new Error("추적하지 않는 새 노트라 되돌릴 원본이 없습니다"),
      );
      const { hooks, onState, onNotice } = createHooks();
      await makeController(mock, hooks).discard("새.md");
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("추적하지 않는 새 노트"));
      expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ syncState: "error" }));
    });

    it("항목 받기는 그 노트만 pull 한다 — 전체 받기는 범위를 싣지 않는다", async () => {
      const { hooks } = createHooks();
      const controller = makeController(mock, hooks);
      await controller.pull(["a/노트.md"]);
      await controller.pull();
      expect(mock.pull.mock.calls[0][0]).toMatchObject({ paths: ["a/노트.md"] });
      expect(mock.pull.mock.calls[1][0]).not.toHaveProperty("paths");
    });
  });

  describe("받은 원격 변경은 목록에서 빠진다", () => {
    const edited = {
      pageId: "3e813b18-d382-8127-a761-c5dc986d858a",
      type: "modified",
      path: "a/가.md",
    };
    const other = { pageId: "p-b", type: "modified", path: "나.md" };
    const fresh = { pageId: "p-c", type: "created", title: "Notion 새 페이지" };

    function pulled(overrides: Record<string, unknown> = {}) {
      return {
        created: 0,
        updated: 0,
        deleted: 0,
        restored: 0,
        conflicts: [],
        writtenPaths: [],
        failed: [],
        duration: 0,
        imageCount: 0,
        fileCount: 0,
        linkCount: 0,
        ...overrides,
      };
    }

    /** 원격까지 확인해 세 변경을 목록에 올린 컨트롤러. */
    async function checked() {
      mock.status.mockResolvedValue({
        lastSyncAt: null,
        localChanges: [],
        remoteChanges: [edited, other, fresh],
        conflicts: [],
        conflictRecords: [],
        pendingOperations: 0,
      });
      const { hooks, onState } = createHooks();
      const controller = makeController(mock, hooks);
      await controller.refreshStatus(true);
      onState.mockClear();
      const shown = () =>
        onState.mock.calls
          .map(([patch]) => patch)
          .filter((patch) => "remoteChanges" in patch)
          .at(-1)?.remoteChanges;
      return { controller, shown };
    }

    it("항목 받기는 그 노트만 뺀다 — 이어 받으면 남은 목록에서 이어 뺀다", async () => {
      const { controller, shown } = await checked();
      mock.pull.mockResolvedValue(pulled({ updated: 1 }));
      await controller.pull(["a/가.md"]);
      expect(shown()).toEqual([other, fresh]);
      await controller.pull(["나.md"]);
      expect(shown()).toEqual([fresh]);
    });

    it("전체 받기는 모두 뺀다", async () => {
      const { controller, shown } = await checked();
      mock.pull.mockResolvedValue(pulled({ created: 1, updated: 2 }));
      await controller.pull();
      expect(shown()).toEqual([]);
    });

    it("받지 못한 노트는 남긴다 — 실패가 있으면 어느 새 페이지가 실패했는지 몰라 새 페이지도 남긴다", async () => {
      const { controller, shown } = await checked();
      mock.pull.mockResolvedValue(
        pulled({ failed: [{ path: "나.md", operation: "update", error: "429" }] }),
      );
      await controller.pull();
      expect(shown()).toEqual([other, fresh]);
    });

    it("충돌한 노트는 남긴다 — id 를 쓰는 모양이 달라도 같은 페이지로 본다", async () => {
      const { controller, shown } = await checked();
      mock.pull.mockResolvedValue(
        pulled({
          conflicts: [{ remoteChange: { pageId: "3e813b18d3828127a761c5dc986d858a" } }],
        }),
      );
      await controller.pull();
      expect(shown()).toEqual([edited]);
    });

    it("취소한 pull 은 무엇을 받았는지 몰라 목록을 그대로 둔다", async () => {
      const { controller, shown } = await checked();
      mock.pull.mockImplementation(async () => {
        controller.cancel();
        return pulled({ updated: 1 });
      });
      await controller.pull();
      expect(shown()).toBeUndefined();
    });

    it("Sync · 볼트 이벤트 sync 도 받은 것을 뺀다", async () => {
      const sync = { push: pulled(), pull: pulled({ updated: 1 }), conflicts: [], duration: 0 };
      mock.sync.mockResolvedValue(sync);

      const user = await checked();
      await user.controller.sync();
      expect(user.shown()).toEqual([]);

      const vault = await checked();
      await vault.controller.vaultSync();
      expect(vault.shown()).toEqual([]);
    });
  });

  describe("vaultSync", () => {
    it("알림 · 진행 표시 없이 돌고, 끝나면 패널의 목록을 새로고친다 — 올린 노트가 변경으로 남지 않는다", async () => {
      let pushed = false;
      mock.sync.mockImplementation(async () => {
        pushed = true;
        return {
          pull: { created: 0, updated: 0, deleted: 0 },
          push: { created: 0, updated: 1, deleted: 0 },
          conflicts: [],
          duration: 0,
        };
      });
      mock.statusLocal.mockImplementation(async () =>
        localStatus([], {
          lastSyncAt: pushed ? "2026-09-28T05:00:00Z" : null,
          localChanges: pushed ? [] : [{ path: "a.md", type: "modified" }],
        }),
      );
      const { hooks, onState, onNotice, onStatusBar } = createHooks();
      await makeController(mock, hooks).vaultSync();

      expect(mock.sync).toHaveBeenCalledTimes(1);
      expect(onStatusBar).toHaveBeenNthCalledWith(1, "syncing");
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
      // 도는 동안 패널을 「동기화 중」 으로 바꾸지 않는다 — 끝난 뒤 새로고침 한 번뿐이다
      expect(onState).toHaveBeenCalledTimes(1);
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          lastSyncAt: "2026-09-28T05:00:00Z",
          localChanges: [],
          syncState: "ready",
        }),
      );
      expect(onNotice).not.toHaveBeenCalled();
    });

    it("자동 동기화가 만든 충돌도 패널에 보인다", async () => {
      mock.sync.mockResolvedValue({
        pull: { created: 0, updated: 0, deleted: 0 },
        push: { created: 0, updated: 0, deleted: 0 },
        conflicts: [conflictAt("a.md")],
        duration: 0,
      });
      mock.statusLocal.mockResolvedValue(localStatus(["a.md"]));
      const { hooks, onState, onStatusBar } = createHooks();
      await makeController(mock, hooks).vaultSync();

      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          syncState: "conflict",
          conflictRecords: [conflictRecord("a.md")],
        }),
      );
    });

    it("실패하면 알림 없이 상태바를 오류로 두고 이유를 사이드바에 남긴다", async () => {
      mock.sync.mockRejectedValueOnce(new Error("Notion 502 bad gateway"));
      const { hooks, onState, onNotice, onStatusBar } = createHooks();
      await makeController(mock, hooks).vaultSync();

      expect(onStatusBar).toHaveBeenLastCalledWith("error");
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          syncState: "error",
          errorMessage: expect.stringContaining("Notion 502 bad gateway"),
        }),
      );
      expect(onNotice).not.toHaveBeenCalled();
    });

    it("진행 중에 온 호출은 겹치지 않고 끝난 뒤 한 번 돈다 — 여러 번 와도 한 번 (S-09)", async () => {
      let resolveSync: (() => void) | null = null;
      mock.sync.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSync = () =>
              resolve({
                pull: { created: 0, updated: 0, deleted: 0 },
                push: { created: 0, updated: 0, deleted: 0 },
                conflicts: [],
                duration: 0,
              });
          }),
      );
      const { hooks } = createHooks();
      const controller = makeController(mock, hooks);

      const first = controller.vaultSync();
      await controller.vaultSync(); // 진행 중 → 미룬다
      await controller.vaultSync();
      expect(mock.sync).toHaveBeenCalledTimes(1);

      resolveSync!();
      await first;
      await vi.waitFor(() => expect(controller.isSyncing()).toBe(false));

      // 그 사이의 편집을 버리지 않는다 — 예전에는 무시해 다음 이벤트 · 주기까지 올리지 않았다
      expect(mock.sync).toHaveBeenCalledTimes(2);
    });
  });

  describe("cancel", () => {
    it("신호를 abort 하고, 작업이 멈춘 뒤에 취소 상태를 방출한다 — 멈출 때까지 새 작업을 받지 않는다 (S-09)", async () => {
      let finish!: () => void;
      mock.push.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ created: 1, updated: 0, deleted: 0, failed: [], duration: 0 });
          }),
      );
      const { hooks, onNotice, onStatusBar, onState } = createHooks();
      const controller = makeController(mock, hooks);

      const pushing = controller.push();
      expect(controller.isSyncing()).toBe(true);
      const signal = mock.push.mock.calls[0]![0].signal as AbortSignal;

      controller.cancel();

      expect(signal.aborted).toBe(true);
      expect(onNotice).toHaveBeenLastCalledWith(
        "Im-Nobsidian: 취소하는 중 — 처리 중인 항목을 마친 뒤 멈춥니다",
      );
      // 처리 중인 항목은 끝까지 간다 — 예전에는 여기서 잠금을 풀어 새 작업과 겹쳤다
      expect(controller.isSyncing()).toBe(true);
      await controller.pull();
      expect(mock.pull).not.toHaveBeenCalled();

      finish();
      await pushing;

      expect(onNotice).toHaveBeenCalledWith("Im-Nobsidian: 동기화 취소됨");
      expect(onNotice).not.toHaveBeenCalledWith(expect.stringContaining("Push 완료"));
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
      expect(onState).toHaveBeenCalledWith(
        expect.objectContaining({ completionSummary: "동기화가 취소되었습니다" }),
      );
      expect(controller.isSyncing()).toBe(false);
    });

    it("진행 중이 아니면 아무 동작도 하지 않는다", () => {
      const { hooks, onNotice, onStatusBar, onState } = createHooks();
      makeController(mock, hooks).cancel();

      expect(onNotice).not.toHaveBeenCalled();
      expect(onStatusBar).not.toHaveBeenCalled();
      expect(onState).not.toHaveBeenCalled();
    });
  });

  describe("refreshStatus", () => {
    it("fullCheck=true 면 원격까지 조회하고 remoteChanges 를 방출한다", async () => {
      mock.status.mockResolvedValue({
        lastSyncAt: "2026-05-29T00:00:00Z",
        localChanges: [{ path: "a.md" }],
        folderMoves: [{ from: "A", to: "B" }],
        remoteChanges: [{ path: "b.md" }],
        conflicts: [],
        conflictRecords: [],
        pendingOperations: 0,
      });
      const { hooks, onState } = createHooks();
      await makeController(mock, hooks).refreshStatus(true);

      expect(mock.status).toHaveBeenCalledTimes(1);
      expect(mock.statusLocal).not.toHaveBeenCalled();
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          lastSyncAt: "2026-05-29T00:00:00Z",
          folderMoves: [{ from: "A", to: "B" }],
          remoteChanges: [{ path: "b.md" }],
          syncState: "ready",
        }),
      );
    });

    it("fullCheck=false 면 로컬만 조회한다 — 옮긴 폴더도 싣는다", async () => {
      mock.statusLocal.mockResolvedValue({
        lastSyncAt: null,
        localChanges: [{ path: "B/x.md", type: "moved", movedFrom: "A/x.md" }],
        folderMoves: [{ from: "A", to: "B" }],
        conflicts: [],
        conflictRecords: [],
      });
      const { hooks, onState } = createHooks();
      await makeController(mock, hooks).refreshStatus(false);

      expect(mock.statusLocal).toHaveBeenCalledTimes(1);
      expect(mock.status).not.toHaveBeenCalled();
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ folderMoves: [{ from: "A", to: "B" }] }),
      );
      // 로컬 새로고침 패치엔 remoteChanges 키가 없다
      const lastPatch = onState.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect("remoteChanges" in lastPatch).toBe(false);
    });

    it("conflictRecords 가 있으면 conflict 상태를 방출한다", async () => {
      mock.statusLocal.mockResolvedValue({
        lastSyncAt: null,
        localChanges: [],
        folderMoves: [],
        conflicts: [{ path: "c.md" }],
        conflictRecords: [{ id: "1" }],
      });
      const { hooks, onState } = createHooks();
      await makeController(mock, hooks).refreshStatus(false);

      expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ syncState: "conflict" }));
    });

    it("원격 조회가 실패하면 「동기화 중」 에 남지 않고 이유와 함께 오류로 둔다", async () => {
      mock.status.mockRejectedValueOnce(new Error("Notion 502 bad gateway"));
      const { hooks, onState, onNotice } = createHooks();
      await makeController(mock, hooks).refreshStatus(true);

      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncState: "error", errorMessage: "Notion 502 bad gateway" }),
      );
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Notion 502 bad gateway"));
    });

    it("조회 실패는 무시한다(best-effort)", async () => {
      mock.statusLocal.mockRejectedValue(new Error("db locked"));
      const { hooks } = createHooks();
      await expect(makeController(mock, hooks).refreshStatus(false)).resolves.toBeUndefined();
    });
  });

  describe("로컬 새로고침과 패널 단계", () => {
    it("충돌로 표시된 노트를 싣는다 — 원격을 읽지 않아도 상태 DB 가 안다", async () => {
      mock.statusLocal.mockResolvedValue(localStatus(["배추.md"]));
      const { hooks, onState } = createHooks();
      await makeController(mock, hooks).refreshStatus(false);

      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          syncState: "conflict",
          conflictRecords: [conflictRecord("배추.md")],
        }),
      );
    });

    it("원격 확인도 충돌 목록은 상태 DB 의 충돌 기록이다", async () => {
      mock.status.mockResolvedValue(
        localStatus(["배추.md"], { conflicts: [conflictAt("배추.md")] }),
      );
      const { hooks, onState } = createHooks();
      await makeController(mock, hooks).refreshStatus(true);

      const patch = onState.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(patch).toMatchObject({
        syncState: "conflict",
        conflictRecords: [conflictRecord("배추.md")],
      });
      expect("conflicts" in patch).toBe(false);
    });

    it("상태바도 패널과 같은 단계다 — 다시 불러온 뒤 충돌이 남았으면 「Ready」 가 아니다", async () => {
      mock.statusLocal.mockResolvedValue(localStatus(["배추.md"]));
      mock.status.mockResolvedValue(localStatus([]));
      const { hooks, onStatusBar } = createHooks();
      const controller = makeController(mock, hooks);

      await controller.refreshStatus(false);
      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");

      await controller.refreshStatus(true);
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
    });

    it("도는 작업 중에는 목록만 바꾼다 — 볼트 이벤트가 불러도 진행 · 단계를 덮지 않는다", async () => {
      let finish!: () => void;
      mock.pull.mockImplementation(
        ({ onProgress }: { onProgress: (c: number, t: number, i: { path: string }) => void }) =>
          new Promise((resolve) => {
            onProgress(1, 3, { path: "감자.md" });
            finish = () =>
              resolve({
                created: 0,
                updated: 3,
                deleted: 0,
                conflicts: [],
                writtenPaths: [],
                failed: [],
                duration: 0,
              });
          }),
      );
      mock.statusLocal.mockResolvedValue(
        localStatus([], { localChanges: [{ path: "사과.md", type: "modified" }] }),
      );
      const { hooks, onState, onStatusBar } = createHooks();
      const controller = makeController(mock, hooks);

      const pulling = controller.pull();
      // pull 이 쓴 노트의 볼트 이벤트 · 도는 중에 연 패널이 부르는 새로고침
      await controller.refreshStatus(false);

      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          localChanges: [{ path: "사과.md", type: "modified" }],
          syncState: "syncing",
          operationType: "pull",
          progress: { current: 1, total: 3, currentPath: "감자.md" },
        }),
      );
      expect(onStatusBar.mock.calls).toEqual([["syncing"]]);

      finish();
      await pulling;
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncState: "ready", operationType: null, progress: null }),
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
    });

    it("올리기만 한 뒤에도 충돌이 남았으면 패널 · 상태바가 충돌이다", async () => {
      mock.statusLocal.mockResolvedValue(localStatus(["배추.md"]));
      const { hooks, onState, onStatusBar } = createHooks();
      await makeController(mock, hooks).push();

      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          syncState: "conflict",
          conflictRecords: [conflictRecord("배추.md")],
        }),
      );
    });

    it("되돌린 뒤에는 단계를 새로 정한다 — 지난 실패는 풀린다", async () => {
      mock.push.mockRejectedValueOnce(new Error("Notion 502 bad gateway"));
      const { hooks, onState, onStatusBar } = createHooks();
      const controller = makeController(mock, hooks);

      await controller.push();
      await controller.discard("노트.md");

      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncState: "ready", errorMessage: null }),
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
    });

    it("지난 작업의 실패 이유를 지우지 않는다 — 다음 작업이 끝나야 풀린다", async () => {
      mock.push.mockRejectedValueOnce(new Error("Notion 502 bad gateway"));
      const { hooks, onState, onStatusBar } = createHooks();
      const controller = makeController(mock, hooks);

      await controller.push();
      await controller.refreshStatus(false);

      expect(mock.statusLocal).toHaveBeenCalledTimes(1);
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncState: "error", errorMessage: "Notion 502 bad gateway" }),
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("error");

      await controller.push();
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncState: "ready", errorMessage: null }),
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
    });
  });

  describe("충돌 해결 (N-06)", () => {
    it("충돌로 표시된 노트만 읽고 pull 을 돌리지 않는다 — 고른 것을 오케스트레이터로 풀어 Notion 에 올린다", async () => {
      const a = conflictAt("a.md");
      const b = conflictAt("b.md");
      mock.listConflicts.mockResolvedValue([a, b]);
      const choose = vi.fn(async (conflict: Conflict) =>
        conflict === a ? ("local" as const) : ("merge" as const),
      );
      const { hooks, onStatusBar } = createHooks();

      await makeController(mock, hooks).resolveConflicts(choose);

      expect(mock.pull).not.toHaveBeenCalled();
      expect(mock.sync).not.toHaveBeenCalled();
      expect(choose).toHaveBeenCalledTimes(2);
      expect(mock.resolveConflict.mock.calls).toEqual([
        [a, "local"],
        [b, "merge"],
      ]);
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
    });

    it("양쪽이 이미 같은 충돌은 묻지 않고 표시만 푼다", async () => {
      const same = conflictAt("same.md");
      const real = conflictAt("real.md");
      mock.listConflicts.mockResolvedValue([same, real]);
      mock.clearStaleConflicts.mockReturnValue(["same.md"]);
      const choose = vi.fn(async () => "remote" as const);
      const { hooks, onNotice } = createHooks();

      await makeController(mock, hooks).resolveConflicts(choose);

      expect(choose).toHaveBeenCalledTimes(1);
      expect(choose).toHaveBeenCalledWith(real, expect.any(AbortSignal));
      expect(onNotice).toHaveBeenLastCalledWith(
        "Im-Nobsidian: 충돌 해결 — 해결 1건 · 남음 0건 · 양쪽이 이미 같아 표시만 푼 1건",
      );
    });

    it("고르지 않고 창을 닫으면 그 충돌은 남기고 다음 충돌을 묻는다", async () => {
      const a = conflictAt("a.md");
      const b = conflictAt("b.md");
      mock.listConflicts.mockResolvedValue([a, b]);
      const choose = vi.fn(async (conflict: Conflict) => (conflict === a ? null : "local"));
      mock.statusLocal.mockResolvedValue(localStatus(["a.md"]));
      const { hooks, onNotice, onStatusBar, onState } = createHooks();

      await makeController(mock, hooks).resolveConflicts(choose);

      expect(mock.resolveConflict.mock.calls).toEqual([[b, "local"]]);
      expect(onNotice).toHaveBeenLastCalledWith("Im-Nobsidian: 충돌 해결 — 해결 1건 · 남음 1건");
      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
      // 창을 닫은 뒤에도 남은 충돌이 패널에 있다 — 예전에는 로컬 새로고침이 목록을 비웠다
      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          syncState: "conflict",
          conflictRecords: [conflictRecord("a.md")],
        }),
      );
    });

    it("Notion 에 올리지 못한 충돌은 이유를 알리고 남긴다 — 다음 충돌은 계속 묻는다", async () => {
      const a = conflictAt("a.md");
      const b = conflictAt("b.md");
      mock.listConflicts.mockResolvedValue([a, b]);
      mock.resolveConflict.mockRejectedValueOnce(new Error("bad gateway"));
      mock.statusLocal.mockResolvedValue(localStatus(["a.md"]));
      const { hooks, onNotice, onStatusBar } = createHooks();

      await makeController(mock, hooks).resolveConflicts(async () => "local");

      expect(mock.resolveConflict).toHaveBeenCalledTimes(2);
      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: 충돌을 해결하지 못함 (a.md) — bad gateway. 충돌로 남겨 두었습니다.",
        8000,
      );
      expect(onNotice).toHaveBeenLastCalledWith(
        "Im-Nobsidian: 충돌 해결 — 해결 1건 · 남음 0건 · 실패 1건",
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
    });

    it("Notion 에서 지운 노트는 고른 일을 그 말로 알린다 (D)", async () => {
      mock.listConflicts.mockResolvedValue([conflictAt("gone.md", "deleted")]);
      const { hooks, onNotice } = createHooks();

      await makeController(mock, hooks).resolveConflicts(async () => "remote");

      expect(onNotice).toHaveBeenCalledWith("Im-Nobsidian: gone.md → 삭제 따르기");
    });

    it("Notion 에서 지운 노트를 다시 만들지 못하면 오류가 말하는 대로 알린다 — 충돌로 남긴다고 하지 않는다 (D)", async () => {
      mock.listConflicts.mockResolvedValue([conflictAt("gone.md", "deleted")]);
      mock.resolveConflict.mockRejectedValueOnce(
        new Error(
          "Notion 에 다시 만들지 못함 — 파일은 그대로이고 다음 push 가 다시 만든다 (gone.md): bad gateway",
        ),
      );
      const { hooks, onNotice } = createHooks();

      await makeController(mock, hooks).resolveConflicts(async () => "local");

      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: Notion 에 다시 만들지 못함 — 파일은 그대로이고 다음 push 가 다시 만든다 (gone.md): bad gateway",
        8000,
      );
      expect(onNotice).not.toHaveBeenCalledWith(
        expect.stringContaining("충돌로 남겨 두었습니다"),
        expect.anything(),
      );
    });

    it("자동 병합이 겹치는 줄을 남기면 그 파일에서 고치라고 알리고 남긴다", async () => {
      mock.listConflicts.mockResolvedValue([conflictAt("a.md")]);
      mock.resolveConflict.mockResolvedValue({
        path: "a.md",
        choice: "merge",
        success: false,
        mergeHadConflicts: true,
      });
      mock.statusLocal.mockResolvedValue(localStatus(["a.md"]));
      const { hooks, onNotice, onStatusBar } = createHooks();

      await makeController(mock, hooks).resolveConflicts(async () => "merge");

      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: 자동 병합이 겹치는 줄을 남겼습니다 — a.md 에서 충돌 표시(<<<<<<<)를 고친 뒤 다시 해결하세요.",
        8000,
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
    });

    it("모두 풀면 패널도 충돌에서 준비됨으로 돌아간다", async () => {
      mock.statusLocal.mockResolvedValueOnce(localStatus(["a.md"]));
      mock.listConflicts.mockResolvedValue([conflictAt("a.md")]);
      const { hooks, onState } = createHooks();
      const controller = makeController(mock, hooks);
      await controller.refreshStatus(false);
      expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ syncState: "conflict" }));

      await controller.resolveConflicts(async () => "local");

      expect(onState).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncState: "ready", conflictRecords: [] }),
      );
    });

    it("푼 뒤 로컬 새로고침이 실패하면 남은 충돌 수로 상태바를 둔다", async () => {
      mock.listConflicts.mockResolvedValue([conflictAt("a.md")]);
      mock.statusLocal.mockRejectedValue(new Error("vault read failed"));
      const { hooks, onStatusBar } = createHooks();

      await makeController(mock, hooks).resolveConflicts(async () => null);

      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
    });

    it("해결한 충돌은 고른 것을 화면 말로 알린다 — 내부 코드값을 보이지 않는다", async () => {
      mock.listConflicts.mockResolvedValue([conflictAt("a.md")]);
      const { hooks, onNotice } = createHooks();

      await makeController(mock, hooks).resolveConflicts(async () => "duplicate");

      expect(onNotice).toHaveBeenCalledWith("Im-Nobsidian: a.md → 복제");
    });

    it("충돌 목록을 읽지 못하면 이유를 알리고 아무것도 풀지 않는다", async () => {
      mock.listConflicts.mockRejectedValue(new Error("충돌 노트의 원격을 읽지 못함 (a.md): 502"));
      const choose = vi.fn();
      const { hooks, onNotice } = createHooks();

      await makeController(mock, hooks).resolveConflicts(choose);

      expect(choose).not.toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: 충돌 목록을 읽지 못함 — 충돌 노트의 원격을 읽지 못함 (a.md): 502",
        8000,
      );
    });

    it("충돌이 없으면 그렇다고 알린다", async () => {
      const { hooks, onNotice, onStatusBar } = createHooks();

      await makeController(mock, hooks).resolveConflicts(vi.fn());

      expect(onNotice).toHaveBeenCalledWith("Im-Nobsidian: 충돌이 없습니다.");
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
    });

    it("동기화 중에는 풀지 않는다", async () => {
      let finish: (() => void) | null = null;
      mock.sync.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                pull: { created: 0, updated: 0, deleted: 0 },
                push: { created: 0, updated: 0, deleted: 0 },
                conflicts: [],
                duration: 0,
              });
          }),
      );
      const { hooks, onNotice } = createHooks();
      const controller = makeController(mock, hooks);

      const syncing = controller.vaultSync();
      await controller.resolveConflicts(vi.fn());
      finish!();
      await syncing;

      expect(mock.listConflicts).not.toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledWith(
        `Im-Nobsidian: ${new SyncBusyError("sync", "resolve").message}`,
      );
    });

    it("푸는 동안에는 자동 동기화가 끼어들지 않는다 — 병합 결과를 쓴 파일이 부른 동기화는 푼 뒤에 돈다", async () => {
      mock.listConflicts.mockResolvedValue([conflictAt("a.md")]);
      const { hooks } = createHooks();
      const controller = makeController(mock, hooks);

      await controller.resolveConflicts(async () => {
        await controller.vaultSync();
        expect(mock.sync).not.toHaveBeenCalled();
        return "merge";
      });

      expect(mock.resolveConflict).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(mock.sync).toHaveBeenCalledTimes(1));
      expect(mock.resolveConflict.mock.invocationCallOrder[0]!).toBeLessThan(
        mock.sync.mock.invocationCallOrder[0]!,
      );
    });
  });

  describe("작업은 한 번에 하나 (S-09)", () => {
    /** 다음 호출을 멈춘다 — 작업이 «도는 중» 인 때를 만든다. */
    function hold(fn: ReturnType<typeof vi.fn>, value: unknown): () => void {
      let release!: () => void;
      fn.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(value))));
      return () => release();
    }

    const PULL_RESULT = {
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [],
      writtenPaths: [],
      failed: [],
      duration: 0,
    };
    const SYNC_RESULT = {
      pull: { created: 0, updated: 0, deleted: 0 },
      push: { created: 0, updated: 0, deleted: 0 },
      conflicts: [],
      duration: 0,
    };

    it("Pull 이 도는 동안 Push · Sync · 충돌 해결 · 원격 확인을 부르지 않고 무엇이 돌아 거절했는지 알린다", async () => {
      const release = hold(mock.pull, PULL_RESULT);
      const { hooks, onNotice } = createHooks();
      const controller = makeController(mock, hooks);

      const pulling = controller.pull();
      await controller.push();
      await controller.sync();
      await controller.resolveConflicts(vi.fn());
      await controller.refreshStatus(true);

      expect(mock.push).not.toHaveBeenCalled();
      expect(mock.sync).not.toHaveBeenCalled();
      expect(mock.listConflicts).not.toHaveBeenCalled();
      expect(mock.status).not.toHaveBeenCalled();
      for (const requested of ["push", "sync", "resolve", "status"] as const) {
        expect(onNotice).toHaveBeenCalledWith(
          `Im-Nobsidian: ${new SyncBusyError("pull", requested).message}`,
        );
      }
      // 원격 확인을 거절해도 로컬 상태는 새로고친다
      expect(mock.statusLocal).toHaveBeenCalled();

      release();
      await pulling;
      await controller.push();
      expect(mock.push).toHaveBeenCalledTimes(1);
    });

    it("줄 비교는 보기만 하므로 Pull 이 도는 동안에도 두 글을 내준다 — 거절하지 않는다", async () => {
      const release = hold(mock.pull, PULL_RESULT);
      const { hooks, onNotice } = createHooks();
      const controller = makeController(mock, hooks);
      const local = {
        path: "a.md",
        type: "modified",
        currentHash: "h2",
        previousHash: "h1",
      } as const;
      const remote = { pageId: "p1", type: "modified", path: "b.md", lastEdited: "t2" } as const;
      const localDiff = { path: "a.md", type: "modified", before: "옛\n", after: "새\n" };
      const remoteDiff = { path: "b.md", type: "modified", before: "옛\n", after: "Notion\n" };
      mock.localChangeDiff.mockResolvedValue(localDiff);
      mock.remoteChangeDiff.mockResolvedValue(remoteDiff);

      const pulling = controller.pull();
      onNotice.mockClear();
      await expect(controller.localChangeDiff(local)).resolves.toBe(localDiff);
      await expect(controller.remoteChangeDiff(remote)).resolves.toBe(remoteDiff);

      expect(mock.localChangeDiff).toHaveBeenCalledWith(local);
      expect(mock.remoteChangeDiff).toHaveBeenCalledWith(remote);
      expect(onNotice).not.toHaveBeenCalled();
      release();
      await pulling;
    });

    it("줄 비교를 못 하면 이유를 담은 거절을 그대로 돌려준다 — 창이 그 이유를 보인다", async () => {
      const { hooks, onState } = createHooks();
      mock.localChangeDiff.mockRejectedValue(
        new Error("지난 동기화 사본이 없어 비교할 수 없습니다 — a.md"),
      );

      await expect(
        makeController(mock, hooks).localChangeDiff({
          path: "a.md",
          type: "modified",
          currentHash: "h2",
          previousHash: "h1",
        }),
      ).rejects.toThrow("지난 동기화 사본이 없어 비교할 수 없습니다 — a.md");
      // 보기만 하는 것이라 사이드바를 「오류」 로 바꾸지 않는다
      expect(onState).not.toHaveBeenCalled();
    });

    it("자동 주기 sync 는 도는 작업이 있으면 알리지 않고 건너뛴다", async () => {
      const release = hold(mock.sync, SYNC_RESULT);
      const { hooks, onNotice } = createHooks();
      const controller = makeController(mock, hooks);

      const running = controller.vaultSync();
      onNotice.mockClear();
      await controller.autoSync();

      expect(mock.sync).toHaveBeenCalledTimes(1);
      expect(onNotice).not.toHaveBeenCalled();

      release();
      await running;
      await controller.autoSync();
      expect(mock.sync).toHaveBeenCalledTimes(2);
    });

    it("수동 Pull 중에 온 볼트 이벤트 sync 는 끝난 뒤 한 번 돈다 — 겹치지 않는다", async () => {
      const release = hold(mock.pull, PULL_RESULT);
      const { hooks } = createHooks();
      const controller = makeController(mock, hooks);

      const pulling = controller.pull();
      await controller.vaultSync();
      await controller.vaultSync();
      expect(mock.sync).not.toHaveBeenCalled();

      release();
      await pulling;
      await vi.waitFor(() => expect(mock.sync).toHaveBeenCalledTimes(1));
      expect(mock.pull.mock.invocationCallOrder[0]!).toBeLessThan(
        mock.sync.mock.invocationCallOrder[0]!,
      );
    });

    it("상태 표시 커맨드는 도는 작업이 있으면 무엇이 도는지 싣고 거절한다", async () => {
      const release = hold(mock.sync, SYNC_RESULT);
      const { hooks } = createHooks();
      const controller = makeController(mock, hooks);

      const running = controller.vaultSync();
      await expect(controller.getStatus()).rejects.toMatchObject({
        running: "sync",
        requested: "status",
      });
      expect(mock.status).not.toHaveBeenCalled();

      release();
      await running;
      await expect(controller.getStatus()).resolves.toMatchObject({ remoteChanges: [] });
      // 상태 확인도 줄에 선다 — 도는 동안 온 볼트 이벤트 sync 는 끝난 뒤에 돈다
      expect(controller.isSyncing()).toBe(false);
    });

    it("shutdown 은 도는 작업을 취소하고 끝나기를 기다린다 — 그 뒤로는 미룬 sync 도 새 작업도 돌리지 않는다", async () => {
      const release = hold(mock.pull, PULL_RESULT);
      const { hooks } = createHooks();
      const controller = makeController(mock, hooks);

      const pulling = controller.pull();
      const signal = mock.pull.mock.calls[0]![0].signal as AbortSignal;
      await controller.vaultSync(); // 미룬다

      let stopped = false;
      const stopping = controller.shutdown().then(() => (stopped = true));
      await Promise.resolve();
      expect(signal.aborted).toBe(true);
      expect(stopped).toBe(false);

      release();
      await Promise.all([pulling, stopping]);
      expect(stopped).toBe(true);

      await controller.push();
      await controller.vaultSync();
      await controller.autoSync();
      await expect(controller.getStatus()).rejects.toThrow("다시 불러오는 중");
      expect(mock.sync).not.toHaveBeenCalled();
      expect(mock.push).not.toHaveBeenCalled();
      expect(controller.isSyncing()).toBe(false);
    });

    it("shutdown 은 묻던 충돌 창을 닫게 하고 남은 충돌은 묻지 않는다", async () => {
      const a = conflictAt("a.md");
      const b = conflictAt("b.md");
      mock.listConflicts.mockResolvedValue([a, b]);
      const { hooks } = createHooks();
      const controller = makeController(mock, hooks);
      let asked!: () => void;
      const askedFirst = new Promise<void>((resolve) => (asked = resolve));
      // 창은 신호가 취소되면 닫힌다 — 고르지 않고 닫은 것과 같다(null)
      const choose = vi.fn(
        (_conflict: Conflict, signal: AbortSignal) =>
          new Promise<ResolutionChoice | null>((resolve) => {
            signal.addEventListener("abort", () => resolve(null));
            asked();
          }),
      );

      const resolving = controller.resolveConflicts(choose);
      await askedFirst;
      await controller.shutdown();
      await resolving;

      expect(choose).toHaveBeenCalledTimes(1);
      expect(mock.resolveConflict).not.toHaveBeenCalled();
    });
  });

  describe("볼트 이름 변경 · 삭제 (S-11)", () => {
    it("노트 · 폴더의 이름 변경을 옛 경로와 함께 적고 동기화를 알린다", () => {
      const controller = makeController(mock, createHooks().hooks);

      expect(controller.onVaultRename("a/old.md", "b/new.md", false)).toBe(true);
      expect(controller.onVaultRename("Projects", "Work", true)).toBe(true);

      expect(mock.recordLocalRename).toHaveBeenNthCalledWith(1, "a/old.md", "b/new.md", "file");
      expect(mock.recordLocalRename).toHaveBeenNthCalledWith(2, "Projects", "Work", "folder");
    });

    it("노트를 노트가 아닌 파일로 바꾸면 지운 것과 같다 — 첨부는 동기화하지 않는다", () => {
      const controller = makeController(mock, createHooks().hooks);

      expect(controller.onVaultRename("a/note.md", "a/note.txt", false)).toBe(true);
      expect(controller.onVaultRename("img/a.png", "img/b.png", false)).toBe(false);

      expect(mock.recordLocalDelete).toHaveBeenCalledWith("a/note.md");
      expect(mock.recordLocalRename).not.toHaveBeenCalled();
    });

    it("기록하지 못해도 던지지 않고 이유를 남긴다 — 동기화는 내용으로 짝을 찾는다", () => {
      const warn = vi.fn();
      const previous = getLogger();
      setLogger({ warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() });
      mock.recordLocalRename.mockImplementation(() => {
        throw new Error("database is locked");
      });
      mock.recordLocalDelete.mockImplementation(() => {
        throw new Error("database is locked");
      });
      const controller = makeController(mock, createHooks().hooks);

      expect(controller.onVaultRename("a.md", "b.md", false)).toBe(true);
      expect(() => controller.recordDelete("b.md")).not.toThrow();

      setLogger(previous);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![0]).toContain("database is locked");
    });
  });
});
