import { describe, it, expect, vi, onTestFinished } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Notice } from "obsidian";

vi.mock("svelte", () => ({
  mount: vi.fn(() => ({ $$: {} })),
  unmount: vi.fn(),
}));

vi.mock("../src/views/SyncDashboard.svelte", () => ({ default: {} }));

/** 되돌리기 확인 창 — 열면 바로 이 답을 준다. */
const discardAnswer = vi.hoisted(() => ({ confirmed: false, asked: [] as string[] }));
vi.mock("../src/discard-confirm-modal.js", () => ({
  DiscardConfirmModal: class {
    constructor(
      _app: unknown,
      private readonly change: { path: string },
      private readonly onAnswer: (confirmed: boolean) => void,
    ) {}
    open() {
      discardAnswer.asked.push(this.change.path);
      this.onAnswer(discardAnswer.confirmed);
    }
  },
}));
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

vi.mock("@im-nobsidian/core", async () => ({
  // 상태 DB 를 쓸 수 없는 까닭과 잠금은 진짜를 쓴다 — 사용자가 보는 문구와 볼트 폴더의 잠금 파일을 그대로 본다
  ...(await vi
    .importActual<typeof import("@im-nobsidian/core")>("@im-nobsidian/core")
    .then((core) => ({
      getLogger: core.getLogger,
      setLogger: core.setLogger,
      StateDbUnavailableError: core.StateDbUnavailableError,
      SavedStateDbError: core.SavedStateDbError,
      StateDbLockedError: core.StateDbLockedError,
      StateLock: core.StateLock,
      stateDbLockPath: core.stateDbLockPath,
      assertNoPendingWal: core.assertNoPendingWal,
      pendingWalBytes: core.pendingWalBytes,
      stateDbWalPath: core.stateDbWalPath,
    }))),
  NotionClient: class {
    constructor() {}
    static fromConfig() {
      return {};
    }
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
  /** 상태 DB 파일 자리 — 볼트 폴더 안의 상대 경로. 시험은 읽기 · 쓰기가 이 자리를 쓰는지 본다. */
  STATE_DB_PATH: ".state/sync.db",
  DEFAULT_CONFIG: {
    notion: { token: "", rootPageId: "", parentMode: "page", databases: [] },
    sync: { direction: "both", conflictStrategy: "manual", deleteSync: true },
    paths: { include: ["**/*"], exclude: [], attachments: "attachments" },
  },
}));

import ImNobsidianPlugin from "../src/main.js";
import {
  SavedStateDbError,
  StateLock,
  getLogger,
  setLogger,
  stateDbLockPath,
} from "@im-nobsidian/core";
import { SqlJsStateDB } from "../src/state/sqljs-state-db.js";
import { StateDbCopyStaleError, StateDbFile } from "../src/state/state-db-file.js";
import { WASM_FILE } from "../src/constants.js";

/** 설정을 다 채운 플러그인 — 볼트 폴더에 sql.js wasm 이 있고, 상태 DB 파일은 `readBinary` 가 읽는다. */
function pluginWithStateFile(readBinary: () => Promise<ArrayBuffer>) {
  const plugin = new ImNobsidianPlugin({} as never, {} as never);
  plugin.settings = { ...plugin.settings, token: "ntn_test", rootPageId: "root" };
  const vaultPath = mkdtempSync(join(tmpdir(), "im-nobsidian-main-"));
  const pluginDir = join(vaultPath, ".obsidian", "plugins", "test-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, WASM_FILE), "");
  let reads = 0;
  const patches: unknown[] = [];
  const internals = plugin as unknown as {
    app: unknown;
    manifest: unknown;
    syncController: unknown;
    initFailure: string | null;
    initializing: Promise<void>;
    stateDb: unknown;
    stateDbFile: unknown;
    closeStateDb: () => Promise<void>;
    executePush: () => Promise<void>;
    refreshSidebarStatus: (fullCheck?: boolean) => Promise<void>;
    renderInlineView: (source: string, container: HTMLElement) => Promise<void>;
  };
  internals.manifest = { id: "test-plugin", name: "Im-Notion Sync" };
  // 연 상태 DB 를 닫아 잠금을 풀고 볼트를 지운다
  onTestFinished(async () => {
    await internals.closeStateDb().catch(() => undefined);
    rmSync(vaultPath, { recursive: true, force: true });
  });
  internals.app = {
    vault: {
      adapter: {
        basePath: vaultPath,
        exists: async () => true,
        readBinary: () => {
          reads++;
          return readBinary();
        },
      },
    },
    workspace: {
      getLeavesOfType: () => [{ view: { updateState: (patch: unknown) => patches.push(patch) } }],
    },
  };
  const dbPath = join(vaultPath, ".state", "sync.db");
  return { plugin, internals, patches, vaultPath, dbPath, reads: () => reads };
}

/** 시험 끝에 흔들리는 값(마지막 신호가 몇 초 전인지)을 가린다. */
function steady(message: string | null): string | null {
  return message?.replace(/마지막 신호 \d+초 전/, "마지막 신호 N초 전") ?? null;
}

/** 상태 DB 파일을 쥔 다른 프로그램(백신 · 클라우드 동기화)이 있을 때 읽기가 내는 오류. */
function busy(): Promise<ArrayBuffer> {
  return Promise.reject(new Error("EBUSY: resource busy or locked"));
}

const READ_FAILURE =
  "초기화 실패: 상태 DB 를 읽지 못함 (.state/sync.db): EBUSY: resource busy or locked";

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

  it("상태 DB 는 남은 쓰기를 마친 뒤에야 닫힌 것으로 본다 — 그 뒤에 같은 파일을 다시 연다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    let finishWrite!: () => void;
    const internals = plugin as unknown as { stateDb: unknown; closeStateDb: () => Promise<void> };
    internals.stateDb = { close: () => new Promise<void>((resolve) => (finishWrite = resolve)) };

    let closed = false;
    const closing = internals.closeStateDb().then(() => (closed = true));
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);

    finishWrite();
    await closing;
    expect(closed).toBe(true);
  });

  it("상태 DB 를 닫다가 못 쓰면 DB 와 잠금을 쥔 채 이유를 던진다 — 다음 초기화가 다시 닫고 푼다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const stateDb = {
      close: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("권한 없음"))
        .mockResolvedValueOnce(undefined),
    };
    const stateDbFile = { release: vi.fn() };
    const internals = plugin as unknown as {
      stateDb: unknown;
      stateDbFile: unknown;
      closeStateDb: () => Promise<void>;
    };
    internals.stateDb = stateDb;
    internals.stateDbFile = stateDbFile;

    await expect(internals.closeStateDb()).rejects.toThrow("권한 없음");
    expect(internals.stateDb).toBe(stateDb);
    // 못 쓴 기록이 남은 동안 다른 곳이 열면 그 기록을 모른다
    expect(stateDbFile.release).not.toHaveBeenCalled();

    await internals.closeStateDb();
    expect(stateDb.close).toHaveBeenCalledTimes(2);
    expect(internals.stateDb).toBeNull();
    expect(stateDbFile.release).toHaveBeenCalledTimes(1);
  });

  it("다시 불러온 플러그인은 옛 인스턴스가 상태 DB 를 다 닫고 잠금을 푼 뒤에 잡고 읽는다", async () => {
    const events: string[] = [];
    const {
      plugin: fresh,
      internals,
      dbPath,
    } = pluginWithStateFile(() => {
      events.push("새 인스턴스가 읽음");
      return Promise.resolve(new ArrayBuffer(0));
    });
    const old = new ImNobsidianPlugin({} as never, {} as never);
    let finishOld!: () => void;
    Object.assign(old, {
      stateDbFile: StateDbFile.acquire(dbPath, "Im-Notion Sync"),
      stateDb: {
        close: () =>
          new Promise<void>((resolve) => {
            finishOld = () => {
              events.push("옛 인스턴스가 닫음");
              resolve();
            };
          }),
      },
    });

    try {
      old.onunload();
      const opening = fresh.initOrchestrator();
      await vi.waitFor(() => expect(finishOld).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual([]);

      finishOld();
      await opening;

      // 먼저 잡았으면 옛 인스턴스의 잠금에 막혔고, 먼저 읽었으면 옛 인스턴스의 마지막 기록이 빠졌다
      expect(internals.initFailure).toBeNull();
      expect(events).toEqual(["옛 인스턴스가 닫음", "새 인스턴스가 읽음"]);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("im-nobsidian/state-db-closing")];
    }
  });

  it("상태 DB 파일을 읽지 못하면 빈 DB 를 열지 않는다 — 초기화 실패로 이유를 알린다", async () => {
    const { plugin, reads } = pluginWithStateFile(busy);
    vi.mocked(SqlJsStateDB.open).mockClear();
    Notice.shown.splice(0);

    await plugin.initOrchestrator();

    // 예전에는 «처음» 으로 보고 빈 DB 를 열었다 — 다음 쓰기가 파일의 동기화 기록 전체를 덮었다
    expect(reads()).toBe(1);
    expect(SqlJsStateDB.open).not.toHaveBeenCalled();
    expect(Notice.shown).toEqual([`Im-Nobsidian ${READ_FAILURE}`]);
  });

  it("초기화가 실패하면 명령 · 변경 패널 · DB 뷰가 그 이유를 보인다 — 「설정을 먼저」 가 아니다", async () => {
    const { plugin, internals, patches } = pluginWithStateFile(busy);
    await plugin.initOrchestrator();
    Notice.shown.splice(0);

    await internals.executePush();
    await internals.refreshSidebarStatus();
    const shown: unknown[] = [];
    await internals.renderInlineView("database: db1", {
      createEl: (_tag: string, options: { text: string }) => shown.push(options.text),
    } as unknown as HTMLElement);

    expect(Notice.shown).toEqual([`Im-Nobsidian ${READ_FAILURE}`]);
    // 초기화가 실패할 때 한 번, 패널을 새로고칠 때(패널을 연 것과 같다) 한 번
    expect(patches).toEqual([
      { syncState: "error", errorMessage: READ_FAILURE },
      { syncState: "error", errorMessage: READ_FAILURE },
    ]);
    expect(shown).toEqual([`Im-Nobsidian ${READ_FAILURE}`]);
  });

  it("실패한 뒤 새로고침을 누르면 초기화를 다시 해 본다 — 이제 읽히면 그 파일로 연다", async () => {
    let locked = true;
    const saved = new Uint8Array([1, 2, 3]);
    const { plugin, internals, reads } = pluginWithStateFile(() =>
      locked ? busy() : Promise.resolve(saved.buffer),
    );
    await plugin.initOrchestrator();
    locked = false;
    vi.mocked(SqlJsStateDB.open).mockClear();

    await internals.refreshSidebarStatus(true);

    expect(reads()).toBe(2);
    expect(vi.mocked(SqlJsStateDB.open).mock.calls.map((call) => call[0])).toEqual([saved]);
    expect(internals.syncController).not.toBeNull();
    expect(internals.initFailure).toBeNull();
  });

  it("상태 DB 는 볼트 폴더의 제자리에 한 번에 갈아 끼워 쓴다 — 옆 임시 파일을 남기지 않는다", async () => {
    const { plugin, vaultPath } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
    vi.mocked(SqlJsStateDB.open).mockClear();
    await plugin.initOrchestrator();
    const write = vi.mocked(SqlJsStateDB.open).mock.calls[0]![1]!;

    await write(new Uint8Array([1, 2, 3]));

    expect([...readFileSync(join(vaultPath, ".state", "sync.db"))]).toEqual([1, 2, 3]);
    // 잠금 파일은 쥔 동안 남는다
    expect(readdirSync(join(vaultPath, ".state")).sort()).toEqual(["sync.db", "sync.db.lock"]);
  });

  it("CLI 가 상태 DB 를 쥐고 있으면 열지 않고 누가 쥐었는지와 기다리는 법을 알린다 — 끝나면 새로고침으로 연다", async () => {
    const { plugin, internals, dbPath, reads } = pluginWithStateFile(() =>
      Promise.resolve(new ArrayBuffer(0)),
    );
    const cli = StateLock.acquire(stateDbLockPath(dbPath), { tool: "cli" });
    vi.mocked(SqlJsStateDB.open).mockClear();

    await plugin.initOrchestrator();

    // 예전에는 CLI 가 도는 중에 읽어, 기록이 WAL 에만 있는 파일을 «깨진 파일» 로 보고 치우라고 했다
    expect(reads()).toBe(0);
    expect(SqlJsStateDB.open).not.toHaveBeenCalled();
    expect(steady(internals.initFailure)).toBe(
      `초기화 실패: 이 볼트의 상태 DB 를 다른 곳이 쓰는 중 — CLI (pid ${process.pid}, 마지막 신호 N초 전) — ` +
        "CLI 가 끝난 뒤 동기화 사이드바에서 새로고침을 누르세요. 쓰는 곳이 없는데도 이 말이 계속 나오면 볼트 " +
        "폴더의 .im-nobsidian/sync.db.lock 을 지운 뒤 동기화 사이드바에서 새로고침을 누르세요.",
    );

    cli.release();
    await internals.refreshSidebarStatus(true);

    expect(internals.initFailure).toBeNull();
    expect(reads()).toBe(1);
  });

  it("CLI 가 남긴 기록이 WAL 에만 있으면 열지 않고 합치는 법을 알린다 — 잠금은 풀어 둔다", async () => {
    const { plugin, internals, dbPath, reads } = pluginWithStateFile(() =>
      Promise.resolve(new ArrayBuffer(0)),
    );
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(4152));

    await plugin.initOrchestrator();

    expect(reads()).toBe(0);
    expect(internals.initFailure).toBe(
      "초기화 실패: 최근 동기화 기록이 아직 .im-nobsidian/sync.db-wal 에만 있음 (4152바이트) — CLI 가 쓰는 " +
        "중이거나 끝까지 닫지 못함 — CLI 가 도는 중이면 끝난 뒤, 이미 끝났으면 볼트 폴더에서 CLI 명령 " +
        "하나(예: status)를 실행해 기록을 상태 DB 로 합친 뒤 동기화 사이드바에서 새로고침을 누르세요.",
    );
    // 쥔 채 두면 기록을 합치려고 실행한 CLI 가 막힌다
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it("상태 DB 를 쥔 동안 잠금 파일에 플러그인을 적고, 닫으면 풀어 CLI 가 바로 연다", async () => {
    const { plugin, internals, dbPath } = pluginWithStateFile(() =>
      Promise.resolve(new ArrayBuffer(0)),
    );
    await plugin.initOrchestrator();
    expect(JSON.parse(readFileSync(`${dbPath}.lock`, "utf8"))).toMatchObject({
      tool: "plugin",
      label: "Im-Notion Sync",
      pid: process.pid,
    });

    await internals.closeStateDb();

    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    StateLock.acquire(stateDbLockPath(dbPath), { tool: "cli" }).release();
  });

  it("다른 곳이 파일을 바꿨으면 쓰지 않고, 사본을 버리고 파일에서 다시 연다", async () => {
    let onDisk = new Uint8Array([1, 2, 3]);
    const { plugin, internals, dbPath } = pluginWithStateFile(() =>
      Promise.resolve(onDisk.slice().buffer),
    );
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, onDisk);
    const open = vi.mocked(SqlJsStateDB.open);
    open.mockClear();
    // 닫으면 남은 변경을 파일에 쓴다 — 진짜 사본처럼
    const discard = vi.fn(async () => true);
    open.mockImplementationOnce(
      async (_saved, write) =>
        ({ close: () => write!(new Uint8Array([9])), discard }) as unknown as SqlJsStateDB,
    );
    await plugin.initOrchestrator();
    const write = open.mock.calls[0]![1]!;
    // 잠금을 모르는 옛 CLI 가 기록을 더했다
    onDisk = new Uint8Array([1, 2, 3, 4]);
    writeFileSync(dbPath, onDisk);
    Notice.shown.splice(0);
    const previous = getLogger();
    setLogger({ ...previous, warn: vi.fn() });

    try {
      await expect(write(new Uint8Array([9]))).rejects.toThrow(StateDbCopyStaleError);
      await internals.initializing;
    } finally {
      setLogger(previous);
    }

    expect([...readFileSync(dbPath)]).toEqual([1, 2, 3, 4]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(open.mock.calls.map(([saved]) => [...(saved ?? [])])).toEqual([
      [1, 2, 3],
      [1, 2, 3, 4],
    ]);
    expect(Notice.shown).toEqual([
      "Im-Nobsidian: 이 창이 읽은 뒤에 다른 곳이 상태 DB 파일을 바꿔 파일에 쓰지 않음 — 이 창의 사본을 버리고 " +
        "파일에서 다시 엽니다. 마지막으로 파일에 쓴 뒤의 동기화 기록은 남지 않았습니다 — 그 사이 올린 노트는 " +
        "다음 push 가 페이지를 새로 만들 수 있습니다.",
    ]);
    expect(internals.initFailure).toBeNull();
  });

  it("닫다가 쓸 수 없게 된 사본은 버리고 잠금을 푼다 — 버린 변경이 없으면 잃은 것이 없다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const release = vi.fn();
    const internals = plugin as unknown as {
      stateDb: unknown;
      stateDbFile: unknown;
      closeStateDb: () => Promise<void>;
    };
    internals.stateDb = {
      close: () =>
        Promise.reject(new StateDbCopyStaleError("CLI 가 상태 DB 에 쓰는 중이라 파일에 쓰지 않음")),
      discard: async () => false,
    };
    internals.stateDbFile = { release };
    Notice.shown.splice(0);
    const previous = getLogger();
    const warn = vi.fn();
    setLogger({ ...previous, warn });

    try {
      await internals.closeStateDb();
    } finally {
      setLogger(previous);
    }

    const told =
      "Im-Nobsidian: CLI 가 상태 DB 에 쓰는 중이라 파일에 쓰지 않음 — 이 창의 사본을 버리고 파일에서 다시 엽니다.";
    expect(release).toHaveBeenCalledTimes(1);
    expect(internals.stateDb).toBeNull();
    expect(Notice.shown).toEqual([told]);
    // 알림은 사라지므로 까닭을 로그에도 남긴다
    expect(warn.mock.calls).toEqual([[told]]);
  });

  it("저장된 상태 DB 파일이 깨졌으면 치우는 법을 알린다 — 다른 실패에는 붙이지 않는다", async () => {
    const { plugin, internals } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
    const open = vi.mocked(SqlJsStateDB.open);
    open.mockRejectedValueOnce(SavedStateDbError.noTables(0));
    await plugin.initOrchestrator();
    const damaged = internals.initFailure;

    // 엔진을 띄우지 못한 것 같은 실패에 치우라고 하면 멀쩡한 기록을 치운다
    open.mockRejectedValueOnce(new Error("wasm 을 띄우지 못함"));
    await plugin.initOrchestrator();

    expect(damaged).toBe(
      "초기화 실패: 저장된 상태 DB 파일에 동기화 기록이 없음 (0바이트) — 볼트 폴더의 .im-nobsidian/sync.db 를 " +
        "사본으로 바꾸거나 다른 곳으로 옮긴 뒤 동기화 사이드바에서 새로고침을 누르세요. 옮기면 처음부터 " +
        "시작합니다 — 노트와 Notion 페이지의 짝을 잃어 다음 push 가 페이지를 새로 만듭니다.",
    );
    expect(internals.initFailure).toBe("초기화 실패: wasm 을 띄우지 못함");
  });

  it("동기화할 수 없는 까닭을 가린다 — 설정이 비었으면 설정, 초기화 중이면 준비 중", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const internals = plugin as unknown as { executePush: () => Promise<void> };
    Notice.shown.splice(0);

    await internals.executePush();
    plugin.settings = { ...plugin.settings, token: "ntn_test", rootPageId: "root" };
    await internals.executePush();

    expect(Notice.shown).toEqual([
      "Im-Nobsidian: 설정을 먼저 완료해주세요.",
      "Im-Nobsidian: 아직 준비 중입니다. 잠시 뒤에 다시 해 주세요.",
    ]);
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

  it("변경 패널의 되돌리기는 확인 창에서 되돌리기를 눌렀을 때만 되돌린다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const controller = { discard: vi.fn(async () => {}) };
    const internals = plugin as unknown as {
      syncController: unknown;
      discardLocal: (change: unknown) => Promise<void>;
    };
    internals.syncController = controller;
    const change = { path: "a/고친.md", type: "modified", currentHash: "h2", previousHash: "h1" };
    discardAnswer.asked = [];

    discardAnswer.confirmed = false;
    await internals.discardLocal(change);
    expect(controller.discard).not.toHaveBeenCalled();

    discardAnswer.confirmed = true;
    await internals.discardLocal(change);
    expect(controller.discard.mock.calls).toEqual([["a/고친.md"]]);
    expect(discardAnswer.asked).toEqual(["a/고친.md", "a/고친.md"]);
  });

  it("초기화는 차례로 돈다 — 설정을 칠 때마다 불러도 앞 초기화가 끝난 뒤에 다음이 DB 를 닫고 연다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    plugin.settings = { ...plugin.settings, token: "ntn_test", rootPageId: "root" };
    // 볼트가 없어 초기화는 실패한다 — 차례만 본다. 실패 이유는 변경 패널에도 보내므로 작업 공간은 둔다.
    (plugin as unknown as { app: unknown }).app = { workspace: { getLeavesOfType: () => [] } };
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

  it("전체 확인 Pull 은 원격을 전체 대조하라고 넘긴다 — 보통 Pull 은 넘기지 않는다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const controller = { pull: vi.fn(async () => {}) };
    const internals = plugin as unknown as {
      syncController: unknown;
      executePull: (options?: { force?: boolean }) => Promise<void>;
    };
    internals.syncController = controller;

    await internals.executePull({ force: true });
    await internals.executePull();

    expect(controller.pull.mock.calls).toEqual([
      [undefined, { force: true }],
      [undefined, { force: false }],
    ]);
  });

  it("「전체 확인」 명령은 전체 대조 Pull 을, 「Pull」 명령은 보통 Pull 을 부른다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const commands = new Map<string, () => unknown>();
    const internals = plugin as unknown as {
      addCommand: (command: { id: string; callback: () => unknown }) => void;
      executePull: (options?: { force?: boolean }) => Promise<void>;
      registerColorPostProcessor: () => void;
      registerVaultEvents: () => void;
    };
    internals.addCommand = (command) => commands.set(command.id, command.callback);
    // 볼트 · 편집기에 거는 것은 이 시험의 관심 밖이다 — 스텁 앱에는 없다.
    internals.registerColorPostProcessor = () => {};
    internals.registerVaultEvents = () => {};
    const executePull = vi.fn(async () => {});
    internals.executePull = executePull;

    await plugin.onload();
    await commands.get("im-nobsidian-pull-full")!();
    await commands.get("im-nobsidian-pull")!();

    expect(executePull.mock.calls).toEqual([[{ force: true }], []]);
  });

  it("상태 알림은 마지막 전체 확인을 적고, 바뀐 것만 찾았으면 원격 삭제가 언제 반영되는지 덧붙인다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const status = (remoteScan: object, lastFullScanAt: string | null) => ({
      lastSyncAt: null,
      lastFullScanAt,
      localChanges: [],
      remoteChanges: [{ pageId: "p1", type: "modified" }],
      pendingOperations: 0,
      remoteScan,
    });
    const controller = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(
          status(
            { kind: "incremental", lastFullAt: null, nextFullAt: null, deletionsDeferred: true },
            null,
          ),
        )
        .mockResolvedValueOnce(
          status(
            {
              kind: "full",
              reason: "every-pull",
              lastFullAt: null,
              nextFullAt: null,
              deletionsDeferred: false,
            },
            "2026-09-28T01:05:00.000Z",
          ),
        ),
    };
    const internals = plugin as unknown as {
      syncController: unknown;
      showStatus: () => Promise<void>;
    };
    internals.syncController = controller;
    Notice.shown.splice(0);

    await internals.showStatus();
    await internals.showStatus();

    const [incremental, full] = Notice.shown;
    expect(incremental).toContain("전체 확인: 아직 안 함");
    expect(incremental).toContain("원격 변경: 1건 (Notion 에서 지운 노트는 전체 확인 때 반영)");
    expect(full).toContain(
      `마지막 전체 확인: ${new Date("2026-09-28T01:05:00.000Z").toLocaleString()}`,
    );
    expect(full).toContain("원격 변경: 1건");
    expect(full).not.toContain("전체 확인 때 반영");
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
