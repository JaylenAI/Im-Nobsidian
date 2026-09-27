import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import { applicableChoices, isRemoteDeletion } from "@im-nobsidian/core";
import type { Conflict, ResolutionChoice } from "@im-nobsidian/core";
import { choiceText } from "./conflict-choices.js";

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

    if (isRemoteDeletion(this.conflict)) {
      // 견줄 원격 본문이 없다 — 줄 비교는 로컬 전부를 지운 것으로 보여 준다.
      contentEl.createEl("p", {
        text: "Notion 에서 삭제된 노트입니다 — Notion 에 올리지 않은 로컬 편집이 남아 있습니다.",
        cls: "im-nobsidian-conflict-remote-deleted",
      });
    } else {
      const diffContainer = contentEl.createDiv({ cls: "im-nobsidian-diff-container" });
      this.renderDiff(diffContainer);
    }

    const buttonContainer = contentEl.createDiv({ cls: "im-nobsidian-conflict-buttons" });

    for (const choice of applicableChoices(this.conflict)) {
      const { label, description } = choiceText(this.conflict, choice);
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
