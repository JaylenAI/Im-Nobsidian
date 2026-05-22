import { ItemView, type WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import SyncDashboard from "./SyncDashboard.svelte";
import type { LocalChange, Conflict } from "@im-nobsidian/core";

export const SYNC_SIDEBAR_TYPE = "im-notion-sync-sidebar";

interface SyncActions {
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
  onSync: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onResolveConflict: () => void;
  onOpenFile: (path: string) => void;
}

interface SyncState {
  lastSyncAt: string | null;
  localChanges: LocalChange[];
  conflicts: Conflict[];
  syncState: "ready" | "syncing" | "error" | "conflict";
  progress: { current: number; total: number; currentPath: string } | null;
  errorMessage: string | null;
}

export class SyncSidebarView extends ItemView {
  private component: ReturnType<typeof mount> | null = null;
  private actions: SyncActions | null = null;
  private state: SyncState = {
    lastSyncAt: null,
    localChanges: [],
    conflicts: [],
    syncState: "ready",
    progress: null,
    errorMessage: null,
  };

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return SYNC_SIDEBAR_TYPE;
  }

  getDisplayText(): string {
    return "Im-Notion Sync";
  }

  getIcon(): string {
    return "refresh-cw";
  }

  setActions(actions: SyncActions): void {
    this.actions = actions;
  }

  updateState(partial: Partial<SyncState>): void {
    this.state = { ...this.state, ...partial };
    this.remount();
  }

  private remount(): void {
    if (!this.actions) return;

    const container = this.contentEl;
    if (this.component) {
      unmount(this.component);
      this.component = null;
    }

    container.empty();

    this.component = mount(SyncDashboard, {
      target: container,
      props: {
        ...this.state,
        onPull: () => this.actions!.onPull(),
        onPush: () => this.actions!.onPush(),
        onSync: () => this.actions!.onSync(),
        onRefresh: () => this.actions!.onRefresh(),
        onOpenFile: (path: string) => this.actions!.onOpenFile(path),
        onResolveConflict: () => this.actions!.onResolveConflict(),
      },
    });
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("im-sync-sidebar");
    this.remount();
  }

  async onClose(): Promise<void> {
    if (this.component) {
      unmount(this.component);
      this.component = null;
    }
  }
}
