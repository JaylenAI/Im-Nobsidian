import { describe, it, expect, vi, beforeEach } from "vitest";
import { Setting, type StubControl } from "obsidian";
import { ImNobsidianSettingTab } from "../src/settings.js";

type Rows = typeof Setting.rows;

describe("ImNobsidianSettingTab (U-03)", () => {
  let settingTab: ImNobsidianSettingTab;
  let plugin: {
    settings: {
      tokenSecret: string;
      rootPageId: string;
      syncDirection: string;
      autoSync: boolean;
      autoSyncInterval: number;
      timeZone: string;
    };
    saveSettings: ReturnType<typeof vi.fn>;
    initOrchestrator: ReturnType<typeof vi.fn>;
    startAutoSync: ReturnType<typeof vi.fn>;
    stopAutoSync: ReturnType<typeof vi.fn>;
    connectionStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    plugin = {
      settings: {
        tokenSecret: "im-nobsidian-notion-token",
        rootPageId: "root-page-123",
        syncDirection: "both",
        autoSync: false,
        autoSyncInterval: 300,
        timeZone: "",
      },
      saveSettings: vi.fn().mockResolvedValue(undefined),
      initOrchestrator: vi.fn().mockResolvedValue(undefined),
      startAutoSync: vi.fn(),
      stopAutoSync: vi.fn(),
      connectionStatus: vi.fn(() => ({ ready: true, message: "준비됨 — 동기화할 수 있습니다." })),
    };
    settingTab = new ImNobsidianSettingTab({} as never, plugin as never);
  });

  /** 설정 창을 그리고 줄을 이름으로 찾는다. */
  function display(): {
    row: (name: string) => Rows[number];
    control: (name: string) => StubControl;
  } {
    Setting.rows.splice(0);
    settingTab.display();
    const row = (name: string) => {
      const found = Setting.rows.find((r) => r.name === name);
      if (!found) throw new Error(`설정 줄 없음: ${name}`);
      return found;
    };
    return { row, control: (name) => row(name).controls[0]! };
  }

  it("토큰은 키체인 고르개다 — 글자 칸에 토큰을 두지 않는다", () => {
    const { row, control } = display();
    expect(control("Notion 토큰").kind).toBe("secret");
    expect(control("Notion 토큰").value).toBe("im-nobsidian-notion-token");
    expect(row("Notion 토큰").desc).toContain("이 기기에만");
  });

  it("루트 페이지는 주소를 붙여 넣어도 그 안의 ID 로 적고, ID 를 못 찾으면 까닭을 보인다 (D1)", async () => {
    const { row, control } = display();
    const raw = "35a13b18d38280cf9057e37e6e473e41";
    const id = "35a13b18-d382-80cf-9057-e37e6e473e41";

    await control("루트 페이지 ID").change(` https://www.notion.so/myspace/회의-${raw}?pvs=4 `);
    expect(plugin.settings.rootPageId).toBe(id);
    expect(row("루트 페이지 ID").desc).toContain(`ID ${id} 로 씁니다`);
    expect(row("루트 페이지 ID").descEl.classes.has("mod-warning")).toBe(false);

    await control("루트 페이지 ID").change("https://www.notion.so/myspace/Notes");
    expect(plugin.settings.rootPageId).toBe("https://www.notion.so/myspace/Notes");
    expect(row("루트 페이지 ID").desc).toContain("찾지 못했습니다");
    expect(row("루트 페이지 ID").descEl.classes.has("mod-warning")).toBe(true);

    await control("루트 페이지 ID").change("");
    expect(plugin.settings.rootPageId).toBe("");
    expect(row("루트 페이지 ID").descEl.classes.has("mod-warning")).toBe(false);
  });

  it("연결 설정은 칠 때마다 다시 연결하지 않고, 창을 닫을 때 한 번 다시 연결한다", async () => {
    const { control } = display();
    await control("루트 페이지 ID").change(" abc ");
    await control("루트 페이지 ID").change(" abcd ");
    await control("Notion 토큰").change("other-token");
    await control("동기화 방향").change("pull");
    await control("날짜시각 시간대").change("America/New_York");

    expect(plugin.initOrchestrator).not.toHaveBeenCalled();
    expect(plugin.settings).toMatchObject({
      rootPageId: "abcd",
      tokenSecret: "other-token",
      syncDirection: "pull",
      timeZone: "America/New_York",
    });
    expect(plugin.saveSettings).toHaveBeenCalledTimes(5);

    settingTab.hide();
    expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
    // 다시 열고 아무것도 바꾸지 않고 닫으면 다시 연결하지 않는다
    display();
    settingTab.hide();
    expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
  });

  it("자동 동기화 켜기 · 끄기 · 간격은 바로 건다", async () => {
    const { control } = display();
    await control("자동 동기화").change(true);
    expect(plugin.settings.autoSync).toBe(true);
    expect(plugin.startAutoSync).toHaveBeenCalledTimes(1);

    await control("자동 동기화 간격").change("600");
    expect(plugin.settings.autoSyncInterval).toBe(600);
    expect(plugin.startAutoSync).toHaveBeenCalledTimes(2);

    await control("자동 동기화").change(false);
    expect(plugin.stopAutoSync).toHaveBeenCalledTimes(1);
    expect(plugin.initOrchestrator).not.toHaveBeenCalled();
  });

  it("간격은 고르개다 — 예전 설정의 목록 밖 값도 지금 값으로 보인다", () => {
    plugin.settings.autoSyncInterval = 45;
    const { control } = display();
    const interval = control("자동 동기화 간격");
    expect(interval.options).toEqual([
      ["45", "45초"],
      ["60", "1분"],
      ["300", "5분"],
      ["600", "10분"],
      ["900", "15분"],
      ["1800", "30분"],
      ["3600", "60분"],
    ]);
    expect(interval.value).toBe("45");
  });

  it("설명이 실제 동작을 말한다 — 자동 동기화는 push 만이 아니고, 방향은 단추를 막는다", () => {
    const { row } = display();
    expect(row("자동 동기화").desc).toContain("2초 뒤");
    expect(row("자동 동기화").desc).toContain("동기화 방향을 따름");
    expect(row("자동 동기화").desc).not.toContain("push");
    expect(row("동기화 방향").desc).toContain("Pull 단추가 꺼지고 명령은 까닭을 알립니다");
    expect(row("날짜시각 시간대").desc).toContain("이미 적힌 시각은 고치지 않고");
  });

  it("시간대 첫 칸은 이 컴퓨터의 시간대이고, 목록에 없는 예전 값도 보인다", () => {
    const here = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    plugin.settings.timeZone = "Etc/Unknown-Zone";
    const { control } = display();
    const zone = control("날짜시각 시간대");
    expect(zone.options[0]).toEqual(["", `이 컴퓨터의 시간대 (${here})`]);
    expect(zone.options[1]).toEqual(["Etc/Unknown-Zone", "Etc/Unknown-Zone"]);
    expect(zone.options.map(([v]) => v)).toContain("Asia/Seoul");
    expect(zone.value).toBe("Etc/Unknown-Zone");
  });

  it("연결 상태는 동기화가 막히는 까닭을 보이고, 다시 연결은 바로 다시 연결한다", async () => {
    plugin.connectionStatus.mockReturnValue({
      ready: false,
      message: "초기화 실패: 이 기기의 키체인에 Notion 토큰(이름 x)이 없습니다",
    });
    const { row, control } = display();
    expect(row("연결 상태").desc).toBe(
      "초기화 실패: 이 기기의 키체인에 Notion 토큰(이름 x)이 없습니다",
    );
    expect(row("연결 상태").descEl.classes.has("mod-warning")).toBe(true);

    // 연결 설정을 바꾸면 「닫으면 걸린다」 로 바뀐다
    await control("루트 페이지 ID").change("new");
    expect(row("연결 상태").desc).toContain("이 창을 닫거나 다시 연결하면");
    expect(row("연결 상태").descEl.classes.has("mod-warning")).toBe(false);

    plugin.connectionStatus.mockReturnValue({
      ready: true,
      message: "준비됨 — 동기화할 수 있습니다.",
    });
    await control("연결 상태").click();
    expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
    expect(row("연결 상태").desc).toBe("준비됨 — 동기화할 수 있습니다.");
    expect(row("연결 상태").descEl.classes.has("mod-warning")).toBe(false);
    expect(control("연결 상태").disabled).toBe(false);
    // 다시 연결로 이미 걸었으니 닫을 때 또 연결하지 않는다
    settingTab.hide();
    expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
  });
});
