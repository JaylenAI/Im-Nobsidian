import { Modal } from "obsidian";
import type { App } from "obsidian";
import { mount, unmount } from "svelte";
import ChangeDiffView from "./views/ChangeDiffView.svelte";
import type { ChangeDiffSource } from "./change-diff-text.js";

/**
 * 변경 하나의 줄 비교 창 — 변경 패널에서 항목을 누르면 연다(Obsidian Git 의 diff 보기처럼). 보기만 한다.
 */
export class ChangeDiffModal extends Modal {
  private view: ReturnType<typeof mount> | null = null;

  constructor(
    app: App,
    private readonly source: ChangeDiffSource,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, source } = this;
    contentEl.empty();
    this.modalEl.addClass("im-nobsidian-change-diff-modal");

    contentEl.createEl("h2", { text: source.title });
    contentEl.createEl("p", { text: source.caption, cls: "im-nobsidian-conflict-path" });
    this.view = mount(ChangeDiffView, {
      target: contentEl.createDiv(),
      props: {
        load: source.load,
        oldLabel: source.oldLabel,
        newLabel: source.newLabel,
        emptyText: source.emptyText,
      },
    });
  }

  onClose(): void {
    if (this.view) {
      void unmount(this.view);
      this.view = null;
    }
    this.contentEl.empty();
  }
}
