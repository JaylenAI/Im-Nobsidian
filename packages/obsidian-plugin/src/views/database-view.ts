import { ItemView, type TFile, type WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import ViewContainer from "./ViewContainer.svelte";
import type { ViewRenderData, DBEntry, ViewConfig, ViewDataProvider } from "@im-nobsidian/core";

export const DATABASE_VIEW_TYPE = "im-nobsidian-db-view";

export class DatabaseItemView extends ItemView {
  private component: ReturnType<typeof mount> | null = null;
  private viewData: ViewRenderData | null = null;
  private availableViews: ViewConfig[] = [];
  private provider: ViewDataProvider | null = null;
  private databaseId: string = "";
  private folderPath: string = "";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return DATABASE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.viewData?.databaseName ?? "Database View";
  }

  getIcon(): string {
    return "database";
  }

  async setViewParams(params: {
    provider: ViewDataProvider;
    databaseId: string;
    folderPath: string;
  }) {
    this.provider = params.provider;
    this.databaseId = params.databaseId;
    this.folderPath = params.folderPath;
    await this.loadData();
  }

  private async loadData(viewId?: string) {
    if (!this.provider) return;

    const configs = await this.provider.getViewConfigs(this.databaseId);
    if (!configs) return;

    this.availableViews = configs.views;

    if (viewId) {
      this.viewData = await this.provider.buildViewData(this.databaseId, viewId, this.folderPath);
    } else {
      this.viewData = await this.provider.buildDefaultViewData(this.databaseId, this.folderPath);
    }

    this.renderView();
  }

  private renderView() {
    if (!this.viewData) return;

    const container = this.containerEl.children[1];
    if (!container) return;

    if (this.component) {
      unmount(this.component);
      this.component = null;
    }

    container.empty();

    this.component = mount(ViewContainer, {
      target: container as Element,
      props: {
        data: this.viewData,
        availableViews: this.availableViews,
        onViewChange: (viewId: string) => this.loadData(viewId),
        onEntryClick: (entry: DBEntry) => this.openEntry(entry),
        onEntryMove: (_entry: DBEntry, _newGroup: string) => {
          // Phase 4에서 구현 — 속성 변경 + Notion Push
        },
        onDateClick: (_date: string) => {
          // Phase 4에서 구현 — 새 페이지 생성
        },
      },
    });
  }

  private async openEntry(entry: DBEntry) {
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (file) {
      await this.app.workspace.getLeaf(false).openFile(file as TFile);
    }
  }

  async onClose() {
    if (this.component) {
      unmount(this.component);
      this.component = null;
    }
  }
}
