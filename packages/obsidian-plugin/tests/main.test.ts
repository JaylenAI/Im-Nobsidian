import { describe, it, expect, vi } from "vitest";

vi.mock("svelte", () => ({
  mount: vi.fn(() => ({ $$: {} })),
  unmount: vi.fn(),
}));

vi.mock("../src/views/SyncDashboard.svelte", () => ({ default: {} }));
vi.mock("../src/views/ViewContainer.svelte", () => ({ default: {} }));

vi.mock("../src/state/sqljs-state-db.js", () => ({
  SqlJsStateDB: {
    open: vi.fn().mockResolvedValue({
      close: vi.fn(),
      flush: vi.fn(),
      getAll: vi.fn(() => []),
      getMeta: vi.fn(() => null),
      setMeta: vi.fn(),
    }),
  },
}));

vi.mock("@im-nobsidian/core", () => ({
  NotionClient: class {
    constructor() {}
  },
  SyncOrchestrator: class {
    constructor() {}
    push = vi
      .fn()
      .mockResolvedValue({ created: 0, updated: 0, deleted: 0, failed: [], duration: 0 });
    pull = vi.fn().mockResolvedValue({
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: [],
      writtenPaths: [],
      failed: [],
      duration: 0,
      imageCount: 0,
      fileCount: 0,
      linkCount: 0,
    });
    sync = vi.fn().mockResolvedValue({ push: {}, pull: {}, conflicts: [], duration: 0 });
    status = vi.fn().mockResolvedValue({
      localChanges: [],
      remoteChanges: [],
      conflicts: [],
      conflictRecords: [],
      pendingOperations: 0,
      lastSyncAt: null,
    });
  },
  ConflictResolver: class {
    constructor() {}
  },
  ViewDataProvider: class {
    constructor() {}
  },
  EntryEditor: class {
    constructor() {}
  },
  DEFAULT_CONFIG: {
    notion: { token: "", rootPageId: "", parentMode: "page", databases: [] },
    sync: { direction: "both", conflictStrategy: "manual", deleteSync: true },
    paths: { include: ["**/*"], exclude: [], attachments: "attachments" },
  },
}));

import ImNobsidianPlugin from "../src/main.js";

describe("ImNobsidianPlugin", () => {
  it("인스턴스 생성", () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    expect(plugin).toBeDefined();
  });

  it("기본 설정값", () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    expect(plugin.settings.syncDirection).toBe("both");
    expect(plugin.settings.autoSync).toBe(false);
    expect(plugin.settings.autoSyncInterval).toBe(300);
    expect(plugin.settings.conflictStrategy).toBe("manual");
    expect(plugin.settings.attachments).toBe("attachments");
  });

  it("loadSettings 호출", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    await plugin.loadSettings();
    expect(plugin.settings).toBeDefined();
  });

  it("saveSettings 에러 없이 실행", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    plugin.settings.token = "ntn_test";
    await expect(plugin.saveSettings()).resolves.not.toThrow();
  });

  it("onunload 에러 없이 실행", () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    expect(() => plugin.onunload()).not.toThrow();
  });

  it("onunload 는 도는 작업이 멈춘 뒤에 상태 DB 를 닫는다 (S-09)", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const order: string[] = [];
    let finish!: () => void;
    const internals = plugin as unknown as { syncController: unknown; stateDb: unknown };
    internals.syncController = {
      shutdown: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            order.push("shutdown");
            resolve();
          };
        }),
    };
    internals.stateDb = { close: () => order.push("close") };

    plugin.onunload();
    await vi.waitFor(() => expect(finish).toBeDefined());
    // 예전에는 도는 sync 아래에서 바로 닫았다
    expect(order).toEqual([]);

    finish();
    await vi.waitFor(() => expect(order).toEqual(["shutdown", "close"]));
  });

  it("충돌 창은 플러그인을 내리면(신호 취소) 닫히고 고르지 않은 것으로 끝난다 (S-09)", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const abort = new AbortController();
    const internals = plugin as unknown as {
      askConflictChoice: (conflict: unknown, signal: AbortSignal) => Promise<unknown>;
    };

    const asking = internals.askConflictChoice(
      { syncRecord: { obsidianPath: "a.md" } },
      abort.signal,
    );
    abort.abort();

    await expect(asking).resolves.toBeNull();
  });

  it("초기화는 차례로 돈다 — 설정을 칠 때마다 불러도 앞 초기화가 끝난 뒤에 다음이 DB 를 닫고 연다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    plugin.settings = { ...plugin.settings, token: "ntn_test", rootPageId: "root" };
    const events: string[] = [];
    let release!: () => void;
    const firstClose = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    (plugin as unknown as { closeStateDb: () => Promise<void> }).closeStateDb = async () => {
      const call = ++calls;
      events.push(`close${call}:start`);
      if (call === 1) await firstClose;
      events.push(`close${call}:end`);
    };

    const first = plugin.initOrchestrator();
    const second = plugin.initOrchestrator();
    await vi.waitFor(() => expect(events).toContain("close1:start"));
    expect(events).toEqual(["close1:start"]);

    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["close1:start", "close1:end", "close2:start", "close2:end"]);
  });

  it("자동 주기는 도는 작업이 있으면 건너뛰는 autoSync 를 부른다 — 알림을 띄우는 수동 sync 가 아니다 (S-09)", () => {
    vi.useFakeTimers();
    try {
      const plugin = new ImNobsidianPlugin({} as never, {} as never);
      plugin.settings = { ...plugin.settings, autoSync: true, autoSyncInterval: 60 };
      const controller = { autoSync: vi.fn(async () => {}), sync: vi.fn(async () => {}) };
      (plugin as unknown as { syncController: unknown }).syncController = controller;

      plugin.startAutoSync();
      vi.advanceTimersByTime(120_000);
      plugin.stopAutoSync();

      expect(controller.autoSync).toHaveBeenCalledTimes(2);
      expect(controller.sync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("token 없으면 initOrchestrator 무동작", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    plugin.settings = {
      token: "",
      rootPageId: "",
      syncDirection: "both",
      autoSync: false,
      autoSyncInterval: 300,
      conflictStrategy: "manual",
      attachments: "attachments",
    };
    await plugin.initOrchestrator();
  });

  it("default export 존재", async () => {
    const mod = await import("../src/main.js");
    expect(mod.default).toBeDefined();
  });
});
