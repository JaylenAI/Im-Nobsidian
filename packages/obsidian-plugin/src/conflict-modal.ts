import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { Conflict, ResolutionChoice } from "@im-nobsidian/core";
import { RESOLUTION_CHOICES } from "./conflict-choices.js";

export class ConflictModal extends Modal {
  private answered = false;

  /**
   * @param onResolve 고른 것을 한 번 알린다. 고르지 않고 닫으면(Esc · 바깥 클릭) null — 예전에는
   *   아무것도 알리지 않아, 기다리던 해결 흐름이 멈추고 남은 충돌을 묻지 않았다(N-06).
   */
  constructor(
    app: App,
    private readonly conflict: Conflict,
    private readonly onResolve: (choice: ResolutionChoice | null) => void,
  ) {
    super(app);
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

    for (const [choice, { label, description }] of Object.entries(RESOLUTION_CHOICES) as Array<
      [ResolutionChoice, (typeof RESOLUTION_CHOICES)[ResolutionChoice]]
    >) {
      new Setting(buttonContainer)
        .setName(label)
        .setDesc(description)
        .addButton((btn) => {
          btn.setButtonText(label).onClick(() => this.selectChoice(choice));
          if (choice === "local") btn.setCta();
        });
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.answer(null);
  }

  private selectChoice(choice: ResolutionChoice): void {
    this.answer(choice);
    this.close();
  }

  private answer(choice: ResolutionChoice | null): void {
    if (this.answered) return;
    this.answered = true;
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
