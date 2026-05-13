import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { Conflict, ResolutionChoice } from "@im-nobsidian/core";

export class ConflictModal extends Modal {
  private readonly onResolve: (choice: ResolutionChoice) => void;

  constructor(
    app: App,
    private readonly conflict: Conflict,
    onResolve: (choice: ResolutionChoice) => void,
  ) {
    super(app);
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("im-nobsidian-conflict-modal");

    contentEl.createEl("h2", { text: "동기화 충돌" });
    contentEl.createEl("p", {
      text: `파일: ${this.conflict.syncRecord.obsidianPath}`,
      cls: "im-nobsidian-conflict-path",
    });

    const diffContainer = contentEl.createDiv({ cls: "im-nobsidian-diff-container" });
    this.renderDiff(diffContainer);

    const buttonContainer = contentEl.createDiv({ cls: "im-nobsidian-conflict-buttons" });

    new Setting(buttonContainer)
      .setName("로컬 유지")
      .setDesc("현재 Obsidian 파일을 유지합니다")
      .addButton((btn) =>
        btn
          .setButtonText("로컬 유지")
          .setCta()
          .onClick(() => this.selectChoice("local")),
      );

    new Setting(buttonContainer)
      .setName("원격 유지")
      .setDesc("Notion 버전으로 덮어씁니다")
      .addButton((btn) =>
        btn.setButtonText("원격 유지").onClick(() => this.selectChoice("remote")),
      );

    new Setting(buttonContainer)
      .setName("자동 병합")
      .setDesc("3-way merge로 두 변경사항을 합칩니다")
      .addButton((btn) => btn.setButtonText("자동 병합").onClick(() => this.selectChoice("merge")));

    new Setting(buttonContainer)
      .setName("복제")
      .setDesc("현재 파일을 유지하고 Notion 버전을 .conflict 파일로 저장합니다")
      .addButton((btn) => btn.setButtonText("복제").onClick(() => this.selectChoice("duplicate")));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private selectChoice(choice: ResolutionChoice): void {
    this.close();
    this.onResolve(choice);
  }

  private renderDiff(container: HTMLElement): void {
    const localLines = this.conflict.localContent.split("\n");
    const remoteLines = this.conflict.remoteContent.split("\n");

    const header = container.createDiv({ cls: "im-nobsidian-diff-header" });
    header.createSpan({ text: "로컬 (Obsidian)", cls: "im-nobsidian-diff-label-local" });
    header.createSpan({ text: " vs " });
    header.createSpan({ text: "원격 (Notion)", cls: "im-nobsidian-diff-label-remote" });

    const diffBody = container.createDiv({ cls: "im-nobsidian-diff-body" });

    const maxLen = Math.max(localLines.length, remoteLines.length);
    for (let i = 0; i < maxLen; i++) {
      const localLine = localLines[i];
      const remoteLine = remoteLines[i];

      if (localLine === remoteLine) {
        const line = diffBody.createDiv({ cls: "im-nobsidian-diff-line im-nobsidian-diff-same" });
        line.createSpan({ text: `  ${localLine ?? ""}` });
      } else {
        if (localLine !== undefined) {
          const line = diffBody.createDiv({
            cls: "im-nobsidian-diff-line im-nobsidian-diff-removed",
          });
          line.createSpan({ text: `- ${localLine}` });
        }
        if (remoteLine !== undefined) {
          const line = diffBody.createDiv({
            cls: "im-nobsidian-diff-line im-nobsidian-diff-added",
          });
          line.createSpan({ text: `+ ${remoteLine}` });
        }
      }
    }
  }
}
