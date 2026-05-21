import { ItemView, Notice, type TFile, type WorkspaceLeaf } from "obsidian";
import { mount, unmount } from "svelte";
import ViewContainer from "./ViewContainer.svelte";
import type { ViewRenderData, DBEntry, ViewConfig, ViewDataProvider } from "@im-nobsidian/core";
import type { EntryEditor } from "@im-nobsidian/core";

export const DATABASE_VIEW_TYPE = "im-nobsidian-db-view";

export class DatabaseItemView extends ItemView {
  private component: ReturnType<typeof mount> | null = null;
  private viewData: ViewRenderData | null = null;
  private availableViews: ViewConfig[] = [];
  private provider: ViewDataProvider | null = null;
  private editor: EntryEditor | null = null;
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
    editor?: EntryEditor;
  }) {
    this.provider = params.provider;
    this.editor = params.editor ?? null;
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

    const container = this.contentEl;
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
        onEntryMove: (entry: DBEntry, newGroup: string) => this.handleEntryMove(entry, newGroup),
        onDateClick: (date: string) => this.handleDateClick(date),
      },
    });
  }

  private async openEntry(entry: DBEntry) {
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (file) {
      await this.app.workspace.getLeaf(false).openFile(file as TFile);
    }
  }

  private async handleEntryMove(entry: DBEntry, newGroup: string) {
    if (!this.editor || !this.viewData?.viewConfig.groupBy) return;

    const groupProp =
      this.viewData.viewConfig.groupBy.propertyName ?? this.viewData.viewConfig.groupBy.propertyId;

    try {
      await this.editor.moveEntryToGroup(entry, groupProp, newGroup);
      new Notice(`${entry.title} → ${newGroup}`);
      await this.loadData(this.viewData.viewConfig.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`이동 실패: ${msg}`);
    }
  }

  private async handleDateClick(date: string) {
    if (!this.editor) return;

    try {
      const path = await this.editor.createEntry(this.folderPath, `새 항목 ${date}`, {
        [this.viewData?.viewConfig.datePropertyName ?? "date"]: date,
      });
      new Notice(`생성: ${path}`);
      await this.loadData(this.viewData?.viewConfig.id);

      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) {
        await this.app.workspace.getLeaf(false).openFile(file as TFile);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`생성 실패: ${msg}`);
    }
  }

  async onClose() {
    if (this.component) {
      unmount(this.component);
      this.component = null;
    }
  }
}
