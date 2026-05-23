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
