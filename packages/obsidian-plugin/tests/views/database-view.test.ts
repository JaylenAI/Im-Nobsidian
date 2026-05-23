import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("svelte", () => ({
  mount: vi.fn(() => ({ $$: {} })),
  unmount: vi.fn(),
}));

vi.mock("../../src/views/ViewContainer.svelte", () => ({
  default: {},
}));

import { DatabaseItemView, DATABASE_VIEW_TYPE } from "../../src/views/database-view.js";
import { mount, unmount } from "svelte";

describe("DatabaseItemView", () => {
  let view: DatabaseItemView;

  beforeEach(() => {
    vi.clearAllMocks();
    view = new DatabaseItemView({} as never);
  });

  it("VIEW_TYPE 상수 정의", () => {
    expect(DATABASE_VIEW_TYPE).toBe("im-nobsidian-db-view");
  });

  it("getViewType 반환", () => {
    expect(view.getViewType()).toBe(DATABASE_VIEW_TYPE);
  });

  it("viewData 없으면 'Database View' 표시", () => {
    expect(view.getDisplayText()).toBe("Database View");
  });

  it("getIcon 반환", () => {
    expect(view.getIcon()).toBe("database");
  });

  it("setViewParams로 데이터 로드", async () => {
    const mockProvider = {
      getViewConfigs: vi.fn().mockResolvedValue({
        views: [{ id: "v1", type: "gallery", name: "Gallery" }],
      }),
      buildDefaultViewData: vi.fn().mockResolvedValue({
        databaseName: "Test DB",
        viewConfig: { id: "v1", type: "gallery" },
        entries: [],
        properties: [],
      }),
      buildViewData: vi.fn(),
    };

    await view.setViewParams({
      provider: mockProvider as never,
      databaseId: "db-123",
      folderPath: "databases/test",
    });

    expect(mockProvider.getViewConfigs).toHaveBeenCalledWith("db-123");
    expect(mockProvider.buildDefaultViewData).toHaveBeenCalledWith("db-123", "databases/test");
    expect(mount).toHaveBeenCalled();
  });

  it("onClose에서 unmount 호출", async () => {
    const mockProvider = {
      getViewConfigs: vi.fn().mockResolvedValue({ views: [] }),
      buildDefaultViewData: vi.fn().mockResolvedValue({
        databaseName: "Test",
        viewConfig: {},
        entries: [],
        properties: [],
      }),
      buildViewData: vi.fn(),
    };

    await view.setViewParams({
      provider: mockProvider as never,
      databaseId: "db-1",
      folderPath: "test",
    });

    await view.onClose();
    expect(unmount).toHaveBeenCalled();
  });

  it("getViewConfigs null이면 렌더링 안 함", async () => {
    const mockProvider = {
      getViewConfigs: vi.fn().mockResolvedValue(null),
      buildDefaultViewData: vi.fn(),
      buildViewData: vi.fn(),
    };

    await view.setViewParams({
      provider: mockProvider as never,
      databaseId: "db-1",
      folderPath: "test",
    });

    expect(mockProvider.buildDefaultViewData).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });
});
