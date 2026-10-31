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
import { Notice, TFile, TFolder } from "obsidian";

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

/** 만든 오케스트레이터마다 받은 것(설정 · 상태 DB · 클라이언트 · 볼트) — 연결마다 무엇을 넘겼는지 본다. */
const orchestratorArgs = vi.hoisted(() => [] as unknown[][]);

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
      notionIdFromInput: core.notionIdFromInput,
      DEFAULT_TITLE_PROPERTY: core.DEFAULT_TITLE_PROPERTY,
      compactNotionId: core.compactNotionId,
      isMarkdownPath: core.isMarkdownPath,
      // 볼트 안 연결 폴더(ADR-038) — 찾기 · 경로 나누기는 진짜를 쓴다
      findConnectionFolders: core.findConnectionFolders,
      connectionFolderOf: core.connectionFolderOf,
      configDirFrom: core.configDirFrom,
      normalizeVaultPath: core.normalizeVaultPath,
      ScopedVaultFS: core.ScopedVaultFS,
      // 경로 패턴 — 거르기 · 제외 파일 읽기는 진짜를 쓴다
      FilteredVaultFS: core.FilteredVaultFS,
      PathFilter: core.PathFilter,
      IGNORE_FILE: core.IGNORE_FILE,
      parseIgnorePatterns: core.parseIgnorePatterns,
      // 플러그인 기본 설정은 core 의 기본값을 읽는다 — 손으로 적은 사본이면 둘이 갈라져도 모른다
      DEFAULT_CONFIG: core.DEFAULT_CONFIG,
      DEFAULT_WATCH_DEBOUNCE_MS: core.DEFAULT_WATCH_DEBOUNCE_MS,
    }))),
  NotionClient: class {
    constructor() {}
    static fromConfig() {
      return {};
    }
  },
  SyncOrchestrator: class {
    constructor(...args: unknown[]) {
      orchestratorArgs.push(args);
    }
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
}));

import ImNobsidianPlugin from "../src/main.js";
import {
  NotionClient,
  SavedStateDbError,
  StateLock,
  getLogger,
  setLogger,
  stateDbLockPath,
  type Config,
} from "@im-nobsidian/core";
import { SqlJsStateDB } from "../src/state/sqljs-state-db.js";
import { ConnectionEngine } from "../src/connection/connection-engine.js";
import { FilteredVaultFS, IGNORE_FILE, ScopedVaultFS, type OutsideVault } from "@im-nobsidian/core";
import { StateDbCopyStaleError, StateDbFile } from "../src/state/state-db-file.js";
import sqlJsWasm from "sql.js/dist/sql-wasm-browser.wasm";

/** 루트 페이지 — 설정은 Notion 페이지 ID 여야 연결한다(D1). */
const ROOT_PAGE_ID = "0123456789abcdef0123456789abcdef";

/** Obsidian 키체인(SecretStorage) — 이름 → 비밀. 시험이 무엇을 넣었는지 본다. */
function keychain(entries: Record<string, string> = {}) {
  const secrets = new Map(Object.entries(entries));
  return {
    secrets,
    getSecret: (id: string) => secrets.get(id) ?? null,
    setSecret: vi.fn((id: string, secret: string) => void secrets.set(id, secret)),
    listSecrets: () => [...secrets.keys()],
  };
}

/**
 * 설정을 다 채운 플러그인 — 상태 DB 파일은 `readBinary` 가 읽는다. 볼트에는 플러그인 폴더도 sql.js wasm 도 없다:
 * 디렉터리는 main.js · manifest.json · styles.css 만 받는다(U-04).
 */
function pluginWithStateFile(readBinary: () => Promise<ArrayBuffer>) {
  const plugin = new ImNobsidianPlugin({} as never, {} as never);
  plugin.settings = { ...plugin.settings, tokenSecret: "notion", rootPageId: ROOT_PAGE_ID };
  const vaultPath = mkdtempSync(join(tmpdir(), "im-nobsidian-main-"));
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
    secretStorage: keychain({ notion: "ntn_test" }),
    vault: {
      adapter: {
        basePath: vaultPath,
        // 상태 DB 는 `readBinary` 가 준다 — 제외 파일(.im-nobsidian-ignore)만 볼트 폴더에서 찾는다.
        exists: async (path: string) =>
          !path.endsWith(IGNORE_FILE) || existsSync(join(vaultPath, path)),
        read: async (path: string) => readFileSync(join(vaultPath, path), "utf-8"),
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
    plugin.settings.rootPageId = ROOT_PAGE_ID;
    await expect(plugin.saveSettings()).resolves.not.toThrow();
    // 기본값은 플러그인마다 사본이다 — 고친 값이 다음 플러그인으로 새지 않는다
    expect(new ImNobsidianPlugin({} as never, {} as never).settings.rootPageId).toBe("");
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

  it("SQLite 엔진은 main.js 에 실린 wasm 으로 띄운다 — 플러그인 폴더에 네 번째 파일이 없어도 연다 (U-04)", async () => {
    // 예전에는 `<볼트>/.obsidian/plugins/<id>/sql-wasm.wasm` 을 읽었다. 디렉터리 설치에는 그 파일이 없고,
    // 설정 폴더를 바꾼 볼트(`Vault#configDir`)에서는 경로부터 틀렸다.
    const { plugin, internals } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
    vi.mocked(SqlJsStateDB.open).mockClear();

    await plugin.initOrchestrator();

    expect(internals.initFailure).toBeNull();
    const engine = vi.mocked(SqlJsStateDB.open).mock.calls[0]![2];
    // toBe 는 실패할 때 1MB 바이트를 모두 찍는다 — 같은 객체인지만 본다
    expect(engine === sqlJsWasm, "main.js 에 실린 wasm 을 넘긴다").toBe(true);
    // wasm 머리(\0asm) — 빈 버퍼 · 다른 파일이 아니다
    expect([...new Uint8Array(engine as Uint8Array).subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);
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
    plugin.settings = { ...plugin.settings, tokenSecret: "notion" };
    await internals.executePush();
    plugin.settings = { ...plugin.settings, rootPageId: "root" };
    await internals.executePush();
    plugin.settings = { ...plugin.settings, rootPageId: ROOT_PAGE_ID };
    await internals.executePush();

    // 무엇이 비었는지 말한다 — 예전에는 「설정을 먼저 완료해주세요」 뿐이었다
    expect(Notice.shown).toEqual([
      "Im-Nobsidian: 설정을 채워 주세요 — Notion 토큰 · 루트 페이지 ID",
      "Im-Nobsidian: 설정을 채워 주세요 — 루트 페이지 ID",
      "Im-Nobsidian: 설정을 채워 주세요 — 루트 페이지 ID(주소나 ID 에서 페이지 ID 를 찾지 못함)",
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
    plugin.settings = { ...plugin.settings, tokenSecret: "notion", rootPageId: ROOT_PAGE_ID };
    // 볼트가 없어 초기화는 실패한다 — 차례만 본다. 실패 이유는 변경 패널에도 보내므로 작업 공간은 둔다.
    (plugin as unknown as { app: unknown }).app = {
      secretStorage: keychain({ notion: "ntn_test" }),
      workspace: { getLeavesOfType: () => [] },
    };
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
      [undefined, { force: true, rerender: false }],
      [undefined, { force: false, rerender: false }],
    ]);
  });

  it("동기화가 쓴 노트의 볼트 이벤트는 동기화를 다시 부르지 않는다 — 사용자의 편집만 부른다 (D4)", () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const handlers = new Map<string, (file: { path: string }, oldPath?: string) => void>();
    const scheduled: string[] = [];
    const internals = plugin as unknown as {
      app: unknown;
      syncVault: { isOwnChange: (path: string) => boolean };
      syncController: unknown;
      registerVaultEvents: () => void;
      scheduleVaultSync: () => void;
      scheduleSidebarRefresh: () => void;
    };
    internals.app = {
      vault: { on: (name: string, handler: never) => void handlers.set(name, handler) },
    };
    internals.syncVault = { isOwnChange: (path) => path.startsWith("받은/") };
    internals.syncController = {
      recordDelete: vi.fn(),
      onVaultRename: vi.fn(() => true),
    };
    let current = "";
    internals.scheduleVaultSync = () => void scheduled.push(current);
    const refreshed = vi.fn();
    internals.scheduleSidebarRefresh = refreshed;
    internals.registerVaultEvents();

    for (const [event, path, oldPath] of [
      ["modify", "받은/감자.md"],
      ["create", "받은/새.md"],
      ["delete", "받은/지운.md"],
      ["rename", "받은/옮긴.md", "옛/옮긴.md"],
      ["modify", "내/고친.md"],
      ["rename", "내/옮긴.md", "옛/내.md"],
    ] as const) {
      current = path;
      handlers.get(event)!({ path }, oldPath);
    }

    expect(scheduled).toEqual(["내/고친.md", "내/옮긴.md"]);
    // 목록은 늘 새로고친다 — 받은 노트도 변경 패널에서 빠져야 한다
    expect(refreshed).toHaveBeenCalledTimes(6);
  });

  it("「전체 확인」 명령은 전체 대조 Pull 을, 「Pull」 명령은 보통 Pull 을 부른다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const commands = new Map<string, () => unknown>();
    const internals = plugin as unknown as {
      addCommand: (command: { id: string; callback: () => unknown }) => void;
      executePull: (options?: { force?: boolean }) => Promise<void>;
      registerDesignRenderer: () => void;
      registerFolderMenu: () => void;
      registerVaultEvents: () => void;
    };
    internals.addCommand = (command) => commands.set(command.id, command.callback);
    // 볼트 · 편집기에 거는 것은 이 시험의 관심 밖이다 — 스텁 앱에는 없다.
    internals.registerDesignRenderer = () => {};
    internals.registerFolderMenu = () => {};
    internals.registerVaultEvents = () => {};
    const executePull = vi.fn(async () => {});
    internals.executePull = executePull;

    await plugin.onload();
    await commands.get("im-nobsidian-pull-full")!();
    await commands.get("im-nobsidian-pull")!();
    await commands.get("im-nobsidian-pull-rerender")!();

    expect(executePull.mock.calls).toEqual([[{ force: true }], [], [{ rerender: true }]]);
    plugin.onunload();
  });

  it("엔진의 경고 · 오류를 이 세션의 기록에 모으고, 내리면 원래 로거로 되돌린다", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const internals = plugin as unknown as {
      addCommand: () => void;
      registerDesignRenderer: () => void;
      registerFolderMenu: () => void;
      registerVaultEvents: () => void;
      warnings: { level: string; message: string }[];
    };
    internals.addCommand = () => {};
    internals.registerDesignRenderer = () => {};
    internals.registerFolderMenu = () => {};
    internals.registerVaultEvents = () => {};
    const previous = getLogger();
    const base = { ...previous, warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    setLogger(base);
    try {
      await plugin.onload();
      getLogger().warn("[Im-Nobsidian] DB x: 접근 가능한 data source 없음");
      getLogger().error("[DB Sync] 행을 쓰지 못함:", new Error("Notion 400"));
      getLogger().info("[Im-Nobsidian] 3개 파일 업로드 완료");

      expect(internals.warnings.map(({ level, message }) => [level, message])).toEqual([
        ["warn", "DB x: 접근 가능한 data source 없음"],
        ["error", "행을 쓰지 못함: Notion 400"],
      ]);
      // 콘솔에는 그대로 간다
      expect(base.warn).toHaveBeenCalledWith("[Im-Nobsidian] DB x: 접근 가능한 data source 없음");
      expect(base.info).toHaveBeenCalledTimes(1);

      plugin.onunload();
      expect(getLogger()).toBe(base);
    } finally {
      setLogger(previous);
    }
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
      tokenSecret: "",
      rootPageId: "",
      syncDirection: "both",
      autoSync: false,
      autoSyncInterval: 300,
      conflictStrategy: "manual",
      attachments: "attachments",
      timeZone: "",
    };
    await plugin.initOrchestrator();
  });

  describe("U-03 토큰은 키체인에 — 볼트 설정 파일에는 이름만", () => {
    /** 예전 설정(data.json)을 불러오는 플러그인. */
    function legacy(data: object, secrets = keychain()) {
      const plugin = new ImNobsidianPlugin({} as never, {} as never);
      const saved: object[] = [];
      Object.assign(plugin, {
        app: { secretStorage: secrets },
        loadData: async () => data,
        saveData: async (value: object) => void saved.push(structuredClone(value)),
      });
      Notice.shown.splice(0);
      return { plugin, saved, secrets };
    }

    it("글자 그대로 적힌 토큰을 키체인으로 옮기고 설정 파일에서 지운다", async () => {
      const { plugin, saved, secrets } = legacy({ token: "ntn_old", rootPageId: ROOT_PAGE_ID });

      await plugin.loadSettings();

      expect(secrets.secrets.get("im-nobsidian-notion-token")).toBe("ntn_old");
      expect(plugin.settings.tokenSecret).toBe("im-nobsidian-notion-token");
      expect(plugin.settings).not.toHaveProperty("token");
      expect(saved).toHaveLength(1);
      expect(JSON.stringify(saved[0])).not.toContain("ntn_old");
      expect(Notice.shown[0]).toContain("키체인(이름 im-nobsidian-notion-token)으로 옮겼습니다");
    });

    it("다른 볼트가 같은 이름에 다른 토큰을 두었으면 덮지 않고 번호를 붙인다", async () => {
      const { plugin, secrets } = legacy(
        { token: "ntn_mine", rootPageId: ROOT_PAGE_ID },
        keychain({ "im-nobsidian-notion-token": "ntn_other", "im-nobsidian-notion-token-2": "x" }),
      );

      await plugin.loadSettings();

      expect(secrets.secrets.get("im-nobsidian-notion-token")).toBe("ntn_other");
      expect(secrets.secrets.get("im-nobsidian-notion-token-3")).toBe("ntn_mine");
      expect(plugin.settings.tokenSecret).toBe("im-nobsidian-notion-token-3");
    });

    it("이미 옮긴 토큰과 같으면 그 이름을 그대로 쓴다", async () => {
      const { plugin, secrets } = legacy(
        { token: "ntn_mine", rootPageId: ROOT_PAGE_ID },
        keychain({ "im-nobsidian-notion-token": "ntn_mine" }),
      );

      await plugin.loadSettings();

      expect(plugin.settings.tokenSecret).toBe("im-nobsidian-notion-token");
      expect(secrets.listSecrets()).toEqual(["im-nobsidian-notion-token"]);
    });

    it("키체인에 넣지 못하면 토큰을 지우지 않고 까닭을 알린다", async () => {
      const secrets = keychain();
      secrets.setSecret.mockImplementation(() => {
        throw new Error("Invalid secret ID");
      });
      const { plugin, saved } = legacy({ token: "ntn_old", rootPageId: ROOT_PAGE_ID }, secrets);

      await plugin.loadSettings();

      expect(plugin.settings.token).toBe("ntn_old");
      expect(saved).toEqual([]);
      expect(Notice.shown).toEqual([
        "Im-Nobsidian: Notion 토큰을 키체인으로 옮기지 못했습니다 — Invalid secret ID",
      ]);
    });

    it("이 기기의 키체인에 토큰이 없으면 「설정을 먼저」 가 아니라 그 까닭으로 실패한다", async () => {
      const { plugin, internals } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
      internals.app = { ...(internals.app as object), secretStorage: keychain() };

      await plugin.initOrchestrator();

      expect(internals.syncController).toBeNull();
      expect(internals.initFailure).toBe(
        "초기화 실패: 이 기기의 키체인에 Notion 토큰(이름 notion)이 없습니다 — 설정에서 토큰을 넣으세요",
      );
      expect(plugin.connectionStatus()).toEqual({
        ready: false,
        message: internals.initFailure,
      });
    });
  });

  it("키체인의 토큰과 설정의 시간대로 엔진을 만든다 — 시간대가 비면 이 컴퓨터의 시간대(설정 없음)", async () => {
    const fromConfig = vi.spyOn(NotionClient, "fromConfig");
    const { plugin } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));

    await plugin.initOrchestrator();
    plugin.settings.timeZone = "America/New_York";
    await plugin.initOrchestrator();

    const configs = fromConfig.mock.calls.map(([config]) => config);
    expect(configs.map((c) => c.notion.token)).toEqual(["ntn_test", "ntn_test"]);
    expect(configs[0]!.conversion).not.toHaveProperty("timeZone");
    expect(configs[1]!.conversion).toMatchObject({ timeZone: "America/New_York" });
    expect(plugin.connectionStatus()).toEqual({
      ready: true,
      message: "준비됨 — 동기화할 수 있습니다.",
    });
  });

  it("초기화가 되면 자동 동기화 주기를 걸고, 연결 설정을 비우면 옛 연결을 닫고 주기를 푼다", async () => {
    const { plugin, internals } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
    const timers = internals as unknown as { autoSyncTimer: unknown };
    plugin.settings.autoSync = true;

    await plugin.initOrchestrator();
    expect(timers.autoSyncTimer).not.toBeNull();

    plugin.settings.rootPageId = "";
    await plugin.initOrchestrator();
    expect(timers.autoSyncTimer).toBeNull();
    expect(internals.syncController).toBeNull();
    expect(internals.stateDb).toBeNull();
  });

  it("동기화 방향이 막는 동작은 0건으로 조용히 끝내지 않고 까닭을 알린다 — 단추 · 명령 · 파일 하나", async () => {
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const controller = { push: vi.fn(async () => {}), pull: vi.fn(async () => {}) };
    const internals = plugin as unknown as {
      syncController: unknown;
      executePush: (paths?: string[]) => Promise<void>;
      executePull: (options?: { paths?: string[] }) => Promise<void>;
    };
    internals.syncController = controller;
    Notice.shown.splice(0);

    plugin.settings.syncDirection = "pull";
    await internals.executePush();
    await internals.executePush(["a.md"]);
    await internals.executePull({ paths: ["a.md"] });
    plugin.settings.syncDirection = "push";
    await internals.executePull();
    await internals.executePush(["a.md"]);

    expect(Notice.shown).toEqual([
      "Im-Nobsidian: 동기화 방향이 «Pull만» 이라 Push 하지 않습니다 — 설정에서 바꿀 수 있습니다.",
      "Im-Nobsidian: 동기화 방향이 «Pull만» 이라 Push 하지 않습니다 — 설정에서 바꿀 수 있습니다.",
      "Im-Nobsidian: 동기화 방향이 «Push만» 이라 Pull 하지 않습니다 — 설정에서 바꿀 수 있습니다.",
    ]);
    expect(controller.pull.mock.calls).toEqual([[["a.md"], { force: false, rerender: false }]]);
    expect(controller.push.mock.calls).toEqual([[["a.md"]]]);
  });

  it("사이드바 · 데이터베이스 보기에서 고른 경로는 노트일 때만 연다 — 폴더 · 없는 경로는 열지 않는다", () => {
    // 예전에는 찾은 것을 TFile 로 단언해 폴더도 openFile 에 넘겼다
    const plugin = new ImNobsidianPlugin({} as never, {} as never);
    const note = Object.assign(new TFile(), { path: "a.md" });
    const entries = new Map<string, unknown>([
      ["a.md", note],
      ["folder", Object.assign(new TFolder(), { path: "folder" })],
    ]);
    const openFile = vi.fn(() => Promise.resolve());
    const internals = plugin as unknown as { app: unknown; openVaultFile: (path: string) => void };
    internals.app = {
      vault: { getAbstractFileByPath: (path: string) => entries.get(path) ?? null },
      workspace: { getLeaf: () => ({ openFile }) },
    };

    internals.openVaultFile("folder");
    internals.openVaultFile("missing.md");
    internals.openVaultFile("a.md");

    expect(openFile.mock.calls).toEqual([[note]]);
  });

  it("default export 존재", async () => {
    const mod = await import("../src/main.js");
    expect(mod.default).toBeDefined();
  });

  describe("볼트 안 폴더 연결 (ADR-038)", () => {
    const WORK_ROOT = "fedcba9876543210fedcba9876543210";

    type Internals = {
      app: { secretStorage: unknown; vault: Record<string, unknown> };
      primary: ConnectionEngine;
      extras: ConnectionEngine[];
      connectionFolders: string[];
      activeFolder: string;
      closeExtras: () => Promise<void>;
    };

    it("폴더 연결마다 엔진을 따로 연다 — 그 폴더의 상태 DB · 토큰 · 볼트, 맨 위 연결은 그 폴더를 비켜 간다", async () => {
      const fromConfig = vi.spyOn(NotionClient, "fromConfig");
      fromConfig.mockClear();
      const { plugin, internals, vaultPath } = pluginWithStateFile(() =>
        Promise.resolve(new ArrayBuffer(0)),
      );
      const own = internals as unknown as Internals;
      own.app.secretStorage = keychain({ notion: "ntn_test", work: "ntn_work" });
      plugin.settings.connections = [
        { folder: "Work/", tokenSecret: "work", rootPageId: WORK_ROOT },
      ];
      plugin.settings.databases = [
        { databaseId: "1fa13b18d38280cf9057e37e6e473e41", localFolder: "Tasks" },
      ];
      plugin.settings.databaseId = "35a13b18d38280cf9057e37e6e473e41";
      onTestFinished(() => own.closeExtras());
      orchestratorArgs.splice(0);

      await plugin.initOrchestrator();

      expect(fromConfig.mock.calls.map(([config]) => config.notion.token)).toEqual([
        "ntn_test",
        "ntn_work",
      ]);
      // 더 받는 DB · DB 모드는 볼트 연결의 설정이다 — 폴더 연결은 제 루트 페이지만
      expect(fromConfig.mock.calls[1]![0].notion).toMatchObject({
        parentMode: "page",
        databases: [],
      });
      const [rootFs, workFs] = orchestratorArgs.map((args) => args[3] as ScopedVaultFS);
      expect(rootFs).toBeInstanceOf(ScopedVaultFS);
      expect(rootFs!.ownsPath("Work/회의.md")).toBe(false);
      expect(rootFs!.ownsPath("Workshop/a.md")).toBe(true);
      expect(workFs!.ownsPath("회의.md")).toBe(true);
      expect(workFs!.ownsPath("../개인.md")).toBe(false);
      // 볼트 전체를 보지 않는 연결은 나머지 노트의 링크도 고친다 — 그 연결의 폴더로 경로를 옮겨 견준다
      const outside = orchestratorArgs.map((args) => args[5] as OutsideVault);
      expect(outside.map((o) => o.folder)).toEqual(["", "Work"]);
      expect(outside[1]!.fs).not.toBeInstanceOf(ScopedVaultFS);
      // 그 폴더의 상태 DB 를 잠그고 연다
      expect(existsSync(join(vaultPath, "Work", ".state", "sync.db.lock"))).toBe(true);
      expect(plugin.folderConnectionStatus("Work")).toEqual({
        ready: true,
        message: "준비됨 — 동기화할 수 있습니다.",
      });
      expect(plugin.knownConnectionFolders).toEqual(["", "Work"]);
    });

    it("경로 패턴 · 연결 폴더의 .im-nobsidian-ignore 를 연결마다 댄다 — 폴더 연결은 그 폴더 기준", async () => {
      const { plugin, internals, vaultPath } = pluginWithStateFile(() =>
        Promise.resolve(new ArrayBuffer(0)),
      );
      const own = internals as unknown as Internals;
      own.app.secretStorage = keychain({ notion: "ntn_test", work: "ntn_work" });
      plugin.settings.excludePaths = ["Archive"];
      plugin.settings.connections = [
        { folder: "Work", tokenSecret: "work", rootPageId: WORK_ROOT, includePaths: ["*.md"] },
      ];
      mkdirSync(join(vaultPath, "Work"), { recursive: true });
      writeFileSync(join(vaultPath, "Work", IGNORE_FILE), "# 초안\ndrafts/\n");
      onTestFinished(() => own.closeExtras());
      orchestratorArgs.splice(0);

      await plugin.initOrchestrator();

      const [rootFs, workFs] = orchestratorArgs.map((args) => args[3] as FilteredVaultFS);
      expect(rootFs).toBeInstanceOf(FilteredVaultFS);
      expect(rootFs!.excludesPath("Archive/a.md")).toBe(true);
      expect(rootFs!.excludesPath("Notes/a.md")).toBe(false);
      // 맨 위 연결은 여전히 폴더 연결을 비켜 간다
      expect(rootFs!.ownsPath!("Work/a.md")).toBe(false);
      expect(workFs!.excludesPath("drafts/a.md")).toBe(true);
      expect(workFs!.excludesPath("drafts", "folder")).toBe(true);
      expect(workFs!.excludesPath("x.pdf")).toBe(true);
      expect(workFs!.excludesPath("회의.md")).toBe(false);
      // 볼트 연결의 패턴은 폴더 연결에 대지 않는다
      expect(workFs!.excludesPath("Archive/a.md")).toBe(false);
    });

    it("Notion 에서 바꾼 제목으로 이름 바꾸기는 설정을 따른다 — 없으면 끈다", async () => {
      const { plugin } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
      orchestratorArgs.splice(0);
      await plugin.initOrchestrator();
      expect(
        (orchestratorArgs[0]![0] as { sync: { renameOnTitleChange: boolean } }).sync
          .renameOnTitleChange,
      ).toBe(false);

      plugin.settings.renameOnTitleChange = true;
      orchestratorArgs.splice(0);
      await plugin.initOrchestrator();
      expect(
        (orchestratorArgs[0]![0] as { sync: { renameOnTitleChange: boolean } }).sync
          .renameOnTitleChange,
      ).toBe(true);
    });

    it("CLI 와 같은 설정을 엔진에 건다 — 없으면 예전 플러그인 동작(삭제 맞춤 · 그림 받기 · Markdown API) (P8)", async () => {
      const { plugin } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
      type Built = Pick<Config, "notion" | "sync" | "conversion">;
      const built = () => orchestratorArgs[0]![0] as Built;
      orchestratorArgs.splice(0);
      await plugin.initOrchestrator();
      expect(built().sync).toMatchObject({
        deleteSync: true,
        fullReconcileInterval: 3600,
        syncFiles: true,
        createDatabases: true,
        notifications: "silent",
      });
      expect(built().conversion).toMatchObject({
        imageDownload: "immediate",
        preferMarkdownApi: true,
      });
      expect(built().notion).toMatchObject({ parentMode: "page", databases: [] });
      expect(built().notion.databaseId).toBeUndefined();

      Object.assign(plugin.settings, {
        conflictStrategy: "remote-first",
        deleteSync: false,
        fullReconcileInterval: 0,
        downloadMedia: false,
        preferMarkdownApi: false,
        syncFiles: false,
        createDatabases: false,
        notifications: "default",
        databaseId: "https://www.notion.so/team/Tasks-35a13b18d38280cf9057e37e6e473e41?v=1",
        databases: [
          { databaseId: "1fa13b18d38280cf9057e37e6e473e41", localFolder: "/Projects/Tasks/" },
          // 설정 화면에서 적는 중인 줄은 쓰지 않는다
          { databaseId: "", localFolder: "Half" },
          { databaseId: "2fa13b18d38280cf9057e37e6e473e41", localFolder: " " },
        ],
      });
      orchestratorArgs.splice(0);
      await plugin.initOrchestrator();
      expect(built().sync).toMatchObject({
        conflictStrategy: "remote-first",
        deleteSync: false,
        fullReconcileInterval: 0,
        syncFiles: false,
        createDatabases: false,
        notifications: "default",
      });
      expect(built().conversion).toMatchObject({ imageDownload: "skip", preferMarkdownApi: false });
      expect(built().notion).toMatchObject({
        parentMode: "database",
        databaseId: "35a13b18-d382-80cf-9057-e37e6e473e41",
        databases: [
          {
            databaseId: "1fa13b18-d382-80cf-9057-e37e6e473e41",
            localFolder: "Projects/Tasks",
            titleProperty: "Name",
          },
        ],
      });
    });

    it("설정을 바꿔 다시 연결해도 동기화 기록이 이어진다 — 새 컨트롤러가 같은 기록에 적는다 (P8 실측)", async () => {
      const { plugin } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
      type Recorder = {
        record: (label: string, report: { summary: string; phase: string }) => void;
        syncLog: () => readonly { label: string }[];
      };
      const controller = () =>
        (plugin as unknown as { primary: { controller: Recorder } }).primary.controller;
      await plugin.initOrchestrator();
      controller().record("Pull", { summary: "Pull 완료", phase: "ready" });
      const first = controller();

      await plugin.initOrchestrator();
      expect(controller()).not.toBe(first);
      controller().record("Push", { summary: "Push 완료", phase: "ready" });
      expect(
        controller()
          .syncLog()
          .map((e) => e.label),
      ).toEqual(["Push", "Pull"]);
    });

    it("알아볼 수 없는 DB 모드 ID 는 페이지 모드로 연다", async () => {
      const { plugin } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
      plugin.settings.databaseId = "Tasks";
      orchestratorArgs.splice(0);
      await plugin.initOrchestrator();
      const { notion } = orchestratorArgs[0]![0] as Pick<Config, "notion">;
      expect(notion.parentMode).toBe("page");
      expect(notion.databaseId).toBeUndefined();
    });

    it("패턴도 제외 파일도 없으면 감싸지 않는다", async () => {
      const { plugin } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
      orchestratorArgs.splice(0);

      await plugin.initOrchestrator();

      expect(orchestratorArgs[0]![3]).not.toBeInstanceOf(FilteredVaultFS);
      // 볼트 전체를 그대로 보면 따로 볼 노트가 없다
      expect(orchestratorArgs[0]![5]).toBeUndefined();
    });

    it("한 폴더 연결이 열리지 않아도 다른 연결은 연다 — 그 연결의 까닭을 연결 이름과 함께 알린다", async () => {
      const { plugin, internals } = pluginWithStateFile(() => Promise.resolve(new ArrayBuffer(0)));
      const own = internals as unknown as Internals;
      plugin.settings.connections = [
        { folder: "Work", tokenSecret: "work", rootPageId: WORK_ROOT },
        { folder: "Team", tokenSecret: "", rootPageId: "" },
      ];
      onTestFinished(() => own.closeExtras());
      Notice.shown.splice(0);

      await plugin.initOrchestrator();

      expect(plugin.connectionStatus().ready).toBe(true);
      expect(plugin.folderConnectionStatus("Work").message).toBe(
        "초기화 실패: 이 기기의 키체인에 Notion 토큰(이름 work)이 없습니다 — 설정에서 토큰을 넣으세요",
      );
      expect(plugin.folderConnectionStatus("Team").message).toBe(
        "설정을 채워 주세요 — Notion 토큰 · 루트 페이지 ID",
      );
      expect(Notice.shown).toEqual([
        "Im-Nobsidian [Work] 초기화 실패: 이 기기의 키체인에 Notion 토큰(이름 work)이 없습니다 — 설정에서 토큰을 넣으세요",
      ]);
    });

    /** 맨 위 연결과 Work 연결 — 컨트롤러는 부른 것을 적는 가짜다. */
    function twoConnections() {
      const plugin = new ImNobsidianPlugin({} as never, {} as never);
      const own = plugin as unknown as Internals & Record<string, unknown>;
      const controller = () => ({
        push: vi.fn(async () => {}),
        pull: vi.fn(async () => {}),
        sync: vi.fn(async () => {}),
        recordDelete: vi.fn(),
        onVaultRename: vi.fn(() => true),
        prepareDatabase: vi.fn(async () => {}),
        refreshStatus: vi.fn(async () => {}),
      });
      const root = controller();
      const work = controller();
      own.primary.controller = root as never;
      const engine = new ConnectionEngine("Work", {} as never);
      engine.controller = work as never;
      own.extras = [engine];
      own.connectionFolders = ["", "Work"];
      return { plugin, own, root, work, engine };
    }

    it("명령은 연결마다 차례로 돌고, 변경 패널에서 고른 경로는 패널이 보이는 연결에만 간다", async () => {
      const { own, root, work } = twoConnections();
      const run = own as unknown as {
        executePush: (paths?: string[]) => Promise<void>;
        executePull: (options?: { paths?: string[] }) => Promise<void>;
      };

      await run.executePush();
      await run.executePull();
      own.activeFolder = "Work";
      await run.executePush(["회의.md"]);
      await run.executePull({ paths: ["회의.md"] });

      expect(root.push.mock.calls).toEqual([[undefined]]);
      expect(work.push.mock.calls).toEqual([[undefined], [["회의.md"]]]);
      expect(root.pull.mock.calls).toHaveLength(1);
      expect(work.pull.mock.calls.map(([paths]) => paths)).toEqual([undefined, ["회의.md"]]);
    });

    it("볼트 이벤트는 그 경로를 맡은 연결로, 그 연결 기준 경로로 간다 — 연결을 건너 옮기면 지운 것 · 새것", () => {
      const { own, root, work, engine } = twoConnections();
      const handlers = new Map<string, (file: { path: string }, oldPath?: string) => void>();
      own.app = {
        vault: { on: (name: string, handler: never) => void handlers.set(name, handler) },
      } as never;
      own.scheduleVaultSync = () => {};
      own.scheduleSidebarRefresh = () => {};
      (own as unknown as { registerVaultEvents: () => void }).registerVaultEvents();
      const queue = own.vaultSyncQueue as Set<ConnectionEngine>;

      handlers.get("modify")!({ path: "Work/회의.md" });
      expect([...queue]).toEqual([engine]);
      handlers.get("delete")!({ path: "Work/지운.md" });
      handlers.get("rename")!({ path: "Work/새.md" }, "Work/옛.md");
      handlers.get("rename")!({ path: "Work/옮긴.md" }, "옮긴.md");

      expect(work.recordDelete.mock.calls).toEqual([["지운.md"]]);
      expect(work.onVaultRename.mock.calls).toEqual([["옛.md", "새.md", false]]);
      // 맨 위 연결에서 Work 로 옮겼다 — 맨 위 연결에는 지운 것, Work 에는 새 노트다
      expect(root.recordDelete.mock.calls).toEqual([["옮긴.md"]]);
      expect(root.onVaultRename).not.toHaveBeenCalled();
      expect(queue.has(own.primary)).toBe(true);
    });

    it("DB 로 올릴 준비는 그 폴더를 맡은 연결이 그 연결 기준 경로로 한다 — 연결 폴더 자체는 올리지 않는다", async () => {
      const { own, work } = twoConnections();
      (own.app as unknown) = { vault: { configDir: ".obsidian" } };
      const prepare = (own as unknown as { prepareDatabase: (f: string) => Promise<void> })
        .prepareDatabase;
      Notice.shown.splice(0);

      await prepare.call(own, "Work/프로젝트");
      await prepare.call(own, "Work");

      expect(work.prepareDatabase.mock.calls).toEqual([["프로젝트", "../.obsidian"]]);
      expect(Notice.shown).toEqual([
        "Im-Nobsidian: Work 는 연결 폴더라 DB 로 올리지 않습니다 — 그 안의 노트 폴더를 고르세요.",
      ]);
    });

    it("이미 동기화하던 폴더인지는 그 폴더를 지금 맡은 연결의 기록으로 센다 — 안쪽 폴더도 그 연결 기준", () => {
      const { own, engine } = twoConnections();
      const records = (paths: string[]) => ({
        getAll: () => paths.map((obsidianPath) => ({ obsidianPath })),
      });
      own.primary.stateDb = records(["개인/a.md", "개인/b.md", "Workshop/c.md"]) as never;
      engine.stateDb = records(["Team/회의.md", "Team"]) as never;
      const plugin = own as unknown as { trackedNotesUnder: (folder: string) => number | null };

      expect(plugin.trackedNotesUnder("개인")).toBe(2);
      expect(plugin.trackedNotesUnder("Work")).toBe(0);
      expect(plugin.trackedNotesUnder("Work/Team")).toBe(1);
      engine.stateDb = null;
      expect(plugin.trackedNotesUnder("Work/Team")).toBeNull();
    });

    it("변경 패널은 고른 연결의 상태만 보이고, 상태바는 연결을 모아 가장 급한 것을 보인다", async () => {
      const { own, engine } = twoConnections();
      const patches: Record<string, unknown>[] = [];
      own.app = {
        workspace: {
          getLeavesOfType: () => [{ view: { updateState: (p: never) => patches.push(p) } }],
        },
      } as never;
      const shown: string[] = [];
      own.statusBarEl = { setText: (text: string) => shown.push(text) };
      const hooks = own as unknown as {
        onEngineState: (engine: ConnectionEngine, patch: object) => void;
        onEnginePhase: (engine: ConnectionEngine, phase: string) => void;
        selectConnection: (folder: string) => Promise<void>;
      };

      hooks.onEngineState(engine, { localChanges: [{ path: "회의.md" }] });
      expect(patches).toEqual([]);
      hooks.onEnginePhase(own.primary, "ready");
      hooks.onEnginePhase(engine, "error");
      expect(shown.at(-1)).toBe("Im-Nobsidian: Error");

      await hooks.selectConnection("Work");
      expect(patches.at(-1)).toMatchObject({
        localChanges: [{ path: "회의.md" }],
        remoteChanges: [],
        activeConnection: "Work",
        connections: [
          { folder: "", label: "볼트" },
          { folder: "Work", label: "Work" },
        ],
      });
      hooks.onEngineState(own.primary, { localChanges: [] });
      expect(patches).toHaveLength(1);
    });
  });
});
