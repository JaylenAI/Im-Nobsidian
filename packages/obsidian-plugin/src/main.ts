import { Plugin, Notice, MarkdownRenderChild, requestUrl, type TFile } from "obsidian";
import {
  NotionClient,
  SyncOrchestrator,
  ConflictResolver,
  DEFAULT_CONFIG,
  ViewDataProvider,
  EntryEditor,
} from "@im-nobsidian/core";
import type {
  IStateDB,
  Config,
  Conflict,
  ResolutionChoice,
  ProgressCallback,
} from "@im-nobsidian/core";
import { SqlJsStateDB } from "./state/sqljs-state-db.js";
import { ImNobsidianSettingTab } from "./settings.js";
import { ObsidianVaultAdapter } from "./vault-adapter.js";
import { ConflictModal } from "./conflict-modal.js";
import { DatabaseItemView, DATABASE_VIEW_TYPE } from "./views/database-view.js";
import { SyncSidebarView, SYNC_SIDEBAR_TYPE } from "./views/sync-sidebar-view.js";

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

  return requestUrl({ url, method, headers, body, throw: false }).then(
    (resp) =>
      new Response(JSON.stringify(resp.json), {
        status: resp.status,
        headers: new Headers(resp.headers),
      }),
  );
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

export default class ImNobsidianPlugin extends Plugin {
  settings: ImNobsidianSettings = DEFAULT_SETTINGS;
  private orchestrator: SyncOrchestrator | null = null;
  private stateDb: IStateDB | null = null;
  private statusBarEl: HTMLElement | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private vaultEventSyncing = false;
  private viewProvider: ViewDataProvider | null = null;
  private entryEditor: EntryEditor | null = null;

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
        onRefresh: () => this.refreshSidebarStatus(),
        onResolveConflict: () => this.resolveConflicts(),
        onOpenFile: (path: string) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file) void this.app.workspace.getLeaf(false).openFile(file as TFile);
        },
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

    if (this.settings.token && this.settings.rootPageId) {
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
    if (this.stateDb && "flush" in this.stateDb) {
      void (this.stateDb as SqlJsStateDB).flush();
    }
    this.stateDb?.close();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async initOrchestrator(): Promise<void> {
    if (!this.settings.token || !this.settings.rootPageId) return;

    try {
      this.stateDb?.close();

      const basePath = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
      /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */
      const nodePath: typeof import("path") = require("path");
      const nodeFs: typeof import("fs") = require("fs");
      /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */
      const wasmPath = nodePath.join(
        basePath,
        ".obsidian",
        "plugins",
        "im-notion-sync",
        "sql-wasm.wasm",
      );
      const wasmBinary = nodeFs.readFileSync(wasmPath).buffer;

      let existingData: Uint8Array | null = null;
      try {
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(".im-nobsidian/sync.db")) {
          const buf = await adapter.readBinary(".im-nobsidian/sync.db");
          existingData = new Uint8Array(buf);
        }
      } catch {
        // first run — no DB yet
      }

      this.stateDb = await SqlJsStateDB.open(
        existingData,
        async (data: Uint8Array) => {
          const adapter = this.app.vault.adapter;
          if (!(await adapter.exists(".im-nobsidian"))) {
            await adapter.mkdir(".im-nobsidian");
          }
          await adapter.writeBinary(".im-nobsidian/sync.db", data.buffer as ArrayBuffer);
        },
        wasmBinary,
      );

      const client = new NotionClient({
        token: this.settings.token,
        concurrency: 3,
        timeoutMs: 30000,
        fetch: obsidianFetch as typeof globalThis.fetch,
      });

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

      this.orchestrator = new SyncOrchestrator(
        config,
        this.stateDb,
        client,
        vaultAdapter,
        obsidianFetch as typeof globalThis.fetch,
      );
      this.viewProvider = new ViewDataProvider(vaultAdapter);
      this.entryEditor = new EntryEditor(vaultAdapter);
      this.updateStatusBar("ready");
      await this.refreshSidebarStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Im-Nobsidian 초기화 실패: ${message}`);
      this.updateStatusBar("error");
    }
  }

  private getSidebarView(): SyncSidebarView | null {
    const leaves = this.app.workspace.getLeavesOfType(SYNC_SIDEBAR_TYPE);
    if (leaves.length === 0) return null;
    return leaves[0]!.view as SyncSidebarView;
  }

  private updateSidebar(partial: Record<string, unknown>): void {
    this.getSidebarView()?.updateState(partial);
  }

  private makeProgressCallback(): ProgressCallback {
    return (current, total, item) => {
      this.updateSidebar({
        syncState: "syncing",
        progress: { current, total, currentPath: item.path },
      });
    };
  }

  private async refreshSidebarStatus(): Promise<void> {
    if (!this.orchestrator) return;
    try {
      const status = await this.orchestrator.statusLocal();
      const syncState =
        status.conflictRecords.length > 0 ? ("conflict" as const) : ("ready" as const);
      this.updateSidebar({
        lastSyncAt: status.lastSyncAt,
        localChanges: status.localChanges,
        conflicts: status.conflicts,
        syncState,
        progress: null,
        errorMessage: null,
      });
    } catch {
      // sidebar refresh is best-effort
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
    if (!this.settings.autoSync || !this.orchestrator) return;

    this.autoSyncTimer = setInterval(
      () => this.executeSync(),
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
      const colorRegex = /%%im-nobsidian:color:(\w+)%%([\s\S]*?)%%\/color%%/g;
      const nodesToReplace: { node: Text; fragments: DocumentFragment }[] = [];

      let textNode: Text | null;
      while ((textNode = walker.nextNode() as Text | null)) {
        const text = textNode.textContent ?? "";
        if (!text.includes("%%im-nobsidian:color:")) continue;

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
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));
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
    if (!this.settings.autoSync || !this.orchestrator) return;

    this.clearVaultDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.executeVaultSync();
    }, 2000);
  }

  private clearVaultDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async executeVaultSync(): Promise<void> {
    if (!this.orchestrator || this.vaultEventSyncing) return;

    this.vaultEventSyncing = true;
    this.updateStatusBar("syncing");

    try {
      const result = await this.orchestrator.sync();
      this.updateStatusBar(result.conflicts.length > 0 ? "conflict" : "ready");
    } catch {
      this.updateStatusBar("error");
    } finally {
      this.vaultEventSyncing = false;
    }
  }

  private async executePush(): Promise<void> {
    if (!this.orchestrator) {
      new Notice("Im-Nobsidian: 설정을 먼저 완료해주세요.");
      return;
    }

    this.updateStatusBar("syncing");
    this.updateSidebar({ syncState: "syncing", progress: null, errorMessage: null });
    new Notice("Im-Nobsidian: Push 시작...");

    try {
      const result = await this.orchestrator.push({ onProgress: this.makeProgressCallback() });

      const message = [
        `Push 완료 (${(result.duration / 1000).toFixed(1)}s)`,
        `생성 ${result.created} / 수정 ${result.updated} / 삭제 ${result.deleted}`,
      ];

      if (result.failed.length > 0) {
        message.push(`실패 ${result.failed.length}건`);
      }

      new Notice(`Im-Nobsidian: ${message.join("\n")}`);
      this.updateStatusBar("ready");
      await this.refreshSidebarStatus();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`Im-Nobsidian Push 실패: ${msg}`);
      this.updateStatusBar("error");
      this.updateSidebar({ syncState: "error", progress: null, errorMessage: msg });
    }
  }

  private async executePull(): Promise<void> {
    if (!this.orchestrator) {
      new Notice("Im-Nobsidian: 설정을 먼저 완료해주세요.");
      return;
    }

    this.updateStatusBar("syncing");
    this.updateSidebar({ syncState: "syncing", progress: null, errorMessage: null });
    new Notice("Im-Nobsidian: Pull 시작...");

    try {
      const result = await this.orchestrator.pull({ onProgress: this.makeProgressCallback() });

      const message = [
        `Pull 완료 (${(result.duration / 1000).toFixed(1)}s)`,
        `생성 ${result.created} / 수정 ${result.updated} / 삭제 ${result.deleted}`,
      ];

      if (result.conflicts.length > 0) {
        message.push(`충돌 ${result.conflicts.length}건 — 수동 해결 필요`);
      }

      if (result.failed.length > 0) {
        message.push(`실패 ${result.failed.length}건`);
      }

      new Notice(`Im-Nobsidian: ${message.join("\n")}`);
      this.updateStatusBar(result.conflicts.length > 0 ? "conflict" : "ready");
      await this.refreshSidebarStatus();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`Im-Nobsidian Pull 실패: ${msg}`);
      this.updateStatusBar("error");
      this.updateSidebar({ syncState: "error", progress: null, errorMessage: msg });
    }
  }

  private async executeSync(): Promise<void> {
    if (!this.orchestrator) {
      new Notice("Im-Nobsidian: 설정을 먼저 완료해주세요.");
      return;
    }

    this.updateStatusBar("syncing");
    this.updateSidebar({ syncState: "syncing", progress: null, errorMessage: null });
    new Notice("Im-Nobsidian: Sync 시작...");

    try {
      const result = await this.orchestrator.sync({ onProgress: this.makeProgressCallback() });

      const pullInfo = `Pull: +${result.pull.created} ~${result.pull.updated} -${result.pull.deleted}`;
      const pushInfo = `Push: +${result.push.created} ~${result.push.updated} -${result.push.deleted}`;

      const message = [`Sync 완료 (${(result.duration / 1000).toFixed(1)}s)`, pullInfo, pushInfo];

      if (result.conflicts.length > 0) {
        message.push(`충돌 ${result.conflicts.length}건`);
      }

      new Notice(`Im-Nobsidian: ${message.join("\n")}`);
      this.updateStatusBar(result.conflicts.length > 0 ? "conflict" : "ready");
      await this.refreshSidebarStatus();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`Im-Nobsidian Sync 실패: ${msg}`);
      this.updateStatusBar("error");
      this.updateSidebar({ syncState: "error", progress: null, errorMessage: msg });
    }
  }

  private async showStatus(): Promise<void> {
    if (!this.orchestrator) {
      new Notice("Im-Nobsidian: 설정을 먼저 완료해주세요.");
      return;
    }

    try {
      const status = await this.orchestrator.status();

      const lines = [];

      if (status.lastSyncAt) {
        lines.push(`마지막 동기화: ${new Date(status.lastSyncAt).toLocaleString()}`);
      } else {
        lines.push("아직 동기화된 적 없음");
      }

      lines.push(`로컬 변경: ${status.localChanges.length}건`);
      lines.push(`원격 변경: ${status.remoteChanges.length}건`);

      if (status.pendingOperations > 0) {
        lines.push(`대기 중: ${status.pendingOperations}건`);
      }

      new Notice(`Im-Nobsidian 상태:\n${lines.join("\n")}`, 5000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`상태 확인 실패: ${msg}`);
    }
  }

  private async resolveConflicts(): Promise<void> {
    if (!this.orchestrator || !this.stateDb) {
      new Notice("Im-Nobsidian: 설정을 먼저 완료해주세요.");
      return;
    }

    const conflictRecords = this.stateDb.getByStatus("conflict");
    if (conflictRecords.length === 0) {
      new Notice("Im-Nobsidian: 충돌이 없습니다.");
      return;
    }

    try {
      const pullResult = await this.orchestrator.pull();

      if (pullResult.conflicts.length === 0) {
        new Notice("Im-Nobsidian: 해결할 충돌이 없습니다.");
        this.updateStatusBar("ready");
        return;
      }

      const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);
      const resolver = new ConflictResolver(this.stateDb, vaultAdapter);

      for (const conflict of pullResult.conflicts) {
        await this.showConflictModal(conflict, resolver);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`충돌 해결 실패: ${msg}`);
    }
  }

  private showConflictModal(conflict: Conflict, resolver: ConflictResolver): Promise<void> {
    return new Promise((resolve) => {
      const modal = new ConflictModal(this.app, conflict, async (choice: ResolutionChoice) => {
        const result = await resolver.resolve(conflict, choice);

        if (result.success) {
          new Notice(`충돌 해결: ${result.path} → ${choice}`);
        } else if (result.mergeHadConflicts) {
          new Notice(`자동 병합 완료 (수동 확인 필요): ${result.path}`, 5000);
        }

        const remaining = this.stateDb?.getByStatus("conflict") ?? [];
        this.updateStatusBar(remaining.length > 0 ? "conflict" : "ready");

        resolve();
      });
      modal.open();
    });
  }

  private updateStatusBar(state: "ready" | "syncing" | "error" | "conflict"): void {
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
      new Notice("Im-Nobsidian: 설정을 먼저 완료해주세요.");
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
        text: "Im-Nobsidian: 설정을 먼저 완료해주세요.",
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
