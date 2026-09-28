import { Plugin, Notice, MarkdownRenderChild, requestUrl, TFolder, type TFile } from "obsidian";
import {
  NotionClient,
  SyncOrchestrator,
  DEFAULT_CONFIG,
  ViewDataProvider,
  EntryEditor,
  getLogger,
} from "@im-nobsidian/core";
import type {
  Config,
  Conflict,
  LocalChange,
  RemoteChange,
  ResolutionChoice,
} from "@im-nobsidian/core";
import { STATE_DB_PATH, MARKER_BRAND } from "@im-nobsidian/core";
import { WASM_FILE } from "./constants.js";
import { SavedStateDbError, SqlJsStateDB } from "./state/sqljs-state-db.js";
import { announceStateDbClose, previousStateDbClosed } from "./state/state-db-handoff.js";
import { writeFileAtomically } from "./state/atomic-write.js";
import { ImNobsidianSettingTab } from "./settings.js";
import { ObsidianVaultAdapter } from "./vault-adapter.js";
import { ConflictModal } from "./conflict-modal.js";
import { ChangeDiffModal } from "./change-diff-modal.js";
import { DiscardConfirmModal } from "./discard-confirm-modal.js";
import { localDiffSource, remoteDiffSource } from "./change-diff-text.js";
import { DatabaseItemView, DATABASE_VIEW_TYPE } from "./views/database-view.js";
import { SyncSidebarView, SYNC_SIDEBAR_TYPE } from "./views/sync-sidebar-view.js";
import { SyncController } from "./sync/sync-controller.js";
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

interface ImNobsidianSettings {
  token: string;
  rootPageId: string;
  syncDirection: "push" | "pull" | "both";
  autoSync: boolean;
  autoSyncInterval: number;
  conflictStrategy: "local-first" | "remote-first" | "manual";
  attachments: string;
  databases?: DatabaseConfig[];
}

const DEFAULT_SETTINGS: ImNobsidianSettings = {
  token: "",
  rootPageId: "",
  syncDirection: "both",
  autoSync: false,
  autoSyncInterval: 300,
  conflictStrategy: "manual",
  attachments: "attachments",
};

/**
 * 저장된 상태 DB 파일이 깨졌을 때 할 일 — 초기화 실패 이유 뒤에 붙인다. 폴더 이름이 점으로 시작해 Obsidian 의
 * 파일 탐색기에는 보이지 않으므로 볼트 폴더에서 찾으라고 적는다.
 */
const DAMAGED_STATE_DB_GUIDANCE =
  `볼트 폴더의 ${STATE_DB_PATH} 를 사본으로 바꾸거나 다른 곳으로 옮긴 뒤 동기화 사이드바에서 새로고침을 누르세요. ` +
  "옮기면 처음부터 시작합니다 — 노트와 Notion 페이지의 짝을 잃어 다음 push 가 페이지를 새로 만듭니다.";

export default class ImNobsidianPlugin extends Plugin {
  settings: ImNobsidianSettings = DEFAULT_SETTINGS;
  private syncController: SyncController | null = null;
  private stateDb: SqlJsStateDB | null = null;
  private statusBarEl: HTMLElement | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private initializing: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
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
        onOpenFile: (path: string) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file) void this.app.workspace.getLeaf(false).openFile(file as TFile);
        },
        onPushPath: async (path: string) => this.syncController?.push([path]),
        onDiscard: (change: LocalChange) => this.discardLocal(change),
        onPullPath: async (path: string) => this.syncController?.pull([path]),
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

    if (this.hasConnectionSettings()) {
      await this.initOrchestrator();
    }

    if (this.settings.autoSync) {
      this.startAutoSync();
    }

    this.registerColorPostProcessor();
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
   * 도는 작업을 멈추고 끝나기를 기다린 뒤, 상태 DB 의 남은 쓰기를 마치고 닫는다(S-09). 예전에는 도는 sync
   * 아래에서 닫아, 그 sync 가 닫힌 DB 에 쓰다 실패했다. 쓰기도 기다리지 않아, 같은 파일을 다시 여는 쪽이 옛
   * 기록을 읽을 수 있었다. 못 쓰면 DB 를 쥔 채 이유를 던진다 — 다음 초기화가 다시 닫는다.
   */
  private async closeStateDb(): Promise<void> {
    const controller = this.syncController;
    const stateDb = this.stateDb;
    this.syncController = null;
    this.stateDb = null;
    await controller?.shutdown();
    try {
      await stateDb?.close();
    } catch (error) {
      this.stateDb = stateDb;
      throw error;
    }
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 설정으로 오케스트레이터를 새로 만든다. 설정 창은 글자를 칠 때마다 부른다 — 차례로 돌려,
   * 앞 초기화가 연 DB 를 뒤 초기화가 모르고 새로 여는 일이 없게 한다.
   */
  initOrchestrator(): Promise<void> {
    this.initializing = this.initializing.then(() => this.createOrchestrator());
    return this.initializing;
  }

  /** Notion 에 닿을 설정(토큰 · 루트 페이지)을 다 채웠나. */
  private hasConnectionSettings(): boolean {
    return Boolean(this.settings.token && this.settings.rootPageId);
  }

  private async createOrchestrator(): Promise<void> {
    this.initFailure = null;
    if (!this.hasConnectionSettings()) return;

    try {
      await this.closeStateDb();

      const basePath = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
      /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */
      const nodePath: typeof import("path") = require("path");
      const nodeFs: typeof import("fs") = require("fs");
      /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */
      const wasmPath = nodePath.join(basePath, ".obsidian", "plugins", this.manifest.id, WASM_FILE);
      const wasmBinary = nodeFs.readFileSync(wasmPath).buffer;

      const stateDbFile = nodePath.join(basePath, STATE_DB_PATH);
      this.stateDb = await SqlJsStateDB.open(
        await this.readStateDbFile(),
        // 한 번에 갈아 끼운다 — 쓰는 도중에 Obsidian 이 죽어도 파일이 잘리지 않는다.
        (data: Uint8Array) => writeFileAtomically(stateDbFile, data),
        wasmBinary,
      );

      const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);

      const config: Config = {
        ...DEFAULT_CONFIG,
        notion: {
          token: this.settings.token,
          rootPageId: this.settings.rootPageId,
          parentMode: "page" as const,
          databases: [],
        },
        sync: {
          ...DEFAULT_CONFIG.sync,
          direction: this.settings.syncDirection,
          conflictStrategy: this.settings.conflictStrategy,
          deleteSync: true,
        },
        paths: {
          ...DEFAULT_CONFIG.paths,
          attachments: this.settings.attachments,
        },
      };

      const client = NotionClient.fromConfig(config, obsidianFetch as typeof globalThis.fetch);

      const orchestrator = new SyncOrchestrator(
        config,
        this.stateDb,
        client,
        vaultAdapter,
        obsidianFetch as typeof globalThis.fetch,
      );
      // 동기화 실행은 전부 SyncController 가 담당한다. 플러그인은 Notice/사이드바/상태바
      // 표시만 훅으로 넘겨 배선하므로, sync 로직과 Obsidian UI 가 분리된다.
      this.syncController = new SyncController(orchestrator, {
        onState: (patch) => this.updateSidebar(patch),
        onNotice: (message, durationMs) => new Notice(message, durationMs),
        onStatusBar: (state) => this.updateStatusBar(state),
      });
      this.viewProvider = new ViewDataProvider(vaultAdapter);
      this.entryEditor = new EntryEditor(vaultAdapter);
      this.updateStatusBar("ready");
      await this.refreshSidebarStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 파일이 깨졌을 때만 치우는 법을 알린다 — 엔진을 띄우지 못한 것 같은 다른 실패에 붙이면 멀쩡한 기록을 치우게 된다.
      const guidance = error instanceof SavedStateDbError ? ` — ${DAMAGED_STATE_DB_GUIDANCE}` : "";
      this.initFailure = `초기화 실패: ${message}${guidance}`;
      new Notice(`Im-Nobsidian ${this.initFailure}`);
      this.updateStatusBar("error");
      this.updateSidebar({ syncState: "error", errorMessage: this.initFailure });
    }
  }

  /**
   * 상태 DB 파일을 읽는다 — 파일이 없으면(처음) null. 읽지 못하면 이유를 던진다 — 예전에는 «처음» 으로 보고 빈
   * DB 를 열어, 다음 쓰기가 파일의 동기화 기록 전체를 덮었다. 기록이 없으면 다음 push 가 모든 노트의 페이지를
   * 또 만든다.
   *
   * 플러그인을 다시 불러왔으면 옛 인스턴스가 DB 를 다 닫은 뒤에 읽는다 — 먼저 읽으면 옛 인스턴스의 마지막 기록이
   * 빠진 DB 를 연다.
   */
  private async readStateDbFile(): Promise<Uint8Array | null> {
    await previousStateDbClosed();
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
    this.app.workspace.revealLeaf(leaf);
    await this.refreshSidebarStatus();
  }

  startAutoSync(): void {
    this.stopAutoSync();
    if (!this.settings.autoSync || !this.syncController) return;

    // 도는 작업이 있으면 조용히 건너뛴다 — 긴 sync 동안 주기가 겹쳐 부르지 않는다(S-09).
    this.autoSyncTimer = setInterval(
      () => void this.syncController?.autoSync(),
      this.settings.autoSyncInterval * 1000,
    );
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  private registerColorPostProcessor(): void {
    this.registerMarkdownPostProcessor((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const colorProbe = `%%${MARKER_BRAND}:color:`;
      const colorRegex = new RegExp(
        `%%${MARKER_BRAND}:color:(\\w+)%%([\\s\\S]*?)%%\\/color%%`,
        "g",
      );
      const nodesToReplace: { node: Text; fragments: DocumentFragment }[] = [];

      let textNode: Text | null;
      while ((textNode = walker.nextNode() as Text | null)) {
        const text = textNode.textContent ?? "";
        if (!text.includes(colorProbe)) continue;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        colorRegex.lastIndex = 0;
        while ((match = colorRegex.exec(text)) !== null) {
          if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
          }
          const span = document.createElement("span");
          span.className = `im-nobsidian-color-${match[1]}`;
          span.textContent = match[2]!;
          fragment.appendChild(span);
          lastIndex = colorRegex.lastIndex;
        }

        if (lastIndex > 0) {
          if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
          }
          nodesToReplace.push({ node: textNode, fragments: fragment });
        }
      }

      for (const { node, fragments } of nodesToReplace) {
        node.parentNode?.replaceChild(fragments, node);
      }
    });
  }

  private registerVaultEvents(): void {
    const onVaultChange = (file: { path: string }) => {
      if (!file.path.endsWith(".md")) return;
      this.scheduleVaultSync();
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
        this.scheduleVaultSync();
        this.scheduleSidebarRefresh();
      }),
    );
  }

  private sidebarRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleSidebarRefresh(): void {
    if (this.sidebarRefreshTimer) clearTimeout(this.sidebarRefreshTimer);
    this.sidebarRefreshTimer = setTimeout(() => {
      this.sidebarRefreshTimer = null;
      void this.refreshSidebarStatus();
    }, 500);
  }

  private scheduleVaultSync(): void {
    if (!this.settings.autoSync || !this.syncController) return;

    this.clearVaultDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncController?.vaultSync();
    }, 2000);
  }

  private clearVaultDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 동기화할 수 없는 까닭 — 설정이 비었나, 초기화가 실패했나, 아직 초기화 중인가. */
  private notReadyReason(): string {
    if (!this.hasConnectionSettings()) return "Im-Nobsidian: 설정을 먼저 완료해주세요.";
    if (this.initFailure !== null) return `Im-Nobsidian ${this.initFailure}`;
    return "Im-Nobsidian: 아직 준비 중입니다. 잠시 뒤에 다시 해 주세요.";
  }

  private cancelSync(): void {
    this.syncController?.cancel();
  }

  private async executePush(): Promise<void> {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }
    await this.syncController.push();
  }

  private async executePull(): Promise<void> {
    if (!this.syncController) {
      new Notice(this.notReadyReason());
      return;
    }
    await this.syncController.pull();
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

      const lines = [];

      if (status.lastSyncAt) {
        lines.push(`마지막 동기화: ${new Date(status.lastSyncAt).toLocaleString()}`);
      } else {
        lines.push("아직 동기화된 적 없음");
      }

      lines.push(`로컬 변경: ${status.localChanges.length}건`);
      lines.push(`원격 변경: ${status.remoteChanges.length}건`);

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
      const modal = new ConflictModal(this.app, conflict, resolve);
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

    const allConfigs = await this.viewProvider.loadAllViewConfigs();
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
                  onEntryClick: (entry: { path: string }) => {
                    const file = this.app.vault.getAbstractFileByPath(entry.path);
                    if (file) void this.app.workspace.getLeaf(false).openFile(file as TFile);
                  },
                },
              });
            }
          },
          onEntryClick: (entry: { path: string }) => {
            const file = this.app.vault.getAbstractFileByPath(entry.path);
            if (file) void this.app.workspace.getLeaf(false).openFile(file as TFile);
          },
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
