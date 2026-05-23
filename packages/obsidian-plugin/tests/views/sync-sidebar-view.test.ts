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

  it("actions 없으면 mount 안 함", () => {
    view.updateState({});
    expect(mount).not.toHaveBeenCalled();
  });
});
