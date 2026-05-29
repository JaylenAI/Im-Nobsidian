import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SyncOrchestrator } from "@im-nobsidian/core";
import { SyncController } from "../../src/sync/sync-controller.js";
import type { SyncControllerHooks } from "../../src/sync/sync-controller.js";

interface MockOrchestrator {
  push: ReturnType<typeof vi.fn>;
  pull: ReturnType<typeof vi.fn>;
  sync: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  statusLocal: ReturnType<typeof vi.fn>;
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
});
