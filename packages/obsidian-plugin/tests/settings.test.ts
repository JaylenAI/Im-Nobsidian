import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImNobsidianSettingTab } from "../src/settings.js";

describe("ImNobsidianSettingTab", () => {
  let settingTab: ImNobsidianSettingTab;
  let mockPlugin: {
    settings: {
      token: string;
      rootPageId: string;
      syncDirection: string;
      autoSync: boolean;
      autoSyncInterval: number;
    };
    saveSettings: ReturnType<typeof vi.fn>;
    initOrchestrator: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockPlugin = {
      settings: {
        token: "ntn_test_token",
        rootPageId: "root-page-123",
        syncDirection: "both",
        autoSync: false,
        autoSyncInterval: 300,
      },
      saveSettings: vi.fn().mockResolvedValue(undefined),
      initOrchestrator: vi.fn().mockResolvedValue(undefined),
    };

    settingTab = new ImNobsidianSettingTab({} as never, mockPlugin as never);
  });

  it("인스턴스 생성", () => {
    expect(settingTab).toBeDefined();
  });

  it("display() 에러 없이 실행", () => {
    expect(() => settingTab.display()).not.toThrow();
  });

  it("containerEl.empty() 호출", () => {
    const spy = vi.spyOn(settingTab.containerEl, "empty");
    settingTab.display();
    expect(spy).toHaveBeenCalled();
  });

  it("display() 여러 번 호출 가능", () => {
    settingTab.display();
    expect(() => settingTab.display()).not.toThrow();
  });

  it("다른 설정값으로도 display 가능", () => {
    mockPlugin.settings.token = "";
    mockPlugin.settings.syncDirection = "push";
    expect(() => settingTab.display()).not.toThrow();
  });

  it("autoSync true 상태에서도 display 정상", () => {
    mockPlugin.settings.autoSync = true;
    mockPlugin.settings.autoSyncInterval = 60;
    expect(() => settingTab.display()).not.toThrow();
  });
});
