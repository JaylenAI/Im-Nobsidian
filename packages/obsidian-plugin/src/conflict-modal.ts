import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import { mount, unmount } from "svelte";
import { applicableChoices, isRemoteDeletion, lineDiff } from "@im-nobsidian/core";
import type { Conflict, ResolutionChoice } from "@im-nobsidian/core";
import { choiceText } from "./conflict-choices.js";
import DiffLines from "./views/DiffLines.svelte";

export class ConflictModal extends Modal {
  private answered = false;
  /** 남은 충돌에도 같은 것을 쓴다 — 「남은 충돌도 같은 것으로」 를 켰다. */
  forRest = false;
  private diffView: ReturnType<typeof mount> | null = null;

  /**
   * @param onResolve 고른 것을 한 번 알린다. 고르지 않고 닫으면(Esc · 바깥 클릭) null — 예전에는
   *   아무것도 알리지 않아, 기다리던 해결 흐름이 멈추고 남은 충돌을 묻지 않았다(N-06).
   */
  /** @param uploads 해소 결과를 Notion 에 올리는 설정인가 — Pull만 하는 설정이면 false. */
  /** @param remaining 이 뒤에 물을 충돌 수 — 있으면 「남은 충돌도 같은 것으로」 를 보인다. */
  constructor(
    app: App,
    private readonly conflict: Conflict,
    private readonly onResolve: (choice: ResolutionChoice | null) => void,
    private readonly uploads = true,
    private readonly remaining = 0,
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
      // 줄마다 같은 자리끼리 견주면 한 줄을 끼운 것만으로 그 아래가 모두 바뀐 것으로 보였다 — 실제 줄 비교로 보인다.
      this.diffView = mount(DiffLines, {
        target: contentEl.createDiv(),
        props: {
          hunks: lineDiff(this.conflict.localContent, this.conflict.remoteContent),
          oldLabel: "로컬 (Obsidian)",
          newLabel: "원격 (Notion)",
          emptyText: "로컬과 원격의 내용이 같습니다",
        },
      });
    }

    const buttonContainer = contentEl.createDiv({ cls: "im-nobsidian-conflict-buttons" });

    if (this.remaining > 0) {
      new Setting(buttonContainer)
        .setName(`남은 충돌 ${this.remaining}개도 같은 것으로`)
        .setDesc(
          "켜고 고르면 남은 충돌을 묻지 않고 같은 것으로 풉니다. 그 선택을 쓸 수 없는 충돌(Notion 에서 지운 노트의 병합 등)은 따로 묻습니다.",
        )
        .addToggle((toggle) =>
          toggle.setValue(this.forRest).onChange((value) => {
            this.forRest = value;
          }),
        );
    }

    for (const choice of applicableChoices(this.conflict)) {
      const { label, description } = choiceText(this.conflict, choice, this.uploads);
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
    if (this.diffView) {
      void unmount(this.diffView);
      this.diffView = null;
    }
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
}
