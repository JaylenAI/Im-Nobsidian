import { Plugin, Notice, MarkdownRenderChild, requireApiVersion, TFile, TFolder } from "obsidian";
import {
  DEFAULT_CONFIG,
  configDirFrom,
  connectionFolderOf,
  findConnectionFolders,
  getLogger,
  isMarkdownPath,
  normalizeVaultPath,
  notionIdFromInput,
  sectionLinesWithHeadingMarkers,
} from "@im-nobsidian/core";
import type {
  Config,
  Conflict,
  LocalChange,
  RemoteChange,
  ResolutionChoice,
} from "@im-nobsidian/core";
import { DEFAULT_WATCH_DEBOUNCE_MS, StateDbUnavailableError } from "@im-nobsidian/core";
import { NOTICE_PREFIX, TOKEN_SECRET_ID, withoutNoticePrefix } from "./constants.js";
import { decorateRendered } from "./design/render-dom.js";
import { decorateColumnSection } from "./design/columns.js";
import { designLivePreview } from "./design/live-preview.js";
import { announceStateDbClose } from "./state/state-db-handoff.js";
import { ImNobsidianSettingTab } from "./settings.js";
import { ConflictModal } from "./conflict-modal.js";
import { ChangeDiffModal } from "./change-diff-modal.js";
import { BaseFilterFixModal } from "./base-filter-modal.js";
import { DiscardConfirmModal } from "./discard-confirm-modal.js";
import { localDiffSource, remoteDiffSource } from "./change-diff-text.js";
import { DatabaseItemView, DATABASE_VIEW_TYPE } from "./views/database-view.js";
import { SyncSidebarView, SYNC_SIDEBAR_TYPE } from "./views/sync-sidebar-view.js";
import { EMPTY_DASHBOARD_STATE } from "./sync/sync-controller.js";
import { directionBlock } from "./sync/direction.js";
import type { SyncPhase, SyncStatePatch } from "./sync/sync-controller.js";
import type { SidebarPatch } from "./views/sync-sidebar-view.js";
import { ConnectionEngine, type EngineHost } from "./connection/connection-engine.js";

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
  /**
   * 동기화할 노트 · 첨부의 경로 패턴 — CLI 의 `paths.include` · `paths.exclude` 와 같은 규칙. 비면 전부 · 아무것도
   * 빼지 않는다. 볼트 맨 위의 `.im-nobsidian-ignore` 도 함께 뺀다.
   */
  includePaths?: string[];
  excludePaths?: string[];
  /** Notion 에서 바꾼 제목으로 노트 이름을 바꾸고 링크를 고친다(`sync.renameOnTitleChange`). 없으면 끈다. */
  renameOnTitleChange?: boolean;
  databases?: DatabaseConfig[];
  /** 볼트 안 폴더마다의 다른 연결(ADR-038) — 볼트 맨 위 연결은 위의 토큰 · 루트 페이지다. */
  connections?: FolderConnectionSettings[];
}

/** 볼트 안 폴더 하나의 연결 — 그 폴더는 이 토큰 · 루트 페이지로 따로 동기화한다(ADR-038). */
export interface FolderConnectionSettings {
  /** 볼트 기준 폴더 경로. */
  folder: string;
  /** Obsidian 키체인에 둔 그 연결의 Notion 토큰 이름. */
  tokenSecret: string;
  rootPageId: string;
  /** 이 연결의 경로 패턴 — 폴더 기준. 폴더의 `.im-nobsidian-ignore` 도 함께 뺀다. */
  includePaths?: string[];
  excludePaths?: string[];
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
  /** 볼트 맨 위 연결 — 예전의 단일 연결이 그대로 이것이다. */
  private readonly primary = new ConnectionEngine("", this.engineHost());
  /** 볼트 안 폴더의 다른 연결(ADR-038) — 설정의 `connections`. */
  private extras: ConnectionEngine[] = [];
  /**
   * 볼트의 연결 폴더 전부 — 설정에 적은 것과 볼트에 `.im-nobsidian/` 를 둔 폴더(CLI 가 만든 것 포함). 동기화하지
   * 않는 폴더도 다른 연결이 비켜 가야 하므로 둘을 합친다. 마지막 초기화 때 정한다.
   */
  private connectionFolders: string[] = [""];
  /** 변경 패널이 보이는 연결. */
  private activeFolder = "";
  /** 연결마다 패널에 보낸 상태 — 패널에서 연결을 바꾸면 그 연결의 것을 다시 보인다. */
  private readonly panelStates = new Map<ConnectionEngine, SyncStatePatch>();
  /** 연결마다 상태바 단계 — 상태바는 하나라 모아서 보인다. */
  private readonly phases = new Map<ConnectionEngine, SyncPhase>();
  private statusBarEl: HTMLElement | null = null;
  private autoSyncTimer: number | null = null;
  private initializing: Promise<void> = Promise.resolve();
  private debounceTimer: number | null = null;
  /** 볼트 이벤트로 동기화를 미뤄 둔 연결 — 기다림이 끝나면 그 연결만 돈다. */
  private readonly vaultSyncQueue = new Set<ConnectionEngine>();

  // 볼트 맨 위 연결의 것 — 예전 이름 그대로 둔다(한 연결이던 때의 코드 · 시험이 이 이름으로 본다).
  private get syncController() {
    return this.primary.controller;
  }
  private set syncController(value) {
    this.primary.controller = value;
  }
  protected get stateDb() {
    return this.primary.stateDb;
  }
  protected set stateDb(value) {
    this.primary.stateDb = value;
  }
  protected get stateDbFile() {
    return this.primary.stateDbFile;
  }
  protected set stateDbFile(value) {
    this.primary.stateDbFile = value;
  }
  protected get syncVault() {
    return this.primary.syncVault;
  }
  protected set syncVault(value) {
    this.primary.syncVault = value;
  }
  /**
   * 마지막 초기화가 왜 실패했나 — 명령과 변경 패널이 이 이유를 보인다. 예전에는 설정을 다 채웠어도
   * 「설정을 먼저 완료해주세요」 라고 했고, 패널은 「준비됨 · 변경 사항 없음」 이었다.
   */
  private get initFailure(): string | null {
    return this.primary.failure;
  }
  private set initFailure(value: string | null) {
    this.primary.failure = value;
  }

  /** 엔진이 플러그인에게 받는 것. 앱 · 매니페스트는 부를 때 읽는다 — 플러그인을 만든 뒤에 채워진다. */
  private engineHost(): EngineHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 엔진은 플러그인이 만든 뒤에 채운 앱을 읽는다
    const plugin = this;
    return {
      get app() {
        return plugin.app;
      },
      get manifestName() {
        return plugin.manifest.name;
      },
      hooks: (engine) => ({
        onState: (patch) => this.onEngineState(engine, patch),
        onNotice: (message, durationMs) =>
          new Notice(
            message.startsWith(NOTICE_PREFIX)
              ? `${NOTICE_PREFIX}${engine.noticeTag}${message.slice(NOTICE_PREFIX.length)}`
              : message,
            durationMs,
          ),
        onStatusBar: (state) => this.onEnginePhase(engine, state),
        confirmBaseFilterFixes: (fixes) =>
          new Promise((resolve) => new BaseFilterFixModal(this.app, fixes, resolve).open()),
      }),
      reopen: () => void this.initOrchestrator(),
    };
  }

  /** 연결 전부 — 맨 위 연결이 먼저. */
  private get engines(): ConnectionEngine[] {
    return [this.primary, ...this.extras];
  }

  /** 동기화할 수 있는 연결. */
  private readyEngines(): ConnectionEngine[] {
    return this.engines.filter((engine) => engine.controller !== null);
  }

  /** 변경 패널이 보이는 연결 — 없어졌으면 맨 위 연결. */
  private activeEngine(): ConnectionEngine {
    return this.engines.find((engine) => engine.folder === this.activeFolder) ?? this.primary;
  }

  /** 볼트 경로를 맡은 연결과 그 연결의 경로 — 동기화할 수 있는 연결이 맡지 않으면 null. */
  private route(
    path: string,
  ): { readonly engine: ConnectionEngine; readonly local: string } | null {
    const owner = connectionFolderOf(path, this.connectionFolders);
    const engine = this.readyEngines().find((e) => e.folder === owner);
    const local = engine?.toLocal(path);
    return engine && local !== null && local !== undefined ? { engine, local } : null;
  }

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
      view.seedState(this.panelSeed());
      // 패널은 연결 하나를 보인다 — 단추도 그 연결에만 건다. 경로는 그 연결 기준이다.
      view.setActions({
        onPull: () => this.executePull({ engines: [this.activeEngine()] }),
        onPush: () => this.executePush(undefined, [this.activeEngine()]),
        onSync: () => this.executeSync([this.activeEngine()]),
        onRefresh: () => this.refreshSidebarStatus(true),
        onResolveConflict: () => this.resolveConflicts([this.activeEngine()]),
        onCancel: () => this.cancelSync(),
        onOpenFile: (path: string) => this.openVaultFile(this.activeEngine().toVault(path)),
        onPushPath: (path: string) => this.executePush([path]),
        onDiscard: (change: LocalChange) => this.discardLocal(change),
        onPullPath: (path: string) => this.executePull({ paths: [path] }),
        onShowLocalDiff: (change: LocalChange) => this.showLocalDiff(change),
        onShowRemoteDiff: (change: RemoteChange) => this.showRemoteDiff(change),
        onSelectConnection: (folder: string) => this.selectConnection(folder),
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
      void this.renderInlineView(source.trim(), el, ctx.sourcePath);
    });

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("ready");

    // 자동 동기화 주기는 초기화가 성공하면 그 안에서 건다({@link createOrchestrator}).
    if (this.hasConnectionSettings() || this.folderConnections().length > 0) {
      await this.initOrchestrator();
    }

    this.registerDesignRenderer();
    this.registerFolderMenu();
    this.registerVaultEvents();
  }

  onunload(): void {
    this.stopAutoSync();
    this.clearVaultDebounce();
    // 도는 초기화가 있으면 그것이 연 DB 까지 닫는다. 다시 불러온 플러그인은 이 닫기가 끝난 뒤에 DB 를 연다.
    this.initializing = this.initializing.then(async () => {
      await this.closeExtras();
      await this.closeStateDb();
    });
    announceStateDbClose(this.initializing);
    void this.initializing.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn(`[Im-Nobsidian] 상태 DB 를 닫지 못함: ${message}`);
    });
  }

  /** 볼트 맨 위 연결을 닫는다 — 도는 작업을 멈추고 상태 DB 의 남은 쓰기를 마친 뒤 잠금을 푼다({@link ConnectionEngine.close}). */
  private async closeStateDb(): Promise<void> {
    await this.primary.close();
  }

  /** 폴더 연결을 닫는다 — 못 닫은 연결은 까닭을 알리고 넘어간다(그 연결의 잠금은 이 창이 끝날 때 풀린다). */
  private async closeExtras(): Promise<void> {
    for (const engine of this.extras) {
      try {
        await engine.close();
      } catch (error) {
        const message = `${NOTICE_PREFIX}${engine.noticeTag}: 상태 DB 를 닫지 못함 — ${errorText(error)}`;
        getLogger().warn(message);
        new Notice(message);
      }
      this.panelStates.delete(engine);
      this.phases.delete(engine);
    }
    this.extras = [];
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
      new Notice(`${NOTICE_PREFIX}: Notion 토큰을 키체인으로 옮기지 못했습니다 — ${reason}`);
      return;
    }
    this.settings.tokenSecret = id;
    delete this.settings.token;
    await this.saveSettings();
    new Notice(
      `${NOTICE_PREFIX}: Notion 토큰을 Obsidian 키체인(이름 ${id})으로 옮겼습니다. ` +
        "볼트 설정 파일에는 이제 이름만 남습니다 — 다른 기기에서는 설정에서 토큰을 한 번 더 넣으세요.",
      0,
    );
  }

  /** 키체인에서 읽은 Notion 토큰 — 이름이 없거나 이 기기의 키체인에 없으면 null. */
  private notionToken(name: string): string | null {
    if (!name) return null;
    return this.app.secretStorage.getSecret(name);
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
  private missingSettings(
    { tokenSecret, rootPageId }: { tokenSecret: string; rootPageId: string } = this.settings,
  ): string[] {
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
    return { ready: false, message: withoutNoticePrefix(this.notReadyReason()) };
  }

  /** 폴더 연결 하나의 상태 — 설정 화면이 연결마다 보인다. */
  folderConnectionStatus(folder: string): { readonly ready: boolean; readonly message: string } {
    const engine = this.extras.find((e) => e.folder === folder);
    if (engine?.controller) return { ready: true, message: "준비됨 — 동기화할 수 있습니다." };
    return { ready: false, message: engine?.failure ?? "아직 연결하지 않았습니다." };
  }

  /** 볼트의 연결 폴더 — 설정 화면이 「이미 연결한 폴더」 를 가릴 때 쓴다. */
  get knownConnectionFolders(): readonly string[] {
    return this.connectionFolders;
  }

  /**
   * 이 폴더를 지금 맡은 연결이 그 안의 노트를 추적하나 — 그런 폴더는 따로 연결하지 않는다(ADR-038). 맡은 연결이
   * 열려 있지 않으면 알 수 없다 — null(엔진이 시작할 때 다시 막는다 — `ConnectionScopeError`).
   */
  trackedNotesUnder(folder: string): number | null {
    const owner = connectionFolderOf(
      folder,
      this.connectionFolders.filter((f) => f !== folder),
    );
    const engine = this.engines.find((e) => e.folder === owner);
    const local = engine?.toLocal(folder);
    if (!engine?.stateDb || !local) return null;
    return engine.stateDb.getAll().filter((r) => r.obsidianPath.startsWith(`${local}/`)).length;
  }

  private async createOrchestrator(): Promise<void> {
    // 연결 폴더는 한 번만 찾는다 — 볼트를 훑는다. 맨 위 · 폴더 연결 모두 이것으로 서로를 비켜 간다.
    let folders: Promise<string[]> | null = null;
    const connections = () => (folders ??= this.findConnectionFolders());
    await this.openPrimary(connections);
    await this.openExtras(connections);
    if (this.readyEngines().length === 0) this.stopAutoSync();
    else this.startAutoSync();
    // 패널이 보이는 연결이 열렸으면 목록을 채운다 — 열지 못했으면 그 까닭을 이미 보냈다
    if (this.activeEngine().controller) await this.refreshSidebarStatus();
  }

  /** 볼트의 연결 폴더 — 설정에 적은 폴더와 `.im-nobsidian/` 를 둔 폴더(CLI 가 만든 것)의 합. */
  private async findConnectionFolders(): Promise<string[]> {
    const basePath = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const found = await findConnectionFolders(basePath);
    const configured = this.folderConnections().map((c) => c.folder);
    this.connectionFolders = [...new Set(["", ...found, ...configured])];
    return this.connectionFolders;
  }

  /** 설정의 폴더 연결 — 볼트 맨 위 · 볼트 밖을 가리키는 것은 뺀다. */
  private folderConnections(): FolderConnectionSettings[] {
    return (this.settings.connections ?? []).flatMap((c) => {
      const folder = normalizeVaultPath(c.folder);
      return folder ? [{ ...c, folder }] : [];
    });
  }

  private async openPrimary(connections: () => Promise<string[]>): Promise<void> {
    this.initFailure = null;
    this.phases.delete(this.primary);
    try {
      await this.closeStateDb();
      // 연결 설정을 비웠으면 옛 연결로 계속 동기화하지 않는다
      if (!this.hasConnectionSettings()) return;
      const token = this.notionToken(this.settings.tokenSecret);
      if (token === null) {
        throw new Error(
          `이 기기의 키체인에 Notion 토큰(이름 ${this.settings.tokenSecret})이 없습니다 — 설정에서 토큰을 넣으세요`,
        );
      }
      await this.primary.open({
        token,
        rootPageId: this.settings.rootPageId,
        settings: this.settings,
        paths: { include: this.settings.includePaths, exclude: this.settings.excludePaths },
        connections: await connections(),
      });
      this.onEnginePhase(this.primary, "ready");
    } catch (error) {
      this.initFailure = initFailureText(error);
      new Notice(`${NOTICE_PREFIX} ${this.initFailure}`);
      this.onEnginePhase(this.primary, "error");
      this.onEngineState(this.primary, { syncState: "error", errorMessage: this.initFailure });
    }
  }

  /** 폴더 연결을 다시 연다 — 하나가 실패해도 나머지는 연다. */
  private async openExtras(connections: () => Promise<string[]>): Promise<void> {
    await this.closeExtras();
    for (const settings of this.folderConnections()) {
      const engine = new ConnectionEngine(settings.folder, this.engineHost());
      this.extras.push(engine);
      const missing = this.missingSettings(settings);
      if (missing.length > 0) {
        engine.failure = `설정을 채워 주세요 — ${missing.join(" · ")}`;
        continue;
      }
      try {
        const token = this.notionToken(settings.tokenSecret);
        if (token === null) {
          throw new Error(
            `이 기기의 키체인에 Notion 토큰(이름 ${settings.tokenSecret})이 없습니다 — 설정에서 토큰을 넣으세요`,
          );
        }
        await engine.open({
          token,
          rootPageId: settings.rootPageId,
          settings: this.settings,
          paths: { include: settings.includePaths, exclude: settings.excludePaths },
          connections: await connections(),
        });
        this.onEnginePhase(engine, "ready");
      } catch (error) {
        engine.failure = initFailureText(error);
        new Notice(`${NOTICE_PREFIX}${engine.noticeTag} ${engine.failure}`);
        this.onEnginePhase(engine, "error");
        this.onEngineState(engine, { syncState: "error", errorMessage: engine.failure });
      }
    }
    this.showConnections();
  }

  private getSidebarView(): SyncSidebarView | null {
    const leaves = this.app.workspace.getLeavesOfType(SYNC_SIDEBAR_TYPE);
    if (leaves.length === 0) return null;
    return leaves[0]!.view as SyncSidebarView;
  }

  private updateSidebar(partial: SidebarPatch): void {
    this.getSidebarView()?.updateState(partial);
  }

  /** 연결이 패널에 보낸 상태 — 적어 두고, 패널이 그 연결을 보이고 있으면 보낸다. */
  private onEngineState(engine: ConnectionEngine, patch: SyncStatePatch): void {
    this.panelStates.set(engine, { ...this.panelStates.get(engine), ...patch });
    if (engine === this.activeEngine()) this.updateSidebar(patch);
  }

  /** 연결의 단계 — 상태바는 하나라 모은다: 오류 › 충돌 › 동기화 중 › 준비. */
  private onEnginePhase(engine: ConnectionEngine, phase: SyncPhase): void {
    this.phases.set(engine, phase);
    const all = [...this.phases.values()];
    const order: SyncPhase[] = ["error", "conflict", "syncing"];
    this.updateStatusBar(order.find((p) => all.includes(p)) ?? "ready");
  }

  /** 패널에 연결 목록을 보낸다 — 폴더 연결이 있거나 있었을 때만(한 연결이면 예전 그대로). */
  private showConnections(): void {
    if (this.extras.length === 0 && !this.connectionsShown) return;
    this.connectionsShown = this.extras.length > 0;
    // 보이던 연결을 지웠으면 볼트 연결의 상태를 통째로 보인다 — 지운 연결의 목록을 남기지 않는다
    if (!this.engines.some((e) => e.folder === this.activeFolder)) {
      this.activeFolder = "";
      this.updateSidebar({ ...EMPTY_DASHBOARD_STATE, ...this.panelSeed() });
      return;
    }
    const { connections, activeConnection } = this.panelSeed();
    this.updateSidebar({ connections, activeConnection });
  }

  /** 새로 만든 패널이 시작할 상태 — 보이는 연결의 마지막 상태와 연결 목록. */
  private panelSeed(): SidebarPatch {
    const engine = this.activeEngine();
    return {
      ...this.panelStates.get(engine),
      connections:
        this.extras.length > 0
          ? this.engines.map((e) => ({ folder: e.folder, label: e.label }))
          : [],
      activeConnection: engine.folder,
    };
  }

  /** 패널에 연결 목록을 보냈나 — 폴더 연결을 모두 지우면 목록을 걷는다. */
  private connectionsShown = false;

  /** 패널이 보일 연결을 바꾼다 — 그 연결의 마지막 상태를 통째로 보이고 목록을 다시 읽는다. */
  private async selectConnection(folder: string): Promise<void> {
    this.activeFolder = folder;
    this.updateSidebar({ ...EMPTY_DASHBOARD_STATE, ...this.panelSeed() });
    await this.refreshSidebarStatus();
  }

  /**
   * 변경 패널을 새로고친다. 초기화가 실패했으면 그 이유를 다시 보이고, 사용자가 새로고침을 눌렀으면(fullCheck)
   * 초기화를 다시 해 본다 — 파일을 쥔 다른 프로그램이 놓은 뒤에 다시 불러오지 않아도 된다.
   */
  private async refreshSidebarStatus(fullCheck = false): Promise<void> {
    const engine = this.activeEngine();
    if (engine.controller) {
      await engine.controller.refreshStatus(fullCheck);
    } else if (engine.failure !== null) {
      if (fullCheck) await this.initOrchestrator();
      else this.updateSidebar({ syncState: "error", errorMessage: engine.failure });
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
    if (!this.settings.autoSync || this.readyEngines().length === 0) return;

    // 도는 작업이 있으면 조용히 건너뛴다 — 긴 sync 동안 주기가 겹쳐 부르지 않는다(S-09). 연결은 저마다 따로 돈다.
    this.autoSyncTimer = window.setInterval(() => {
      for (const engine of this.readyEngines()) void engine.controller?.autoSync();
    }, this.settings.autoSyncInterval * 1000);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  /** 디자인 마커(색 · 밑줄 · 멘션 · 블록 색 · 콜아웃 · 표)를 읽기 보기와 편집 화면에서 칠한다(U-01). */
  /** 볼트에서 만든 노트 폴더를 Notion DB 로 올린다(#75) — 폴더의 오른쪽 클릭 메뉴. */
  private registerFolderMenu(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder) || file.isRoot()) return;
        menu.addItem((item) =>
          item
            .setTitle("Notion DB 로 올릴 준비")
            .setIcon("database")
            .onClick(() => void this.prepareDatabase(file.path)),
        );
      }),
    );
  }

  private registerDesignRenderer(): void {
    const options = { calloutColorIsCss: requireApiVersion("1.13.0") };
    // 읽기 보기는 마커(주석)를 그리기 전에 지운다 — 칠할 것은 그 섹션의 원문 줄로 안다.
    this.registerMarkdownPostProcessor((el, ctx) => {
      const info = ctx.getSectionInfo(el);
      if (!info) return;
      const lines = sectionLinesWithHeadingMarkers(
        info.text.split("\n"),
        info.lineStart,
        info.lineEnd,
      );
      decorateRendered(el, lines, options);
      decorateColumnSection(el, info.text, info.lineStart, info.lineEnd);
    });
    this.registerEditorExtension(designLivePreview(options));
  }

  /** 볼트 이벤트는 그 경로를 맡은 연결로 보낸다 — 경로는 그 연결 기준으로 바꾼다(ADR-038). */
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
        const owner = this.route(file.path);
        owner?.engine.controller?.recordDelete(owner.local);
        onVaultChange(file);
      }),
    );
    // 이름 변경은 옛 경로와 함께 적어 둔다 — 다음 동기화가 옮긴 노트를 짝지을 때 쓴다(S-11).
    // 연결 폴더를 건너 옮겼으면 옛 연결에는 지운 것, 새 연결에는 새로 생긴 것이다.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const isFolder = file instanceof TFolder;
        const from = this.route(oldPath);
        const to = this.route(file.path);
        if (from && to && from.engine === to.engine) {
          if (!from.engine.controller?.onVaultRename(from.local, to.local, isFolder)) return;
        } else {
          if (!isFolder && !isMarkdownPath(oldPath) && !isMarkdownPath(file.path)) return;
          if (from) {
            from.engine.controller?.recordDelete(from.local);
            this.scheduleVaultSyncFor(oldPath);
          }
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

  /**
   * 사용자가 바꾼 것만 그 경로를 맡은 연결의 동기화를 부른다 — 동기화가 쓴 노트(받기 · 충돌 풀기)의 이벤트는
   * 건너뛴다(D4).
   */
  private scheduleVaultSyncFor(path: string): void {
    const owner = this.route(path);
    if (!owner || owner.engine.syncVault?.isOwnChange(path)) return;
    this.vaultSyncQueue.add(owner.engine);
    this.scheduleVaultSync();
  }

  private scheduleVaultSync(): void {
    if (!this.settings.autoSync || this.readyEngines().length === 0) return;

    this.clearVaultDebounce();
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      const engines = [...this.vaultSyncQueue];
      this.vaultSyncQueue.clear();
      for (const engine of engines) void engine.controller?.vaultSync();
    }, DEFAULT_WATCH_DEBOUNCE_MS);
  }

  private clearVaultDebounce(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * 동기화할 수 없는 까닭 — 설정이 비었나, 초기화가 실패했나, 아직 초기화 중인가. 볼트 맨 위 연결을 쓰지 않고
   * 폴더 연결만 두었으면 그 연결의 까닭을 말한다.
   */
  private notReadyReason(engine: ConnectionEngine = this.primary): string {
    if (engine === this.primary && this.missingSettings().length > 0) {
      const extra = this.extras.find((e) => e.failure !== null);
      if (extra) return this.notReadyReason(extra);
    }
    if (engine !== this.primary) {
      return engine.failure !== null
        ? `${NOTICE_PREFIX}${engine.noticeTag} ${engine.failure}`
        : `${NOTICE_PREFIX}: 아직 준비 중입니다. 잠시 뒤에 다시 해 주세요.`;
    }
    const missing = this.missingSettings();
    if (missing.length > 0) {
      return `${NOTICE_PREFIX}: 설정을 채워 주세요 — ${missing.join(" · ")}`;
    }
    if (this.initFailure !== null) return `${NOTICE_PREFIX} ${this.initFailure}`;
    return `${NOTICE_PREFIX}: 아직 준비 중입니다. 잠시 뒤에 다시 해 주세요.`;
  }

  private cancelSync(): void {
    this.activeEngine().controller?.cancel();
  }

  private blockedByDirection(action: "push" | "pull"): string | null {
    const reason = directionBlock(this.settings.syncDirection, action);
    return reason === null ? null : `${NOTICE_PREFIX}: ${reason}`;
  }

  /**
   * 명령이 도는 연결 — 동기화할 수 있는 것과, 할 수 없으면 그 까닭을 알릴 것. 볼트 맨 위 연결은 설정했거나 폴더
   * 연결이 없을 때만 넣는다 — 폴더 연결만 쓰는 볼트에서 「설정을 채워 주세요」 를 매번 띄우지 않는다.
   */
  private commandEngines(): ConnectionEngine[] {
    const primary =
      this.extras.length === 0 || this.primary.controller || this.hasConnectionSettings();
    return primary ? this.engines : this.extras;
  }

  /** 연결마다 차례로 한다 — 준비되지 않은 연결은 까닭을 알리고 건너뛴다. */
  private async eachEngine(
    engines: readonly ConnectionEngine[],
    run: (controller: NonNullable<ConnectionEngine["controller"]>) => Promise<unknown>,
  ): Promise<void> {
    for (const engine of engines) {
      if (!engine.controller) {
        new Notice(this.notReadyReason(engine));
        continue;
      }
      await run(engine.controller);
    }
  }

  /** Push. 경로를 주면 변경 패널이 보이는 연결의 그 경로만. */
  private async executePush(
    paths?: string[],
    engines: readonly ConnectionEngine[] = paths ? [this.activeEngine()] : this.commandEngines(),
  ): Promise<void> {
    if (engines.every((engine) => !engine.controller)) {
      new Notice(this.notReadyReason(engines[0]));
      return;
    }
    const blocked = this.blockedByDirection("push");
    if (blocked) {
      new Notice(blocked);
      return;
    }
    await this.eachEngine(engines, (controller) => controller.push(paths));
  }

  /** Pull. `force` 는 원격을 전체 대조한다 — Notion 에서 지운 노트를 바로 반영한다. */
  private async executePull({
    force = false,
    rerender = false,
    paths,
    engines = paths ? [this.activeEngine()] : this.commandEngines(),
  }: {
    readonly force?: boolean;
    readonly rerender?: boolean;
    readonly paths?: string[];
    readonly engines?: readonly ConnectionEngine[];
  } = {}): Promise<void> {
    if (engines.every((engine) => !engine.controller)) {
      new Notice(this.notReadyReason(engines[0]));
      return;
    }
    const blocked = this.blockedByDirection("pull");
    if (blocked) {
      new Notice(blocked);
      return;
    }
    await this.eachEngine(engines, (controller) => controller.pull(paths, { force, rerender }));
  }

  private async executeSync(
    engines: readonly ConnectionEngine[] = this.commandEngines(),
  ): Promise<void> {
    if (engines.every((engine) => !engine.controller)) {
      new Notice(this.notReadyReason(engines[0]));
      return;
    }
    await this.eachEngine(engines, (controller) => controller.sync());
  }

  private async showStatus(): Promise<void> {
    const engines = this.commandEngines();
    if (engines.every((engine) => !engine.controller)) {
      new Notice(this.notReadyReason(engines[0]));
      return;
    }
    for (const engine of engines) await this.showEngineStatus(engine);
  }

  private async showEngineStatus(engine: ConnectionEngine): Promise<void> {
    if (!engine.controller) {
      new Notice(this.notReadyReason(engine));
      return;
    }

    try {
      const status = await engine.controller.getStatus();
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

      new Notice(`${NOTICE_PREFIX}${engine.noticeTag} 상태:\n${lines.join("\n")}`, 5000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`상태 확인 실패${engine.noticeTag}: ${msg}`);
    }
  }

  /** 볼트의 노트 폴더를 그 폴더를 맡은 연결의 Notion DB 로 올릴 준비를 한다. 연결 폴더 자체는 올리지 않는다. */
  private async prepareDatabase(folder: string): Promise<void> {
    const owner = connectionFolderOf(folder, this.connectionFolders);
    const engine = this.engines.find((e) => e.folder === owner) ?? this.primary;
    if (!engine.controller) {
      new Notice(this.notReadyReason(engine));
      return;
    }
    const local = engine.toLocal(folder);
    if (!local) {
      new Notice(
        `${NOTICE_PREFIX}: ${folder} 는 연결 폴더라 DB 로 올리지 않습니다 — 그 안의 노트 폴더를 고르세요.`,
      );
      return;
    }
    // Obsidian 설정 폴더는 볼트 맨 위에 하나다 — 연결 폴더 기준 경로로 넘긴다
    await engine.controller.prepareDatabase(
      local,
      configDirFrom(engine.folder, this.app.vault.configDir),
    );
  }

  /**
   * 변경 패널에서 누른 로컬 변경 하나를 되돌린다 — 지난 동기화 뒤의 로컬 편집이 사라지므로 먼저 확인 창으로
   * 묻는다. 되돌리기를 누르지 않고 닫으면 아무것도 하지 않는다.
   */
  private async discardLocal(change: LocalChange): Promise<void> {
    const engine = this.activeEngine();
    const confirmed = await new Promise<boolean>((resolve) =>
      new DiscardConfirmModal(this.app, change, resolve).open(),
    );
    if (confirmed) await engine.controller?.discard(change.path);
  }

  /** 변경 패널에서 누른 로컬 변경의 줄 비교 창 — 보기만 하므로 도는 작업이 있어도 연다. */
  private showLocalDiff(change: LocalChange): void {
    const engine = this.activeEngine();
    if (!engine.controller) {
      new Notice(this.notReadyReason(engine));
      return;
    }
    new ChangeDiffModal(this.app, localDiffSource(change, engine.controller)).open();
  }

  /** 변경 패널에서 누른 원격 변경의 줄 비교 창 — Notion 의 지금 글을 읽어 지난 동기화 때와 견준다. */
  private showRemoteDiff(change: RemoteChange): void {
    const engine = this.activeEngine();
    if (!engine.controller) {
      new Notice(this.notReadyReason(engine));
      return;
    }
    const source = remoteDiffSource(change, engine.controller);
    if (!source) {
      new Notice(
        `${NOTICE_PREFIX}: 아직 받지 않은 새 페이지라 견줄 글이 없습니다 — 받은 뒤에 보세요.`,
      );
      return;
    }
    new ChangeDiffModal(this.app, source).open();
  }

  private async resolveConflicts(
    engines: readonly ConnectionEngine[] = this.commandEngines(),
  ): Promise<void> {
    if (engines.every((engine) => !engine.controller)) {
      new Notice(this.notReadyReason(engines[0]));
      return;
    }
    await this.eachEngine(engines, (controller) =>
      controller.resolveConflicts((conflict, signal) => this.askConflictChoice(conflict, signal)),
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
      ready: `${NOTICE_PREFIX}: Ready`,
      syncing: `${NOTICE_PREFIX}: Syncing...`,
      error: `${NOTICE_PREFIX}: Error`,
      conflict: `${NOTICE_PREFIX}: Conflict`,
    };

    this.statusBarEl.setText(labels[state] ?? NOTICE_PREFIX);
  }

  /** 연결마다의 보기 설정 — 읽지 못한 연결은 까닭을 알리고 뺀다. */
  private async viewConfigsByEngine(): Promise<
    { readonly engine: ConnectionEngine; readonly databaseIds: string[] }[]
  > {
    const out: { engine: ConnectionEngine; databaseIds: string[] }[] = [];
    for (const engine of this.engines) {
      if (!engine.viewProvider) continue;
      // 읽지 못한 보기 설정을 「설정이 없습니다(Pull 하세요)」 로 안내하지 않는다 — 까닭을 그대로 보인다.
      const configs = await engine.viewProvider.loadAllViewConfigs().catch((error: unknown) => {
        new Notice(`${NOTICE_PREFIX}${engine.noticeTag}: ${errorText(error)}`);
        return null;
      });
      if (configs) out.push({ engine, databaseIds: Object.keys(configs) });
    }
    return out;
  }

  private async openDatabaseView(): Promise<void> {
    if (this.engines.every((engine) => !engine.viewProvider)) {
      new Notice(this.notReadyReason(this.commandEngines()[0]));
      return;
    }

    const found = (await this.viewConfigsByEngine()).find((c) => c.databaseIds.length > 0);
    if (!found) {
      new Notice(`${NOTICE_PREFIX}: DB 뷰 설정이 없습니다. Pull을 먼저 실행해주세요.`);
      return;
    }
    const { engine } = found;
    const databaseId = found.databaseIds[0]!;
    const dbConfig =
      engine === this.primary
        ? this.settings.databases?.find((d) => d.databaseId === databaseId)
        : undefined;
    const folderPath = dbConfig?.localFolder ?? "";

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: DATABASE_VIEW_TYPE, active: true });

    const view = leaf.view;
    if (view instanceof DatabaseItemView && engine.viewProvider) {
      await view.setViewParams({
        provider: engine.viewProvider,
        databaseId,
        folderPath,
        editor: engine.entryEditor ?? undefined,
        toVault: (path) => engine.toVault(path),
      });
    }
  }

  /**
   * 노트 안의 DB 보기 블록을 그린다. 그 노트를 맡은 연결의 보기 설정을 쓴다 — 블록의 `folder` 는 그 연결 기준이다.
   * 그 연결에 그 DB 가 없으면 다른 연결에서 찾는다(노트를 연결 폴더 밖으로 옮긴 경우).
   */
  private async renderInlineView(
    source: string,
    container: HTMLElement,
    sourcePath = "",
  ): Promise<void> {
    const params = parseViewParams(source);
    const owner = connectionFolderOf(sourcePath, this.connectionFolders);
    const candidates = [
      ...this.engines.filter((e) => e.folder === owner),
      ...this.engines.filter((e) => e.folder !== owner),
    ].filter((e) => e.viewProvider);
    if (candidates.length === 0) {
      container.createEl("p", {
        text: this.notReadyReason(this.commandEngines()[0]),
        cls: "im-view-error",
      });
      return;
    }

    try {
      if (!params.databaseId) {
        container.createEl("p", { text: "database 파라미터가 필요합니다.", cls: "im-view-error" });
        return;
      }
      const databaseId = params.databaseId;

      let engine = candidates[0]!;
      let configs = await engine.viewProvider!.getViewConfigs(databaseId);
      for (const other of candidates.slice(1)) {
        if (configs) break;
        const found = await other.viewProvider!.getViewConfigs(databaseId);
        if (found) [engine, configs] = [other, found];
      }
      const provider = engine.viewProvider!;

      const viewData = params.viewId
        ? await provider.buildViewData(databaseId, params.viewId, params.folder ?? "")
        : await provider.buildDefaultViewData(databaseId, params.folder ?? "");

      if (!viewData) {
        container.createEl("p", { text: "뷰 데이터를 찾을 수 없습니다.", cls: "im-view-error" });
        return;
      }

      const { mount } = await import("svelte");
      const { default: ViewContainer } = await import("./views/ViewContainer.svelte");
      const openEntry = (entry: { path: string }) => this.openVaultFile(engine.toVault(entry.path));

      mount(ViewContainer, {
        target: container,
        props: {
          data: viewData,
          availableViews: configs?.views ?? [],
          onViewChange: async (viewId: string) => {
            container.empty();
            const newData = await provider.buildViewData(databaseId, viewId, params.folder ?? "");
            if (newData) {
              mount(ViewContainer, {
                target: container,
                props: {
                  data: newData,
                  availableViews: configs?.views ?? [],
                  onEntryClick: openEntry,
                },
              });
            }
          },
          onEntryClick: openEntry,
        },
      });
    } catch (error) {
      container.createEl("p", {
        text: `뷰 렌더링 실패: ${errorText(error)}`,
        cls: "im-view-error",
      });
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 연결을 열지 못한 까닭. 사용자가 풀 수 있는 실패(파일이 깨짐 · 다른 곳이 쓰는 중)에만 할 일을 붙인다 — 엔진을
 * 띄우지 못한 것 같은 다른 실패에 파일을 치우라고 하면 멀쩡한 기록을 치우게 된다.
 */
function initFailureText(error: unknown): string {
  const guidance =
    error instanceof StateDbUnavailableError
      ? ` — ${error.guidance("동기화 사이드바에서 새로고침을 누르세요")}`
      : "";
  return `초기화 실패: ${errorText(error)}${guidance}`;
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
