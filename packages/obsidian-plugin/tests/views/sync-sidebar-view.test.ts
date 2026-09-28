import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("svelte", () => ({
  mount: vi.fn(() => ({ $$: {} })),
  unmount: vi.fn(),
}));

vi.mock("../../src/views/SyncDashboard.svelte", () => ({
  default: {},
}));

import { SyncSidebarView, SYNC_SIDEBAR_TYPE } from "../../src/views/sync-sidebar-view.js";
import { mount, unmount } from "svelte";

describe("SyncSidebarView", () => {
  let view: SyncSidebarView;

  beforeEach(() => {
    vi.clearAllMocks();
    view = new SyncSidebarView({} as never);
  });

  it("VIEW_TYPE 상수 정의", () => {
    expect(SYNC_SIDEBAR_TYPE).toBe("im-notion-sync-sidebar");
  });

  it("getViewType 반환", () => {
    expect(view.getViewType()).toBe(SYNC_SIDEBAR_TYPE);
  });

  it("getDisplayText 반환", () => {
    expect(view.getDisplayText()).toBe("Im-Notion Sync");
  });

  it("getIcon 반환", () => {
    expect(view.getIcon()).toBe("refresh-cw");
  });

  it("setActions 설정", () => {
    const actions = {
      onPull: vi.fn(),
      onPush: vi.fn(),
      onSync: vi.fn(),
      onRefresh: vi.fn(),
      onResolveConflict: vi.fn(),
      onCancel: vi.fn(),
      onOpenFile: vi.fn(),
    };
    expect(() => view.setActions(actions)).not.toThrow();
  });

  it("updateState 호출 시 mountOnce 트리거", () => {
    const actions = {
      onPull: vi.fn(),
      onPush: vi.fn(),
      onSync: vi.fn(),
      onRefresh: vi.fn(),
      onResolveConflict: vi.fn(),
      onCancel: vi.fn(),
      onOpenFile: vi.fn(),
    };
    view.setActions(actions);

    view.updateState({ lastSyncAt: "2026-05-22T00:00:00Z" });
    expect(mount).toHaveBeenCalled();
  });

  it("onOpen에서 addClass 호출", async () => {
    const spy = vi.spyOn(view.contentEl, "addClass" as never);
    await view.onOpen();
    expect(spy).toHaveBeenCalled();
  });

  it("onClose에서 unmount 호출", async () => {
    const actions = {
      onPull: vi.fn(),
      onPush: vi.fn(),
      onSync: vi.fn(),
      onRefresh: vi.fn(),
      onResolveConflict: vi.fn(),
      onCancel: vi.fn(),
      onOpenFile: vi.fn(),
    };
    view.setActions(actions);
    view.updateState({});

    await view.onClose();
    expect(unmount).toHaveBeenCalled();
  });

  it("중복 mount 방지", () => {
    const actions = {
      onPull: vi.fn(),
      onPush: vi.fn(),
      onSync: vi.fn(),
      onRefresh: vi.fn(),
      onResolveConflict: vi.fn(),
      onCancel: vi.fn(),
      onOpenFile: vi.fn(),
    };
    view.setActions(actions);

    view.updateState({});
    view.updateState({ lastSyncAt: "2026-05-22T00:00:00Z" });

    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("변경 패널의 항목별 올리기 · 받기는 그 노트 경로로, 되돌리기는 그 변경으로 넘긴다", () => {
    const actions = {
      onPull: vi.fn(),
      onPush: vi.fn(),
      onSync: vi.fn(),
      onRefresh: vi.fn(),
      onResolveConflict: vi.fn(),
      onCancel: vi.fn(),
      onOpenFile: vi.fn(),
      onPushPath: vi.fn().mockResolvedValue(undefined),
      onDiscard: vi.fn().mockResolvedValue(undefined),
      onPullPath: vi.fn().mockResolvedValue(undefined),
    };
    view.setActions(actions);
    view.updateState({ lastSyncAt: null });

    // 되돌리기는 확인 창이 고친 노트인지 지운 노트인지를 말하므로 변경을 통째로 넘긴다.
    const change = { path: "b.md", type: "deleted", currentHash: "", previousHash: "h1" };
    const props = vi.mocked(mount).mock.calls[0]![1]!.props as Record<string, (p: unknown) => void>;
    props.onPushPath!("a.md");
    props.onDiscard!(change);
    props.onPullPath!("c.md");
    expect(actions.onPushPath).toHaveBeenCalledWith("a.md");
    expect(actions.onDiscard).toHaveBeenCalledWith(change);
    expect(actions.onPullPath).toHaveBeenCalledWith("c.md");
  });

  it("변경 패널에서 누른 변경을 그대로 줄 비교로 넘긴다", () => {
    const actions = {
      onPull: vi.fn(),
      onPush: vi.fn(),
      onSync: vi.fn(),
      onRefresh: vi.fn(),
      onResolveConflict: vi.fn(),
      onCancel: vi.fn(),
      onOpenFile: vi.fn(),
      onPushPath: vi.fn(),
      onDiscard: vi.fn(),
      onPullPath: vi.fn(),
      onShowLocalDiff: vi.fn(),
      onShowRemoteDiff: vi.fn(),
    };
    view.setActions(actions);
    view.updateState({ lastSyncAt: null });

    const local = { path: "a.md", type: "modified", currentHash: "h2", previousHash: "h1" };
    const remote = { pageId: "p1", type: "modified", path: "b.md", lastEdited: "t" };
    const props = vi.mocked(mount).mock.calls[0]![1]!.props as Record<string, (c: unknown) => void>;
    props.onShowLocalDiff!(local);
    props.onShowRemoteDiff!(remote);
    expect(actions.onShowLocalDiff).toHaveBeenCalledWith(local);
    expect(actions.onShowRemoteDiff).toHaveBeenCalledWith(remote);
  });

  it("actions 없으면 mount 안 함", () => {
    view.updateState({});
    expect(mount).not.toHaveBeenCalled();
  });
});
