import { Plugin, Notice } from "obsidian";
import { StateDB, NotionClient, SyncOrchestrator, DEFAULT_CONFIG } from "@obsinotion/core";
import type { Config } from "@obsinotion/core";
import { ObsiNotionSettingTab } from "./settings.js";
import { ObsidianVaultAdapter } from "./vault-adapter.js";

interface ObsiNotionSettings {
  token: string;
  rootPageId: string;
  syncDirection: "push" | "pull" | "both";
  autoSync: boolean;
  autoSyncInterval: number;
  conflictStrategy: "local-first" | "remote-first" | "manual";
  attachments: string;
}

const DEFAULT_SETTINGS: ObsiNotionSettings = {
  token: "",
  rootPageId: "",
  syncDirection: "both",
  autoSync: false,
  autoSyncInterval: 300,
  conflictStrategy: "manual",
  attachments: "attachments",
};

export default class ObsiNotionPlugin extends Plugin {
  settings: ObsiNotionSettings = DEFAULT_SETTINGS;
  private orchestrator: SyncOrchestrator | null = null;
  private stateDb: StateDB | null = null;
  private statusBarEl: HTMLElement | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ObsiNotionSettingTab(this.app, this));

    this.addCommand({
      id: "obsinotion-push",
      name: "Push to Notion",
      callback: () => this.executePush(),
    });

    this.addCommand({
      id: "obsinotion-pull",
      name: "Pull from Notion",
      callback: () => this.executePull(),
    });

    this.addCommand({
      id: "obsinotion-sync",
      name: "Sync (양방향)",
      callback: () => this.executeSync(),
    });

    this.addCommand({
      id: "obsinotion-status",
      name: "동기화 상태 확인",
      callback: () => this.showStatus(),
    });

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("ready");

    if (this.settings.token && this.settings.rootPageId) {
      this.initOrchestrator();
    }

    if (this.settings.autoSync) {
      this.startAutoSync();
    }
  }

  onunload(): void {
    this.stopAutoSync();
    this.stateDb?.close();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  initOrchestrator(): void {
    if (!this.settings.token || !this.settings.rootPageId) return;

    try {
      this.stateDb?.close();

      const dbPath = `${this.app.vault.adapter.getBasePath()}/.obsinotion/sync.db`;
      this.stateDb = StateDB.open(dbPath);

      const client = new NotionClient({
        token: this.settings.token,
        concurrency: 3,
        timeoutMs: 30000,
      });

      const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);

      const config: Config = {
        ...DEFAULT_CONFIG,
        notion: {
          token: this.settings.token,
          rootPageId: this.settings.rootPageId,
        },
        sync: {
          ...DEFAULT_CONFIG.sync,
          direction: this.settings.syncDirection,
          conflictStrategy: this.settings.conflictStrategy,
        },
        paths: {
          ...DEFAULT_CONFIG.paths,
          attachments: this.settings.attachments,
        },
      };

      this.orchestrator = new SyncOrchestrator(config, this.stateDb, client, vaultAdapter);
      this.updateStatusBar("ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`ObsiNotion 초기화 실패: ${message}`);
      this.updateStatusBar("error");
    }
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

  private async executePush(): Promise<void> {
    if (!this.orchestrator) {
      new Notice("ObsiNotion: 설정을 먼저 완료해주세요.");
      return;
    }

    this.updateStatusBar("syncing");
    new Notice("ObsiNotion: Push 시작...");

    try {
      const result = await this.orchestrator.push();

      const message = [
        `Push 완료 (${(result.duration / 1000).toFixed(1)}s)`,
        `생성 ${result.created} / 수정 ${result.updated} / 삭제 ${result.deleted}`,
      ];

      if (result.failed.length > 0) {
        message.push(`실패 ${result.failed.length}건`);
      }

      new Notice(`ObsiNotion: ${message.join("\n")}`);
      this.updateStatusBar("ready");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`ObsiNotion Push 실패: ${msg}`);
      this.updateStatusBar("error");
    }
  }

  private async executePull(): Promise<void> {
    if (!this.orchestrator) {
      new Notice("ObsiNotion: 설정을 먼저 완료해주세요.");
      return;
    }

    this.updateStatusBar("syncing");
    new Notice("ObsiNotion: Pull 시작...");

    try {
      const result = await this.orchestrator.pull();

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

      new Notice(`ObsiNotion: ${message.join("\n")}`);
      this.updateStatusBar(result.conflicts.length > 0 ? "conflict" : "ready");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`ObsiNotion Pull 실패: ${msg}`);
      this.updateStatusBar("error");
    }
  }

  private async executeSync(): Promise<void> {
    if (!this.orchestrator) {
      new Notice("ObsiNotion: 설정을 먼저 완료해주세요.");
      return;
    }

    this.updateStatusBar("syncing");
    new Notice("ObsiNotion: Sync 시작...");

    try {
      const result = await this.orchestrator.sync();

      const pullInfo = `Pull: +${result.pull.created} ~${result.pull.updated} -${result.pull.deleted}`;
      const pushInfo = `Push: +${result.push.created} ~${result.push.updated} -${result.push.deleted}`;

      const message = [`Sync 완료 (${(result.duration / 1000).toFixed(1)}s)`, pullInfo, pushInfo];

      if (result.conflicts.length > 0) {
        message.push(`충돌 ${result.conflicts.length}건`);
      }

      new Notice(`ObsiNotion: ${message.join("\n")}`);
      this.updateStatusBar(result.conflicts.length > 0 ? "conflict" : "ready");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`ObsiNotion Sync 실패: ${msg}`);
      this.updateStatusBar("error");
    }
  }

  private async showStatus(): Promise<void> {
    if (!this.orchestrator) {
      new Notice("ObsiNotion: 설정을 먼저 완료해주세요.");
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

      new Notice(`ObsiNotion 상태:\n${lines.join("\n")}`, 5000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`상태 확인 실패: ${msg}`);
    }
  }

  private updateStatusBar(state: "ready" | "syncing" | "error" | "conflict"): void {
    if (!this.statusBarEl) return;

    const labels: Record<string, string> = {
      ready: "ObsiNotion: Ready",
      syncing: "ObsiNotion: Syncing...",
      error: "ObsiNotion: Error",
      conflict: "ObsiNotion: Conflict",
    };

    this.statusBarEl.setText(labels[state] ?? "ObsiNotion");
  }
}
