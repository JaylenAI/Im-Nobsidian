import { ItemView, type WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import SyncDashboard from "./SyncDashboard.svelte";
import type { LocalChange, RemoteChange } from "@im-nobsidian/core";
import type { SyncDashboardState, SyncStatePatch } from "../sync/sync-controller.js";

export const SYNC_SIDEBAR_TYPE = "im-notion-sync-sidebar";

interface SyncActions {
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
  onSync: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onResolveConflict: () => void;
  onCancel: () => void;
  onOpenFile: (path: string) => void;
  onPushPath: (path: string) => Promise<void>;
  /** 로컬 변경 하나를 지난 동기화 때의 글로 되돌린다 — 되돌리기 전에 확인 창이 묻는다. */
  onDiscard: (change: LocalChange) => Promise<void>;
  onPullPath: (path: string) => Promise<void>;
  /** 변경 하나의 줄 비교 창을 연다 — 보기만 한다. */
  onShowLocalDiff: (change: LocalChange) => void;
  onShowRemoteDiff: (change: RemoteChange) => void;
}

// 동기화 상태 형태는 SyncController(SSOT)에서 가져온다. 사이드바는 상태를 표시·전달만 한다.
type SyncState = SyncDashboardState;

export class SyncSidebarView extends ItemView {
  private component: ReturnType<typeof mount> | null = null;
  private actions: SyncActions | null = null;
  private stateUpdater: ((state: SyncState) => void) | null = null;
  private state: SyncState = {
    lastSyncAt: null,
    lastFullScanAt: null,
    localChanges: [],
    folderMoves: [],
    remoteChanges: [],
    conflictRecords: [],
    syncState: "ready",
    operationType: null,
    progress: null,
    errorMessage: null,
    completionSummary: null,
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

  updateState(partial: SyncStatePatch): void {
    this.state = { ...this.state, ...partial };
    if (this.stateUpdater) {
      this.stateUpdater({ ...this.state });
    } else if (!this.component) {
      this.mountOnce();
    }
  }

  private mountOnce(): void {
    if (!this.actions || this.component) return;

    const container = this.contentEl;
    container.empty();

    this.component = mount(SyncDashboard, {
      target: container,
      props: {
        ...this.state,
        onReady: (updater: (state: SyncState) => void) => {
          this.stateUpdater = updater;
        },
        onPull: () => this.actions!.onPull(),
        onPush: () => this.actions!.onPush(),
        onSync: () => this.actions!.onSync(),
        onRefresh: () => this.actions!.onRefresh(),
        onCancel: () => this.actions!.onCancel(),
        onOpenFile: (path: string) => this.actions!.onOpenFile(path),
        onPushPath: (path: string) => void this.actions!.onPushPath(path),
        onDiscard: (change: LocalChange) => void this.actions!.onDiscard(change),
        onPullPath: (path: string) => void this.actions!.onPullPath(path),
        onShowLocalDiff: (change: LocalChange) => this.actions!.onShowLocalDiff(change),
        onShowRemoteDiff: (change: RemoteChange) => this.actions!.onShowRemoteDiff(change),
        onResolveConflict: () => this.actions!.onResolveConflict(),
      },
    });
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("im-sync-sidebar");
    this.mountOnce();
  }

  async onClose(): Promise<void> {
    if (this.component) {
      unmount(this.component);
      this.component = null;
    }
  }
}
