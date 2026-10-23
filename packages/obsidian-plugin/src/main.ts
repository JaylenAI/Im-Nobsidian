import {
  Plugin,
  Notice,
  MarkdownRenderChild,
  requestUrl,
  requireApiVersion,
  TFile,
  TFolder,
} from "obsidian";
import { join } from "node:path";
import sqlJsWasm from "sql.js/dist/sql-wasm-browser.wasm";
import {
  NotionClient,
  SyncOrchestrator,
  DEFAULT_CONFIG,
  ViewDataProvider,
  EntryEditor,
  getLogger,
  isMarkdownPath,
  notionIdFromInput,
} from "@im-nobsidian/core";
import type {
  Config,
  Conflict,
  LocalChange,
  RemoteChange,
  ResolutionChoice,
} from "@im-nobsidian/core";
import {
  DEFAULT_WATCH_DEBOUNCE_MS,
  STATE_DB_PATH,
  StateDbUnavailableError,
} from "@im-nobsidian/core";
import { TOKEN_SECRET_ID } from "./constants.js";
import { decorateRendered } from "./design/render-dom.js";
import { decorateColumnSection } from "./design/columns.js";
import { designLivePreview } from "./design/live-preview.js";
import { SqlJsStateDB } from "./state/sqljs-state-db.js";
import { announceStateDbClose, previousStateDbClosed } from "./state/state-db-handoff.js";
import { StateDbCopyStaleError, StateDbFile } from "./state/state-db-file.js";
import { ImNobsidianSettingTab } from "./settings.js";
import { ObsidianVaultAdapter } from "./vault-adapter.js";
import { ConflictModal } from "./conflict-modal.js";
import { ChangeDiffModal } from "./change-diff-modal.js";
import { DiscardConfirmModal } from "./discard-confirm-modal.js";
import { localDiffSource, remoteDiffSource } from "./change-diff-text.js";
import { DatabaseItemView, DATABASE_VIEW_TYPE } from "./views/database-view.js";
import { SyncSidebarView, SYNC_SIDEBAR_TYPE } from "./views/sync-sidebar-view.js";
import { SyncController } from "./sync/sync-controller.js";
import { directionBlock } from "./sync/direction.js";
import type { SyncPhase, SyncStatePatch } from "./sync/sync-controller.js";

function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  }

  let body: string | ArrayBuffer | undefined;
  if (init?.body) {
    body = typeof init.body === "string" ? init.body : (init.body as ArrayBuffer);
  }

  return requestUrl({ url, method, headers, body, throw: false }).then((resp) => {
    const contentType = (
      resp.headers["content-type"] ??
      resp.headers["Content-Type"] ??
      ""
    ).toLowerCase();
    if (contentType.includes("application/json") || contentType.includes("text/")) {
      return new Response(JSON.stringify(resp.json), {
        status: resp.status,
        headers: new Headers(resp.headers),
      });
    }
    return new Response(resp.arrayBuffer, {
      status: resp.status,
      headers: new Headers(resp.headers),
    });
  });
}

interface DatabaseConfig {
  databaseId: string;
  localFolder: string;
}

export interface ImNobsidianSettings {
  /**
   * 예전 설정 — 토큰을 볼트 설정 파일(data.json)에 글자 그대로 적었다. 볼트를 git 등으로 나누면 토큰도
   * 함께 나갔다. 불러오면 키체인으로 옮기고 지운다({@link ImNobsidianPlugin.moveTokenToKeychain}).
   */
  token?: string;
  /** Obsidian 키체인(SecretStorage)에 둔 Notion 토큰의 이름 — 토큰은 이 기기에만 있다. */
  tokenSecret: string;
  rootPageId: string;
  syncDirection: Config["sync"]["direction"];
  autoSync: boolean;
  autoSyncInterval: number;
  /** 설정 화면에서 고르지 않는다 — 충돌은 사이드바에서 하나씩 푼다. */
  conflictStrategy: Config["sync"]["conflictStrategy"];
  attachments: string;
  /** 날짜시각 속성을 적고 보낼 시간대(IANA 이름). 빈 값이면 이 컴퓨터의 시간대(`conversion.timeZone`). */
  timeZone: string;
  databases?: DatabaseConfig[];
}

// 동기화 기본값은 core 설정 기본값(DEFAULT_CONFIG)을 읽는다 — CLI 와 같은 값.
const DEFAULT_SETTINGS: ImNobsidianSettings = {
  tokenSecret: "",
  rootPageId: "",
  syncDirection: DEFAULT_CONFIG.sync.direction,
  autoSync: DEFAULT_CONFIG.sync.autoSync,
  autoSyncInterval: DEFAULT_CONFIG.sync.autoSyncInterval,
  conflictStrategy: DEFAULT_CONFIG.sync.conflictStrategy,
  attachments: DEFAULT_CONFIG.paths.attachments,
  timeZone: "",
};

export default class ImNobsidianPlugin extends Plugin {
  // 사본을 둔다 — 설정을 고치면 기본값까지 바뀌었다(시험에서 앞 시험의 토큰이 뒤 시험으로 샜다)
  settings: ImNobsidianSettings = { ...DEFAULT_SETTINGS };
  private syncController: SyncController | null = null;
  private stateDb: SqlJsStateDB | null = null;
  /** 상태 DB 파일과 그 잠금 — 닫으면서 푼다({@link closeStateDb}). */
  private stateDbFile: StateDbFile | null = null;
  private statusBarEl: HTMLElement | null = null;
  private autoSyncTimer: number | null = null;
  private initializing: Promise<void> = Promise.resolve();
  private debounceTimer: number | null = null;
  /** 동기화 엔진이 쓰는 볼트 어댑터 — 그 쓰기의 볼트 이벤트를 가린다({@link scheduleVaultSyncFor}). */
  private syncVault: ObsidianVaultAdapter | null = null;
  private viewProvider: ViewDataProvider | null = null;
  private entryEditor: EntryEditor | null = null;
  /**
   * 마지막 초기화가 왜 실패했나 — 명령과 변경 패널이 이 이유를 보인다. 예전에는 설정을 다 채웠어도
   * 「설정을 먼저 완료해주세요」 라고 했고, 패널은 「준비됨 · 변경 사항 없음」 이었다.
   */
  private initFailure: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ImNobsidianSettingTab(this.app, this));

    this.addCommand({
      id: "im-nobsidian-push",
      name: "Push to Notion",
      callback: () => this.executePush(),
    });

    this.addCommand({
      id: "im-nobsidian-pull",
      name: "Pull from Notion",
      callback: () => this.executePull(),
    });

    // 동기화는 평소 바뀐 노트만 확인한다 — Notion 에서 지운 노트를 주기를 기다리지 않고 반영한다(ADR-027).
    this.addCommand({
      id: "im-nobsidian-pull-full",
      name: "Pull from Notion (전체 확인)",
      callback: () => this.executePull({ force: true }),
    });

    // 변환기가 나아져도 받아 둔 노트는 Notion 에서 바뀔 때까지 옛 모양이다 — 손으로 다시 그린다(B14).
    this.addCommand({
      id: "im-nobsidian-pull-rerender",
      name: "Pull from Notion (받아 둔 노트 다시 그리기)",
      callback: () => this.executePull({ rerender: true }),
    });

    this.addCommand({
      id: "im-nobsidian-sync",
      name: "Sync (양방향)",
      callback: () => this.executeSync(),
    });

    this.addCommand({
      id: "im-nobsidian-status",
      name: "동기화 상태 확인",
      callback: () => this.showStatus(),
    });

    this.addCommand({
      id: "im-nobsidian-resolve",
      name: "충돌 해결",
      callback: () => this.resolveConflicts(),
    });

    this.addCommand({
      id: "im-nobsidian-db-view",
      name: "DB 뷰 열기",
      callback: () => this.openDatabaseView(),
    });

    this.registerView(DATABASE_VIEW_TYPE, (leaf) => new DatabaseItemView(leaf));

    this.registerView(SYNC_SIDEBAR_TYPE, (leaf) => {
      const view = new SyncSidebarView(leaf);
      view.setActions({
        onPull: () => this.executePull(),
        onPush: () => this.executePush(),
        onSync: () => this.executeSync(),
        onRefresh: () => this.refreshSidebarStatus(true),
        onResolveConflict: () => this.resolveConflicts(),
        onCancel: () => this.cancelSync(),
        onOpenFile: (path: string) => this.openVaultFile(path),
        onPushPath: (path: string) => this.executePush([path]),
        onDiscard: (change: LocalChange) => this.discardLocal(change),
        onPullPath: (path: string) => this.executePull({ paths: [path] }),
        onShowLocalDiff: (change: LocalChange) => this.showLocalDiff(change),
        onShowRemoteDiff: (change: RemoteChange) => this.showRemoteDiff(change),
      });
      return view;
    });

    this.addRibbonIcon("refresh-cw", "Im-Notion Sync", () => {
      void this.executeSync();
    });

    this.addRibbonIcon("layout-sidebar-left", "동기화 사이드바 열기", () => {
      void this.toggleSidebar();
    });

    this.addCommand({
      id: "im-nobsidian-toggle-sidebar",
      name: "사이드바 토글",
      callback: () => this.toggleSidebar(),
    });

    this.registerMarkdownCodeBlockProcessor("im-nobsidian-view", (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      void this.renderInlineView(source.trim(), el);
    });

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("ready");

    // 자동 동기화 주기는 초기화가 성공하면 그 안에서 건다({@link createOrchestrator}).
    if (this.hasConnectionSettings()) {
      await this.initOrchestrator();
    }

    this.registerDesignRenderer();
    this.registerVaultEvents();
  }

  onunload(): void {
    this.stopAutoSync();
    this.clearVaultDebounce();
    // 도는 초기화가 있으면 그것이 연 DB 까지 닫는다. 다시 불러온 플러그인은 이 닫기가 끝난 뒤에 DB 를 연다.
    this.initializing = this.initializing.then(() => this.closeStateDb());
    announceStateDbClose(this.initializing);
    void this.initializing.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn(`[Im-Nobsidian] 상태 DB 를 닫지 못함: ${message}`);
    });
  }

  /**
   * 도는 작업을 멈추고 끝나기를 기다린 뒤, 상태 DB 의 남은 쓰기를 마치고 닫고 잠금을 푼다(S-09 · ADR-026). 예전에는
   * 도는 sync 아래에서 닫아, 그 sync 가 닫힌 DB 에 쓰다 실패했다. 쓰기도 기다리지 않아, 같은 파일을 다시 여는 쪽이
   * 옛 기록을 읽을 수 있었다. 못 쓰면 DB 와 잠금을 쥔 채 이유를 던진다 — 다음 초기화가 다시 닫는다.
   *
   * 다른 곳이 파일을 바꿔 쓰지 않은 것이면 다시 해도 쓸 수 없다 — 사본을 버리고 알린다. 다음 초기화가 파일에서
   * 다시 연다.
   */
  private async closeStateDb(): Promise<void> {
    const controller = this.syncController;
    const stateDb = this.stateDb;
    const stateDbFile = this.stateDbFile;
    this.syncController = null;
    this.stateDb = null;
    this.stateDbFile = null;
    await controller?.shutdown();
    try {
      await stateDb?.close();
    } catch (error) {
      if (!(error instanceof StateDbCopyStaleError) || !stateDb) {
        this.stateDb = stateDb;
        this.stateDbFile = stateDbFile;
        throw error;
      }
      await this.dropStaleCopy(stateDb, error);
    }
    stateDbFile?.release();
  }

  /** 쓸 수 없게 된 사본을 버리고 알린다 — 버린 기록이 있으면 무엇을 잃었는지까지. */
  private async dropStaleCopy(stateDb: SqlJsStateDB, error: StateDbCopyStaleError): Promise<void> {
    const dropped = await stateDb.discard();
    const lost = dropped
      ? " 마지막으로 파일에 쓴 뒤의 동기화 기록은 남지 않았습니다 — 그 사이 올린 노트는 다음 push 가 페이지를 " +
        "새로 만들 수 있습니다."
      : "";
    const message = `Im-Nobsidian: ${error.message} — 이 창의 사본을 버리고 파일에서 다시 엽니다.${lost}`;
    getLogger().warn(message);
    // 잃은 기록이 있으면 사용자가 닫을 때까지 둔다
    new Notice(message, dropped ? 0 : undefined);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<ImNobsidianSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
    await this.moveTokenToKeychain();
  }

  /**
   * 예전 설정의 토큰(data.json 에 글자 그대로)을 키체인으로 옮긴다 (U-03). 옮기지 못하면 그대로 두고 까닭을
   * 알린다 — 지우면 토큰을 잃는다.
   */
  private async moveTokenToKeychain(): Promise<void> {
    const token = this.settings.token;
    if (!token) return;
    const secrets = this.app.secretStorage;
    let id = this.settings.tokenSecret || TOKEN_SECRET_ID;
    // 사용자가 이 볼트의 키체인에 같은 이름으로 다른 토큰을 두었으면 덮지 않는다. 키체인은 볼트마다 따로다
    // (앱이 볼트 ID 를 붙여 저장한다 — 새 볼트 창의 비밀 목록은 비어 있다, 실측 1.13.7).
    for (let n = 2; ; n++) {
      const held = secrets.getSecret(id);
      if (held === null || held === token) break;
      id = `${TOKEN_SECRET_ID}-${n}`;
    }
    try {
      secrets.setSecret(id, token);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      new Notice(`Im-Nobsidian: Notion 토큰을 키체인으로 옮기지 못했습니다 — ${reason}`);
      return;
    }
    this.settings.tokenSecret = id;
    delete this.settings.token;
    await this.saveSettings();
    new Notice(
      `Im-Nobsidian: Notion 토큰을 Obsidian 키체인(이름 ${id})으로 옮겼습니다. ` +
        "볼트 설정 파일에는 이제 이름만 남습니다 — 다른 기기에서는 설정에서 토큰을 한 번 더 넣으세요.",
      0,
    );
  }

  /** 키체인에서 읽은 Notion 토큰 — 이름이 없거나 이 기기의 키체인에 없으면 null. */
  private notionToken(): string | null {
    if (!this.settings.tokenSecret) return null;
    return this.app.secretStorage.getSecret(this.settings.tokenSecret);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 설정으로 오케스트레이터를 새로 만든다. 설정 창은 닫힐 때 연결 설정이 바뀌었으면 부른다 — 차례로 돌려,
   * 앞 초기화가 연 DB 를 뒤 초기화가 모르고 새로 여는 일이 없게 한다.
   */
  initOrchestrator(): Promise<void> {
    this.initializing = this.initializing.then(() => this.createOrchestrator());
    return this.initializing;
  }

  /** Notion 에 닿을 설정(토큰 이름 · 루트 페이지)을 다 채웠나. */
  private hasConnectionSettings(): boolean {
    return this.missingSettings().length === 0;
  }

  /**
   * 비어 있거나 알아볼 수 없는 연결 설정 — 「설정을 먼저」 대신 무엇을 넣어야 하는지 말한다. 루트 페이지에서 ID 를
   * 찾지 못하면 연결하지 않는다 — 연결하면 첫 동기화가 Notion 의 검증 오류로 끝난다.
   */
  private missingSettings(): string[] {
    const { tokenSecret, rootPageId } = this.settings;
    return [
      ...(tokenSecret ? [] : ["Notion 토큰"]),
      ...(rootPageId === ""
        ? ["루트 페이지 ID"]
        : notionIdFromInput(rootPageId) !== null
          ? []
          : ["루트 페이지 ID(주소나 ID 에서 페이지 ID 를 찾지 못함)"]),
    ];
  }

  /**
   * 설정 화면이 보이는 연결 상태 — 동기화 명령이 막히는 까닭({@link notReadyReason})과 같은 말이다.
   * Notion 에 묻지는 않는다 — 토큰이 맞는지는 첫 동기화가 안다.
   */
  connectionStatus(): { readonly ready: boolean; readonly message: string } {
    if (this.syncController) return { ready: true, message: "준비됨 — 동기화할 수 있습니다." };
    return { ready: false, message: this.notReadyReason().replace(/^Im-Nobsidian:? /, "") };
  }

  private async createOrchestrator(): Promise<void> {
    this.initFailure = null;
    try {
      await this.closeStateDb();
      // 연결 설정을 비웠으면 옛 연결로 계속 동기화하지 않는다
      if (!this.hasConnectionSettings()) {
        this.stopAutoSync();
        return;
      }
      const token = this.notionToken();
      if (token === null) {
        throw new Error(
          `이 기기의 키체인에 Notion 토큰(이름 ${this.settings.tokenSecret})이 없습니다 — 설정에서 토큰을 넣으세요`,
        );
      }

      const basePath = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
      const stateDb = await this.openStateDb(join(basePath, STATE_DB_PATH));

      // 동기화가 쓰는 어댑터는 따로 둔다 — 그 쓰기의 볼트 이벤트만 가린다. 보기 편집(EntryEditor)은 사용자의 편집이다.
      const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);
      this.syncVault = vaultAdapter;

      const config: Config = {
        ...DEFAULT_CONFIG,
        notion: {
          token,
          // 예전 버전은 붙여 넣은 주소를 그대로 적었다 — 연결할 때 ID 로 읽는다(위에서 읽을 수 있는지 봤다).
          rootPageId: notionIdFromInput(this.settings.rootPageId)!,
          parentMode: "page" as const,
          databases: [],
        },
        sync: {
          ...DEFAULT_CONFIG.sync,
          direction: this.settings.syncDirection,
          conflictStrategy: this.settings.conflictStrategy,
          // 플러그인은 늘 삭제를 맞춘다(README 의 deleteSync 설명) — CLI 기본값(false)과 다르다.
          deleteSync: true,
        },
        paths: {
          ...DEFAULT_CONFIG.paths,
          attachments: this.settings.attachments,
        },
        conversion: {
          ...DEFAULT_CONFIG.conversion,
          ...(this.settings.timeZone ? { timeZone: this.settings.timeZone } : {}),
        },
      };

      const client = NotionClient.fromConfig(config, obsidianFetch);

      const orchestrator = new SyncOrchestrator(
        config,
        stateDb,
        client,
        vaultAdapter,
        obsidianFetch,
      );
      // 동기화 실행은 전부 SyncController 가 담당한다. 플러그인은 Notice/사이드바/상태바
      // 표시만 훅으로 넘겨 배선하므로, sync 로직과 Obsidian UI 가 분리된다.
      this.syncController = new SyncController(
        orchestrator,
        {
          onState: (patch) => this.updateSidebar(patch),
          onNotice: (message, durationMs) => new Notice(message, durationMs),
          onStatusBar: (state) => this.updateStatusBar(state),
        },
        this.settings.syncDirection,
      );
      const viewVault = new ObsidianVaultAdapter(this.app.vault);
      this.viewProvider = new ViewDataProvider(viewVault);
      this.entryEditor = new EntryEditor(viewVault);
      this.updateStatusBar("ready");
      this.startAutoSync();
      await this.refreshSidebarStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 사용자가 풀 수 있는 실패(파일이 깨짐 · 다른 곳이 쓰는 중)에만 할 일을 붙인다 — 엔진을 띄우지 못한 것 같은
      // 다른 실패에 파일을 치우라고 하면 멀쩡한 기록을 치우게 된다.
      const guidance =
        error instanceof StateDbUnavailableError
          ? ` — ${error.guidance("동기화 사이드바에서 새로고침을 누르세요")}`
          : "";
      this.initFailure = `초기화 실패: ${message}${guidance}`;
      new Notice(`Im-Nobsidian ${this.initFailure}`);
      this.updateStatusBar("error");
      this.updateSidebar({ syncState: "error", errorMessage: this.initFailure });
    }
  }

  /**
   * 상태 DB 를 연다 — 잠금을 잡고(ADR-026) 파일을 읽는다. 잠금은 닫으면서 푼다.
   *
   * 플러그인을 다시 불러왔으면 옛 인스턴스가 DB 를 다 닫고 잠금을 푼 뒤에 잡는다 — 먼저 잡으면 그 잠금에 막히고,
   * 먼저 읽으면 옛 인스턴스의 마지막 기록이 빠진 DB 를 연다.
   */
  private async openStateDb(path: string): Promise<SqlJsStateDB> {
    await previousStateDbClosed();
    const stateDbFile = StateDbFile.acquire(path, this.manifest.name);
    let stateDb: SqlJsStateDB;
    try {
      stateDb = await SqlJsStateDB.open(
        await this.readStateDbFile(),
        // 한 번에 갈아 끼운다 — 쓰는 도중에 Obsidian 이 죽어도 파일이 잘리지 않는다.
        (data: Uint8Array) => this.writeStateDb(stateDbFile, data),
        // SQLite 엔진 — 빌드가 main.js 에 싣는다(ADR-031). 디렉터리 설치는 main.js · manifest.json · styles.css
        // 세 파일만 받으므로 플러그인 폴더의 네 번째 파일을 읽지 않는다.
        sqlJsWasm,
      );
    } catch (error) {
      stateDbFile.release();
      throw error;
    }
    this.stateDb = stateDb;
    this.stateDbFile = stateDbFile;
    return stateDb;
  }

  /**
   * 사본을 파일에 쓴다. 다른 곳이 파일을 바꿔 쓰지 않았으면 초기화를 다시 한다 — 닫으면서 사본을 버리고 파일에서
   * 다시 연다({@link closeStateDb}). 낡은 사본으로 이어 가면 다른 곳이 받아 온 노트를 새 노트로 보고 또 올린다.
   */
  private async writeStateDb(stateDbFile: StateDbFile, data: Uint8Array): Promise<void> {
    try {
      await stateDbFile.write(data);
    } catch (error) {
      // 닫는 중에 쓴 것이면(이미 내려놓은 파일) 닫는 쪽이 사본을 버린다
      if (error instanceof StateDbCopyStaleError && this.stateDbFile === stateDbFile) {
        void this.initOrchestrator();
      }
      throw error;
    }
  }

  /**
   * 상태 DB 파일을 읽는다 — 파일이 없으면(처음) null. 읽지 못하면 이유를 던진다 — 예전에는 «처음» 으로 보고 빈
   * DB 를 열어, 다음 쓰기가 파일의 동기화 기록 전체를 덮었다. 기록이 없으면 다음 push 가 모든 노트의 페이지를
   * 또 만든다.
   */
  private async readStateDbFile(): Promise<Uint8Array | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(STATE_DB_PATH))) return null;
      return new Uint8Array(await adapter.readBinary(STATE_DB_PATH));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`상태 DB 를 읽지 못함 (${STATE_DB_PATH}): ${message}`);
    }
  }

  private getSidebarView(): SyncSidebarView | null {
    const leaves = this.app.workspace.getLeavesOfType(SYNC_SIDEBAR_TYPE);
    if (leaves.length === 0) return null;
    return leaves[0]!.view as SyncSidebarView;
  }

  private updateSidebar(partial: SyncStatePatch): void {
    this.getSidebarView()?.updateState(partial);
  }

  /**
   * 변경 패널을 새로고친다. 초기화가 실패했으면 그 이유를 다시 보이고, 사용자가 새로고침을 눌렀으면(fullCheck)
   * 초기화를 다시 해 본다 — 파일을 쥔 다른 프로그램이 놓은 뒤에 다시 불러오지 않아도 된다.
   */
  private async refreshSidebarStatus(fullCheck = false): Promise<void> {
    if (this.syncController) {
      await this.syncController.refreshStatus(fullCheck);
    } else if (this.initFailure !== null) {
      if (fullCheck) await this.initOrchestrator();
      else this.updateSidebar({ syncState: "error", errorMessage: this.initFailure });
    }
  }

  private async toggleSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_SIDEBAR_TYPE);
    if (existing.length > 0) {
      existing[0]!.detach();
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: SYNC_SIDEBAR_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    await this.refreshSidebarStatus();
  }

  /** 볼트의 노트를 연다 — 그 경로가 없거나 폴더면 아무것도 하지 않는다. */
  private openVaultFile(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
  }

  startAutoSync(): void {
    this.stopAutoSync();
    if (!this.settings.autoSync || !this.syncController) return;

    // 도는 작업이 있으면 조용히 건너뛴다 — 긴 sync 동안 주기가 겹쳐 부르지 않는다(S-09).
    this.autoSyncTimer = window.setInterval(
      () => void this.syncController?.autoSync(),
      this.settings.autoSyncInterval * 1000,
    );
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  /** 디자인 마커(색 · 밑줄 · 멘션 · 블록 색 · 콜아웃 · 표)를 읽기 보기와 편집 화면에서 칠한다(U-01). */
  private registerDesignRenderer(): void {
    const options = { calloutColorIsCss: requireApiVersion("1.13.0") };
    // 읽기 보기는 마커(주석)를 그리기 전에 지운다 — 칠할 것은 그 섹션의 원문 줄로 안다.
    this.registerMarkdownPostProcessor((el, ctx) => {
      const info = ctx.getSectionInfo(el);
      if (!info) return;
      const lines = info.text.split("\n").slice(info.lineStart, info.lineEnd + 1);
      decorateRendered(el, lines, options);
      decorateColumnSection(el, info.text, info.lineStart, info.lineEnd);
    });
    this.registerEditorExtension(designLivePreview(options));
  }

  private registerVaultEvents(): void {
    const onVaultChange = (file: { path: string }) => {
      if (!isMarkdownPath(file.path)) return;
      this.scheduleVaultSyncFor(file.path);
      this.scheduleSidebarRefresh();
    };
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.syncController?.recordDelete(file.path);
        onVaultChange(file);
      }),
    );
    // 이름 변경은 옛 경로와 함께 적어 둔다 — 다음 동기화가 옮긴 노트를 짝지을 때 쓴다(S-11).
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!this.syncController?.onVaultRename(oldPath, file.path, file instanceof TFolder)) {
          return;
        }
        this.scheduleVaultSyncFor(file.path);
        this.scheduleSidebarRefresh();
      }),
    );
  }

  private sidebarRefreshTimer: number | null = null;

  private scheduleSidebarRefresh(): void {
    if (this.sidebarRefreshTimer) window.clearTimeout(this.sidebarRefreshTimer);
    this.sidebarRefreshTimer = window.setTimeout(() => {
      this.sidebarRefreshTimer = null;
      void this.refreshSidebarStatus();
    }, 500);
  }

  /** 사용자가 바꾼 것만 동기화를 부른다 — 동기화가 쓴 노트(받기 · 충돌 풀기)의 이벤트는 건너뛴다(D4). */
  private scheduleVaultSyncFor(path: string): void {
    if (this.syncVault?.isOwnChange(path)) return;
    this.scheduleVaultSync();
  }

  private scheduleVaultSync(): void {
    if (!this.settings.autoSync || !this.syncController) return;

    this.clearVaultDebounce();
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.syncController?.vaultSync();
    }, DEFAULT_WATCH_DEBOUNCE_MS);
  }

  private clearVaultDebounce(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 동기화할 수 없는 까닭 — 설정이 비었나, 초기화가 실패했나, 아직 초기화 중인가. */
  private notReadyReason(): string {
    const missing = this.missingSettings();
    if (missing.length > 0) {
      return `Im-Nobsidian: 설정을 채워 주세요 — ${missing.join(" · ")}`;
    }
    if (this.initFailure !== null) return `Im-Nobsidian ${this.initFailure}`;
    return "Im-Nobsidian: 아직 준비 중입니다. 잠시 뒤에 다시 해 주세요.";
  }

  private cancelSync(): void {
    this.syncController?.cancel();
  }

  private blockedByDirection(action: "push" | "pull"): string | null {
    const reason = directionBlock(this.settings.syncDirection, action);
    return reason === null ? null : `Im-Nobsidian: ${reason}`;
  }

  private async executePush(paths?: string[]): Promise<void> {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }
    const blocked = this.blockedByDirection("push");
    if (blocked) {
      new Notice(blocked);
      return;
    }
    await this.syncController.push(paths);
  }

  /** Pull. `force` 는 원격을 전체 대조한다 — Notion 에서 지운 노트를 바로 반영한다. */
  private async executePull({
    force = false,
    rerender = false,
    paths,
  }: {
    readonly force?: boolean;
    readonly rerender?: boolean;
    readonly paths?: string[];
  } = {}): Promise<void> {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }
    const blocked = this.blockedByDirection("pull");
    if (blocked) {
      new Notice(blocked);
      return;
    }
    await this.syncController.pull(paths, { force, rerender });
  }

  private async executeSync(): Promise<void> {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }
    await this.syncController.sync();
  }

  private async showStatus(): Promise<void> {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }

    try {
      const status = await this.syncController.getStatus();
      if (!status) return;

      const lines = [];

      if (status.lastSyncAt) {
        lines.push(`마지막 동기화: ${new Date(status.lastSyncAt).toLocaleString()}`);
      } else {
        lines.push("아직 동기화된 적 없음");
      }
      lines.push(
        status.lastFullScanAt
          ? `마지막 전체 확인: ${new Date(status.lastFullScanAt).toLocaleString()}`
          : "전체 확인: 아직 안 함",
      );

      lines.push(`로컬 변경: ${status.localChanges.length}건`);
      // 바뀐 것만 찾았으면 Notion 에서 지운 노트는 아직 원격 변경에 없다 — 없다고 읽히지 않게 적는다.
      lines.push(
        status.remoteScan?.deletionsDeferred
          ? `원격 변경: ${status.remoteChanges.length}건 (Notion 에서 지운 노트는 전체 확인 때 반영)`
          : `원격 변경: ${status.remoteChanges.length}건`,
      );

      if (status.pendingOperations > 0) {
        lines.push(`충돌/대기: ${status.pendingOperations}건`);
      }

      new Notice(`Im-Nobsidian 상태:\n${lines.join("\n")}`, 5000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`상태 확인 실패: ${msg}`);
    }
  }

  /**
   * 변경 패널에서 누른 로컬 변경 하나를 되돌린다 — 지난 동기화 뒤의 로컬 편집이 사라지므로 먼저 확인 창으로
   * 묻는다. 되돌리기를 누르지 않고 닫으면 아무것도 하지 않는다.
   */
  private async discardLocal(change: LocalChange): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) =>
      new DiscardConfirmModal(this.app, change, resolve).open(),
    );
    if (confirmed) await this.syncController?.discard(change.path);
  }

  /** 변경 패널에서 누른 로컬 변경의 줄 비교 창 — 보기만 하므로 도는 작업이 있어도 연다. */
  private showLocalDiff(change: LocalChange): void {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }
    new ChangeDiffModal(this.app, localDiffSource(change, this.syncController)).open();
  }

  /** 변경 패널에서 누른 원격 변경의 줄 비교 창 — Notion 의 지금 글을 읽어 지난 동기화 때와 견준다. */
  private showRemoteDiff(change: RemoteChange): void {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }
    const source = remoteDiffSource(change, this.syncController);
    if (!source) {
      new Notice("Im-Nobsidian: 아직 받지 않은 새 페이지라 견줄 글이 없습니다 — 받은 뒤에 보세요.");
      return;
    }
    new ChangeDiffModal(this.app, source).open();
  }

  private async resolveConflicts(): Promise<void> {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }
    await this.syncController.resolveConflicts((conflict, signal) =>
      this.askConflictChoice(conflict, signal),
    );
  }

  /**
   * 충돌 하나를 무엇으로 풀지 모달로 묻는다. 고르지 않고 닫으면 null. 플러그인을 내리면(신호
   * 취소) 창을 닫는다 — 열린 창이 DB 를 닫는 것을 붙잡지 않게.
   */
  private askConflictChoice(
    conflict: Conflict,
    signal: AbortSignal,
  ): Promise<ResolutionChoice | null> {
    return new Promise((resolve) => {
      const modal = new ConflictModal(
        this.app,
        conflict,
        resolve,
        this.settings.syncDirection !== "pull",
      );
      signal.addEventListener("abort", () => modal.close(), { once: true });
      modal.open();
    });
  }

  private updateStatusBar(state: SyncPhase): void {
    if (!this.statusBarEl) return;

    const labels: Record<string, string> = {
      ready: "Im-Nobsidian: Ready",
      syncing: "Im-Nobsidian: Syncing...",
      error: "Im-Nobsidian: Error",
      conflict: "Im-Nobsidian: Conflict",
    };

    this.statusBarEl.setText(labels[state] ?? "Im-Nobsidian");
  }

  private async openDatabaseView(): Promise<void> {
    if (!this.viewProvider) {
      new Notice(this.notReadyReason());
      return;
    }

    // 읽지 못한 보기 설정을 「설정이 없습니다(Pull 하세요)」 로 안내하지 않는다 — 까닭을 그대로 보인다.
    const allConfigs = await this.viewProvider.loadAllViewConfigs().catch((error: unknown) => {
      new Notice(`Im-Nobsidian: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!allConfigs) return;
    const dbIds = Object.keys(allConfigs);

    if (dbIds.length === 0) {
      new Notice("Im-Nobsidian: DB 뷰 설정이 없습니다. Pull을 먼저 실행해주세요.");
      return;
    }

    const databaseId = dbIds[0]!;
    const dbConfig = this.settings.databases?.find((d) => d.databaseId === databaseId);
    const folderPath = dbConfig?.localFolder ?? "";

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: DATABASE_VIEW_TYPE, active: true });

    const view = leaf.view;
    if (view instanceof DatabaseItemView) {
      await view.setViewParams({
        provider: this.viewProvider,
        databaseId,
        folderPath,
        editor: this.entryEditor ?? undefined,
      });
    }
  }

  private async renderInlineView(source: string, container: HTMLElement): Promise<void> {
    if (!this.viewProvider) {
      container.createEl("p", {
        text: this.notReadyReason(),
        cls: "im-view-error",
      });
      return;
    }

    try {
      const params = parseViewParams(source);
      if (!params.databaseId) {
        container.createEl("p", { text: "database 파라미터가 필요합니다.", cls: "im-view-error" });
        return;
      }

      const viewData = params.viewId
        ? await this.viewProvider.buildViewData(
            params.databaseId,
            params.viewId,
            params.folder ?? "",
          )
        : await this.viewProvider.buildDefaultViewData(params.databaseId, params.folder ?? "");

      if (!viewData) {
        container.createEl("p", { text: "뷰 데이터를 찾을 수 없습니다.", cls: "im-view-error" });
        return;
      }

      const { mount } = await import("svelte");
      const { default: ViewContainer } = await import("./views/ViewContainer.svelte");

      const configs = await this.viewProvider.getViewConfigs(params.databaseId);

      mount(ViewContainer, {
        target: container,
        props: {
          data: viewData,
          availableViews: configs?.views ?? [],
          onViewChange: async (viewId: string) => {
            container.empty();
            const newData = await this.viewProvider!.buildViewData(
              params.databaseId!,
              viewId,
              params.folder ?? "",
            );
            if (newData) {
              mount(ViewContainer, {
                target: container,
                props: {
                  data: newData,
                  availableViews: configs?.views ?? [],
                  onEntryClick: (entry: { path: string }) => this.openVaultFile(entry.path),
                },
              });
            }
          },
          onEntryClick: (entry: { path: string }) => this.openVaultFile(entry.path),
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      container.createEl("p", { text: `뷰 렌더링 실패: ${msg}`, cls: "im-view-error" });
    }
  }
}

interface ViewBlockParams {
  databaseId?: string;
  viewId?: string;
  folder?: string;
}

function parseViewParams(source: string): ViewBlockParams {
  const params: ViewBlockParams = {};
  for (const line of source.split("\n")) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!key || !value) continue;

    const k = key.trim().toLowerCase();
    if (k === "database") params.databaseId = value;
    else if (k === "view") params.viewId = value;
    else if (k === "folder") params.folder = value;
  }
  return params;
}
