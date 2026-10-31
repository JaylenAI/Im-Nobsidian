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
      conflictStrategy: string;
      attachments: string;
      deleteSync?: boolean;
      fullReconcileInterval?: number;
      downloadMedia?: boolean;
      preferMarkdownApi?: boolean;
      syncFiles?: boolean;
      createDatabases?: boolean;
      notifications?: string;
      databaseId?: string;
      databases?: { databaseId: string; localFolder: string }[];
      includePaths?: string[];
      excludePaths?: string[];
      connections?: {
        folder: string;
        tokenSecret: string;
        rootPageId: string;
        includePaths?: string[];
        excludePaths?: string[];
      }[];
    };
    knownConnectionFolders: string[];
    trackedNotesUnder: ReturnType<typeof vi.fn>;
    folderConnectionStatus: ReturnType<typeof vi.fn>;
    saveSettings: ReturnType<typeof vi.fn>;
    initOrchestrator: ReturnType<typeof vi.fn>;
    startAutoSync: ReturnType<typeof vi.fn>;
    stopAutoSync: ReturnType<typeof vi.fn>;
    connectionStatus: ReturnType<typeof vi.fn>;
    checkNotionAccess: ReturnType<typeof vi.fn>;
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
        conflictStrategy: "manual",
        attachments: "attachments",
      },
      saveSettings: vi.fn().mockResolvedValue(undefined),
      initOrchestrator: vi.fn().mockResolvedValue(undefined),
      startAutoSync: vi.fn(),
      stopAutoSync: vi.fn(),
      connectionStatus: vi.fn(() => ({ ready: true, message: "준비됨 — 동기화할 수 있습니다." })),
      checkNotionAccess: vi.fn(async () => ({
        ok: true,
        lines: ["토큰이 맞습니다.", "루트 페이지 「홈」 — 읽을 수 있습니다."],
      })),
      knownConnectionFolders: [""],
      // 볼트 연결이 「개인」 폴더의 노트 3개를 동기화하고 있다
      trackedNotesUnder: vi.fn((folder: string) => (folder === "개인" ? 3 : 0)),
      folderConnectionStatus: vi.fn(() => ({ ready: false, message: "아직 연결하지 않았습니다." })),
    };
    const folders = ["Work", "Work/Team", "개인", ".trash", "Work/.hidden"];
    const app = { vault: { getAllFolders: () => folders.map((path) => ({ path })) } };
    settingTab = new ImNobsidianSettingTab(app as never, plugin as never);
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

  /** 줄의 단추를 글자로 찾는다. */
  function button(row: Rows[number], text: string): StubControl {
    const found = row.controls.find((c) => c.buttonText === text);
    if (!found) throw new Error(`단추 없음: ${text}`);
    return found;
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

  it("Notion 확인은 바꾼 연결 설정을 먼저 걸고 Notion 에 물은 것을 그 줄에 적는다", async () => {
    const { row, control } = display();
    await control("Notion 토큰").change("new-token");
    await button(row("연결 상태"), "Notion 확인").click();
    expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
    expect(plugin.checkNotionAccess).toHaveBeenCalledWith();
    expect(row("연결 상태").desc).toBe("토큰이 맞습니다. 루트 페이지 「홈」 — 읽을 수 있습니다.");
    expect(row("연결 상태").descEl.classes.has("mod-warning")).toBe(false);
    expect(button(row("연결 상태"), "Notion 확인").disabled).toBe(false);

    // 바꾼 것이 없으면 다시 걸지 않고 묻기만 한다
    plugin.checkNotionAccess.mockResolvedValueOnce({
      ok: false,
      lines: [
        "토큰이 맞습니다.",
        "루트 페이지를 읽지 못했습니다 — 없거나 이 통합에 공유하지 않았습니다.",
      ],
    });
    await button(row("연결 상태"), "Notion 확인").click();
    expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
    expect(row("연결 상태").descEl.classes.has("mod-warning")).toBe(true);
  });

  it("동기화 범위 — 포함 · 제외 패턴은 한 줄에 하나, 빈 줄 · 주석은 빼고 창을 닫을 때 다시 연결한다", async () => {
    plugin.settings.excludePaths = ["Archive"];
    const { row, control } = display();
    expect(control("제외 패턴").kind).toBe("textarea");
    expect(control("제외 패턴").value).toBe("Archive");
    expect(row("제외 패턴").desc).toContain(".im-nobsidian-ignore");

    await control("포함 패턴").change("Work/**/*.md\n\n");
    await control("제외 패턴").change(" Private/ \n# 임시 노트\n*.tmp.md\n");

    expect(plugin.settings.includePaths).toEqual(["Work/**/*.md"]);
    expect(plugin.settings.excludePaths).toEqual(["Private/", "*.tmp.md"]);
    expect(plugin.initOrchestrator).not.toHaveBeenCalled();
    settingTab.hide();
    expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
  });

  it("Notion 에서 바꾼 제목으로 이름 바꾸기 — 기본은 꺼짐, 켜면 창을 닫을 때 다시 연결한다", async () => {
    const { control } = display();
    const toggle = control("Notion 에서 바꾼 제목으로 이름 바꾸기");
    expect(toggle.kind).toBe("toggle");
    expect(toggle.value).toBe(false);

    await toggle.change(true);

    expect(plugin.settings.renameOnTitleChange).toBe(true);
    expect(plugin.initOrchestrator).not.toHaveBeenCalled();
    settingTab.hide();
    expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
  });

  describe("CLI 와 같은 설정 (P8)", () => {
    it("둘 다 바뀐 노트 — 엔진의 전략 다섯 가지를 고르고, 설명이 고른 것을 따라 바뀐다", async () => {
      const { row, control } = display();
      expect(control("둘 다 바뀐 노트").options.map(([v]) => v)).toEqual([
        "manual",
        "merge",
        "local-first",
        "remote-first",
        "duplicate",
      ]);
      expect(row("둘 다 바뀐 노트").desc).toContain("사이드바에서 하나씩 고릅니다");

      await control("둘 다 바뀐 노트").change("remote-first");
      expect(plugin.settings.conflictStrategy).toBe("remote-first");
      expect(row("둘 다 바뀐 노트").desc).toContain("노트에서 고친 것은 사라집니다");
      // 엔진 목록에 없는 값은 적지 않는다
      await control("둘 다 바뀐 노트").change("newest");
      expect(plugin.settings.conflictStrategy).toBe("remote-first");
      expect(plugin.initOrchestrator).not.toHaveBeenCalled();
      settingTab.hide();
      expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
    });

    it("지운 것을 반대쪽에서도 지우기 — 없으면 켜져 보이고(예전 플러그인 동작), 끄면 false 로 적는다", async () => {
      const { row, control } = display();
      expect(control("지운 것을 반대쪽에서도 지우기").value).toBe(true);
      expect(row("지운 것을 반대쪽에서도 지우기").desc).toContain(
        "다음 Pull 이 Notion 에서 다시 받습니다",
      );
      await control("지운 것을 반대쪽에서도 지우기").change(false);
      expect(plugin.settings.deleteSync).toBe(false);
    });

    it("Notion 전체 확인 주기 — Pull 마다부터 7일까지, 목록 밖의 예전 값도 보인다", async () => {
      plugin.settings.fullReconcileInterval = 7200;
      const { control } = display();
      expect(control("Notion 전체 확인 주기").options).toEqual([
        ["0", "Pull 마다"],
        ["600", "10분"],
        ["1800", "30분"],
        ["3600", "1시간"],
        ["7200", "2시간"],
        ["21600", "6시간"],
        ["86400", "1일"],
        ["604800", "7일"],
      ]);
      expect(control("Notion 전체 확인 주기").value).toBe("7200");
      await control("Notion 전체 확인 주기").change("0");
      expect(plugin.settings.fullReconcileInterval).toBe(0);
    });

    it("첨부 폴더 — 기본값은 빈 칸으로 보이고, 비우면 기본값 · 빗금은 뗀다", async () => {
      const { control } = display();
      expect(control("첨부 폴더").value).toBe("");
      await control("첨부 폴더").change(" /Media/Notion/ ");
      expect(plugin.settings.attachments).toBe("Media/Notion");
      await control("첨부 폴더").change("  ");
      expect(plugin.settings.attachments).toBe("attachments");
    });

    it("그림 받기 · Markdown API — 없으면 켜져 보이고, 끄면 false 로 적는다", async () => {
      const { row, control } = display();
      expect(control("Notion 의 그림 받기").value).toBe(true);
      expect(row("Notion 의 그림 받기").desc).toContain("PDF 같은 파일은 꺼도 받습니다");
      expect(control("Notion Markdown API 쓰기").value).toBe(true);
      await control("Notion 의 그림 받기").change(false);
      await control("Notion Markdown API 쓰기").change(false);
      expect(plugin.settings).toMatchObject({ downloadMedia: false, preferMarkdownApi: false });
    });

    it("첨부 올리기 · DB 만들기 · 알림 — 없으면 CLI 기본값으로 보이고, 바꾸면 적는다", async () => {
      const { row, control } = display();
      expect(control("첨부 파일 올리기").value).toBe(true);
      expect(control("DB 정의가 있는 폴더를 Notion DB 로 만들기").value).toBe(true);
      expect(row("DB 정의가 있는 폴더를 Notion DB 로 만들기").desc).toContain(".notion.json");
      expect(control("동기화가 쓴 페이지의 알림").options.map(([v]) => v)).toEqual([
        "silent",
        "default",
      ]);
      expect(control("동기화가 쓴 페이지의 알림").value).toBe("silent");

      await control("첨부 파일 올리기").change(false);
      await control("DB 정의가 있는 폴더를 Notion DB 로 만들기").change(false);
      await control("동기화가 쓴 페이지의 알림").change("default");
      expect(plugin.settings).toMatchObject({
        syncFiles: false,
        createDatabases: false,
        notifications: "default",
      });
    });

    it("DB 모드 — 주소를 붙여 넣으면 ID 로 적고, 알아볼 수 없으면 페이지 모드라고 알린다", async () => {
      const { row, control } = display();
      expect(row("DB 모드").desc).toContain("루트 페이지 아래 페이지로 둡니다(기본)");
      await control("DB 모드").change(
        "https://www.notion.so/team/Tasks-35a13b18d38280cf9057e37e6e473e41?v=abc",
      );
      expect(plugin.settings.databaseId).toBe("35a13b18-d382-80cf-9057-e37e6e473e41");
      expect(row("DB 모드").desc).toContain("의 행으로 둡니다");
      await control("DB 모드").change("Tasks");
      expect(row("DB 모드").desc).toContain("페이지 모드로 동기화합니다");
      expect(row("DB 모드").descEl.classes.has("mod-warning")).toBe(true);
    });

    it("더 받는 DB — 추가 · ID · 폴더를 적고, 덜 채운 줄은 까닭을 보이고, 지우기는 그 줄만 뺀다", async () => {
      const { control } = display();
      await control("더 받는 DB 추가").click();
      expect(plugin.settings.databases).toEqual([{ databaseId: "", localFolder: "" }]);

      const { row, control: again } = display();
      expect(row("더 받는 DB 1").descEl.classes.has("mod-warning")).toBe(true);
      await again("더 받는 DB 1").change(
        "https://www.notion.so/x/1fa13b18d38280cf9057e37e6e473e41",
      );
      expect(row("더 받는 DB 1").desc).toContain("볼트 폴더를 아래에 적으세요");
      await again("더 받는 DB 1 — 볼트 폴더").change("/Projects/Tasks/");
      expect(plugin.settings.databases).toEqual([
        { databaseId: "1fa13b18-d382-80cf-9057-e37e6e473e41", localFolder: "Projects/Tasks" },
      ]);
      expect(row("더 받는 DB 1").desc).toContain("「Projects/Tasks」 폴더에 둡니다");
      expect(row("더 받는 DB 1").descEl.classes.has("mod-warning")).toBe(false);

      await row("더 받는 DB 1").controls[1]!.click();
      expect(plugin.settings.databases).toEqual([]);
      settingTab.hide();
      expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
    });
  });

  describe("폴더 연결 (ADR-038)", () => {
    it("폴더는 고르개다 — 점 폴더 · 볼트 연결이 이미 동기화하는 폴더 · 다른 연결의 폴더는 고를 수 없다", async () => {
      plugin.settings.connections = [{ folder: "Work/Team", tokenSecret: "", rootPageId: "" }];
      const { control } = display();

      await control("폴더 연결 추가").click();
      expect(plugin.settings.connections[1]).toEqual({
        folder: "Work",
        tokenSecret: "",
        rootPageId: "",
      });
      const { control: again } = display();
      expect(again("폴더 연결 2").options.map(([v]) => v)).toEqual(["Work"]);
      expect(again("폴더 연결 1").options.map(([v]) => v)).toEqual(["Work/Team"]);
      // 닫을 때 한 번 다시 연결한다
      expect(plugin.initOrchestrator).not.toHaveBeenCalled();
      settingTab.hide();
      expect(plugin.initOrchestrator).toHaveBeenCalledTimes(1);
    });

    it("토큰 · 루트 페이지를 연결마다 따로 적고, 주소는 ID 로 읽는다", async () => {
      plugin.settings.connections = [{ folder: "Work", tokenSecret: "", rootPageId: "" }];
      const { control } = display();
      expect(control("폴더 연결 1 — Notion 토큰").kind).toBe("secret");

      await control("폴더 연결 1 — Notion 토큰").change("work-token");
      await control("폴더 연결 1 — 루트 페이지 ID").change(
        " https://www.notion.so/team/회의-35a13b18d38280cf9057e37e6e473e41 ",
      );

      expect(plugin.settings.connections[0]).toEqual({
        folder: "Work",
        tokenSecret: "work-token",
        rootPageId: "35a13b18-d382-80cf-9057-e37e6e473e41",
      });
      // 볼트 연결의 설정은 그대로다
      expect(plugin.settings.tokenSecret).toBe("im-nobsidian-notion-token");
    });

    it("폴더 연결도 제 경로 패턴을 따로 적는다 — 볼트 연결의 패턴은 그대로다", async () => {
      plugin.settings.connections = [{ folder: "Work", tokenSecret: "", rootPageId: "" }];
      const { control } = display();

      await control("폴더 연결 1 — 제외 패턴").change("drafts\n");

      expect(plugin.settings.connections[0]!.excludePaths).toEqual(["drafts"]);
      expect(plugin.settings.excludePaths).toBeUndefined();
    });

    it("볼트 연결이 노트를 동기화하던 폴더를 (밖에서) 적어 두었으면 따로 연결하지 않는다고 알린다", () => {
      plugin.settings.connections = [{ folder: "개인", tokenSecret: "t", rootPageId: "r" }];
      const { row } = display();
      expect(row("폴더 연결 1").desc).toContain(
        "이 폴더를 맡은 연결이 노트 3개를 이미 동기화하고 있어 따로 연결하지 않습니다",
      );
      expect(row("폴더 연결 1").descEl.classes.has("mod-warning")).toBe(true);
    });

    it("지우기는 그 연결만 설정에서 뺀다", async () => {
      plugin.settings.connections = [
        { folder: "Work", tokenSecret: "a", rootPageId: "" },
        { folder: "Work/Team", tokenSecret: "b", rootPageId: "" },
      ];
      const { row } = display();
      await button(row("폴더 연결 1"), "지우기").click();
      expect(plugin.settings.connections.map((c) => c.folder)).toEqual(["Work/Team"]);
    });

    it("폴더 연결마다 Notion 확인 — 그 연결의 토큰 · 루트 페이지를 묻는다", async () => {
      plugin.settings.connections = [{ folder: "Work", tokenSecret: "a", rootPageId: "r" }];
      plugin.checkNotionAccess.mockResolvedValue({
        ok: false,
        lines: ["토큰이 맞지 않습니다 — 다시 복사해 넣으세요."],
      });
      const { row } = display();
      await button(row("폴더 연결 1"), "Notion 확인").click();
      expect(plugin.checkNotionAccess).toHaveBeenCalledWith("Work");
      expect(row("폴더 연결 1").desc).toBe("토큰이 맞지 않습니다 — 다시 복사해 넣으세요.");
      expect(row("폴더 연결 1").descEl.classes.has("mod-warning")).toBe(true);
    });

    it("CLI 로 만든 연결 폴더는 플러그인이 비켜 간다고 알린다", () => {
      plugin.knownConnectionFolders = ["", "Archive"];
      const { row } = display();
      expect(row("CLI 로 만든 연결").desc).toContain(
        "Archive — 플러그인은 동기화하지 않고 비켜 갑니다",
      );
    });
  });
});
