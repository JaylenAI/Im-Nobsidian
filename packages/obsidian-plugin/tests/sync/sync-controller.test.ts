import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getLogger,
  setLogger,
  type Conflict,
  type ResolutionChoice,
  type SyncOrchestrator,
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
}

function createMockOrchestrator(): MockOrchestrator {
  return {
    push: vi
      .fn()
      .mockResolvedValue({ created: 0, updated: 0, deleted: 0, failed: [], duration: 0 }),
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
      push: { created: 0, updated: 0, deleted: 0 },
      conflicts: [],
      duration: 0,
    }),
    status: vi.fn().mockResolvedValue({
      lastSyncAt: null,
      localChanges: [],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
    }),
    statusLocal: vi.fn().mockResolvedValue({
      lastSyncAt: null,
      localChanges: [],
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

/** 충돌 하나 — 컨트롤러는 경로만 본다. */
function conflictAt(path: string): Conflict {
  return { syncRecord: { obsidianPath: path } } as Conflict;
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
      const { hooks, onNotice, onStatusBar } = createHooks();
      await makeController(mock, hooks).pull();

      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: Pull 완료 — 생성 1 / 수정 0 / 삭제 0 / 충돌 1 (2.0s)",
      );
      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
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

  describe("vaultSync", () => {
    it("상태바만 갱신하고 사이드바/알림은 건드리지 않는다", async () => {
      const { hooks, onState, onNotice, onStatusBar } = createHooks();
      await makeController(mock, hooks).vaultSync();

      expect(mock.sync).toHaveBeenCalledTimes(1);
      expect(onStatusBar).toHaveBeenNthCalledWith(1, "syncing");
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
      expect(onState).not.toHaveBeenCalled();
      expect(onNotice).not.toHaveBeenCalled();
    });

    it("재진입을 가드한다 — 진행 중 두 번째 호출은 무시", async () => {
      let resolveSync: (() => void) | null = null;
      mock.sync.mockImplementation(
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
      await controller.vaultSync(); // 진행 중 → 즉시 무시
      resolveSync!();
      await first;

      expect(mock.sync).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancel", () => {
    it("진행 중 동기화의 신호를 abort 하고 취소 상태를 방출한다", async () => {
      mock.push.mockImplementation(() => new Promise(() => {})); // 영원히 미해결
      const { hooks, onNotice, onStatusBar, onState } = createHooks();
      const controller = makeController(mock, hooks);

      void controller.push();
      expect(controller.isSyncing()).toBe(true);
      const signal = mock.push.mock.calls[0]![0].signal as AbortSignal;

      controller.cancel();

      expect(signal.aborted).toBe(true);
      expect(onNotice).toHaveBeenCalledWith("Im-Nobsidian: 동기화 취소됨");
      expect(onStatusBar).toHaveBeenLastCalledWith("ready");
      expect(onState).toHaveBeenLastCalledWith(
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
          remoteChanges: [{ path: "b.md" }],
          syncState: "ready",
        }),
      );
    });

    it("fullCheck=false 면 로컬만 조회한다", async () => {
      const { hooks, onState } = createHooks();
      await makeController(mock, hooks).refreshStatus(false);

      expect(mock.statusLocal).toHaveBeenCalledTimes(1);
      expect(mock.status).not.toHaveBeenCalled();
      // 로컬 새로고침 패치엔 remoteChanges 키가 없다
      const lastPatch = onState.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect("remoteChanges" in lastPatch).toBe(false);
    });

    it("conflictRecords 가 있으면 conflict 상태를 방출한다", async () => {
      mock.statusLocal.mockResolvedValue({
        lastSyncAt: null,
        localChanges: [],
        conflicts: [{ path: "c.md" }],
        conflictRecords: [{ id: "1" }],
      });
      const { hooks, onState } = createHooks();
      await makeController(mock, hooks).refreshStatus(false);

      expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ syncState: "conflict" }));
    });

    it("조회 실패는 무시한다(best-effort)", async () => {
      mock.statusLocal.mockRejectedValue(new Error("db locked"));
      const { hooks } = createHooks();
      await expect(makeController(mock, hooks).refreshStatus(false)).resolves.toBeUndefined();
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
      expect(choose).toHaveBeenCalledWith(real);
      expect(onNotice).toHaveBeenLastCalledWith(
        "Im-Nobsidian: 충돌 해결 — 해결 1건 · 남음 0건 · 양쪽이 이미 같아 표시만 푼 1건",
      );
    });

    it("고르지 않고 창을 닫으면 그 충돌은 남기고 다음 충돌을 묻는다", async () => {
      const a = conflictAt("a.md");
      const b = conflictAt("b.md");
      mock.listConflicts.mockResolvedValue([a, b]);
      const choose = vi.fn(async (conflict: Conflict) => (conflict === a ? null : "local"));
      const { hooks, onNotice, onStatusBar } = createHooks();

      await makeController(mock, hooks).resolveConflicts(choose);

      expect(mock.resolveConflict.mock.calls).toEqual([[b, "local"]]);
      expect(onNotice).toHaveBeenLastCalledWith("Im-Nobsidian: 충돌 해결 — 해결 1건 · 남음 1건");
      expect(onStatusBar).toHaveBeenLastCalledWith("conflict");
    });

    it("Notion 에 올리지 못한 충돌은 이유를 알리고 남긴다 — 다음 충돌은 계속 묻는다", async () => {
      const a = conflictAt("a.md");
      const b = conflictAt("b.md");
      mock.listConflicts.mockResolvedValue([a, b]);
      mock.resolveConflict.mockRejectedValueOnce(new Error("bad gateway"));
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

    it("자동 병합이 겹치는 줄을 남기면 그 파일에서 고치라고 알리고 남긴다", async () => {
      mock.listConflicts.mockResolvedValue([conflictAt("a.md")]);
      mock.resolveConflict.mockResolvedValue({
        path: "a.md",
        choice: "merge",
        success: false,
        mergeHadConflicts: true,
      });
      const { hooks, onNotice, onStatusBar } = createHooks();

      await makeController(mock, hooks).resolveConflicts(async () => "merge");

      expect(onNotice).toHaveBeenCalledWith(
        "Im-Nobsidian: 자동 병합이 겹치는 줄을 남겼습니다 — a.md 에서 충돌 표시(<<<<<<<)를 고친 뒤 다시 해결하세요.",
        8000,
      );
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
      expect(onNotice).toHaveBeenCalledWith("Im-Nobsidian: 동기화가 끝난 뒤 충돌을 해결하세요.");
    });

    it("푸는 동안에는 자동 동기화가 끼어들지 않는다 — 병합 결과를 쓴 파일이 동기화를 부른다", async () => {
      mock.listConflicts.mockResolvedValue([conflictAt("a.md")]);
      const { hooks } = createHooks();
      const controller = makeController(mock, hooks);

      await controller.resolveConflicts(async () => {
        await controller.vaultSync();
        return "merge";
      });

      expect(mock.sync).not.toHaveBeenCalled();
      expect(mock.resolveConflict).toHaveBeenCalledTimes(1);
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
