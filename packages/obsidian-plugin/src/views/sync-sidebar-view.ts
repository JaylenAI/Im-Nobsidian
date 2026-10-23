import { ItemView, type WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import SyncDashboard from "./SyncDashboard.svelte";
import type { LocalChange, RemoteChange } from "@im-nobsidian/core";
import { EMPTY_DASHBOARD_STATE, type SyncDashboardState } from "../sync/sync-controller.js";

export const SYNC_SIDEBAR_TYPE = "im-notion-sync-sidebar";

interface SyncActions {
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
  onSync: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onResolveConflict: () => Promise<void>;
  onCancel: () => void;
  onOpenFile: (path: string) => void;
  onPushPath: (path: string) => Promise<void>;
  /** 로컬 변경 하나를 지난 동기화 때의 글로 되돌린다 — 되돌리기 전에 확인 창이 묻는다. */
  onDiscard: (change: LocalChange) => Promise<void>;
  onPullPath: (path: string) => Promise<void>;
  /** 변경 하나의 줄 비교 창을 연다 — 보기만 한다. */
  onShowLocalDiff: (change: LocalChange) => void;
  onShowRemoteDiff: (change: RemoteChange) => void;
  /** 패널이 보일 연결을 바꾼다 — 볼트 안 폴더 연결(ADR-038). */
  onSelectConnection: (folder: string) => Promise<void>;
}

/** 패널이 고르게 하는 연결 하나. */
export interface ConnectionOption {
  readonly folder: string;
  readonly label: string;
}

/**
 * 패널이 그리는 상태 — 동기화 상태 형태는 SyncController(SSOT)에서 가져오고, 연결 목록을 더한다. 사이드바는 상태를
 * 표시·전달만 한다. 연결이 하나면 목록이 비어 고르개를 그리지 않는다.
 */
export interface SidebarState extends SyncDashboardState {
  connections: readonly ConnectionOption[];
  activeConnection: string;
}
export type SidebarPatch = Partial<SidebarState>;
type SyncState = SidebarState;

export class SyncSidebarView extends ItemView {
  private component: ReturnType<typeof mount> | null = null;
  private actions: SyncActions | null = null;
  private stateUpdater: ((state: SyncState) => void) | null = null;
  private state: SyncState = { ...EMPTY_DASHBOARD_STATE, connections: [], activeConnection: "" };

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

  /** 처음 그릴 상태 — 패널을 연 뒤에 만들었으면 그 전에 연결들이 보낸 상태로 시작한다. 그리지는 않는다. */
  seedState(partial: SidebarPatch): void {
    this.state = { ...this.state, ...partial };
  }

  updateState(partial: SidebarPatch): void {
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
        onSelectConnection: (folder: string) => void this.actions!.onSelectConnection(folder),
      },
    });
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("im-sync-sidebar");
    this.mountOnce();
  }

  async onClose(): Promise<void> {
    if (this.component) {
      void unmount(this.component);
      this.component = null;
    }
  }
}
