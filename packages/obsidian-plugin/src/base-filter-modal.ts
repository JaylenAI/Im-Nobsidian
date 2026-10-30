import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";
import type { UserBaseFilterFix } from "@im-nobsidian/core";

/**
 * 동기화가 옮긴 폴더를 가리키는 직접 만든 `.base` 의 폴더 필터를 고칠지 묻는 창. 동기화가 만든 `.base` 는 말없이
 * 고치지만, 직접 만든 것은 무엇을 보려고 만든 필터인지 몰라 묻는다 — 예전에는 그대로 두어 그 보기가 빈 표가 됐다.
 */
export class BaseFilterFixModal extends Modal {
  private answered = false;

  /**
   * @param onAnswer 고치기 true · 그대로 두기 false · 답하지 않고 닫음(Esc · 바깥 클릭) null — 다음에 다시 묻는다.
   */
  constructor(
    app: App,
    private readonly fixes: readonly UserBaseFilterFix[],
    private readonly onAnswer: (accept: boolean | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("im-nobsidian-base-filter-modal");
    contentEl.createEl("h2", { text: "직접 만든 .base 의 폴더 필터를 고칠까요?" });
    contentEl.createEl("p", {
      text: "동기화가 폴더를 옮겨, 아래 보기의 폴더 필터가 옛 폴더를 가리킵니다. 고치지 않으면 그 보기에 노트가 보이지 않습니다.",
    });
    const list = contentEl.createEl("ul");
    for (const fix of this.fixes) {
      list.createEl("li", { text: `${fix.path}: ${fix.from} → ${fix.to}` });
    }
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons)
      .setButtonText("새 폴더로 고치기")
      .setCta()
      .onClick(() => this.answer(true));
    new ButtonComponent(buttons).setButtonText("그대로 두기").onClick(() => this.answer(false));
  }

  onClose(): void {
    this.contentEl.empty();
    this.settle(null);
  }

  private answer(accept: boolean): void {
    this.settle(accept);
    this.close();
  }

  private settle(accept: boolean | null): void {
    if (this.answered) return;
    this.answered = true;
    this.onAnswer(accept);
  }
}
