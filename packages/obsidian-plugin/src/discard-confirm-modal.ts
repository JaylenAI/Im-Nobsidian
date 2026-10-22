import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";
import type { LocalChange } from "@im-nobsidian/core";

/** 되돌리기 확인 창의 글. */
export interface DiscardPrompt {
  title: string;
  body: string;
  confirmText: string;
  /** 누르면 로컬 편집이 사라진다 — 단추를 경고색으로 둔다. */
  destructive: boolean;
}

/**
 * 무엇이 어떻게 되는지 말한다 — 고친 노트는 편집이 사라지고, 지운 노트는 다시 생긴다(잃는 것이 없다).
 * 되돌리기는 고친 노트 · 지운 노트에만 있다.
 */
export function discardPrompt(change: LocalChange): DiscardPrompt {
  if (change.type === "deleted") {
    return {
      title: "지운 노트를 되살릴까요?",
      body: "지난 동기화 때의 글로 노트를 다시 만듭니다. Notion 은 바뀌지 않습니다.",
      confirmText: "되살리기",
      destructive: false,
    };
  }
  return {
    title: "고친 내용을 되돌릴까요?",
    body: "지난 동기화 뒤에 고친 내용이 사라지고 지난 동기화 때의 글로 돌아갑니다. Notion 은 바뀌지 않습니다.",
    confirmText: "되돌리기",
    destructive: true,
  };
}

/**
 * 로컬 변경 하나를 되돌리기 전에 한 번 묻는 창 — Obsidian Git · GitHub Desktop 처럼. 예전에는 변경 패널의
 * 단추를 두 번 눌러야 했고, 처음 누르면 단추 글이 「되돌리기?」 로 바뀌었다.
 */
export class DiscardConfirmModal extends Modal {
  private answered = false;

  /**
   * @param onAnswer 누른 것을 한 번 알린다. 되돌리기를 누르지 않고 닫으면(취소 · Esc · 바깥 클릭) false.
   */
  constructor(
    app: App,
    private readonly change: LocalChange,
    private readonly onAnswer: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const prompt = discardPrompt(this.change);
    contentEl.empty();
    this.modalEl.addClass("im-nobsidian-discard-modal");

    contentEl.createEl("h2", { text: prompt.title });
    contentEl.createEl("p", { text: this.change.path, cls: "im-nobsidian-conflict-path" });
    contentEl.createEl("p", { text: prompt.body });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const confirm = new ButtonComponent(buttons)
      .setButtonText(prompt.confirmText)
      .onClick(() => this.confirm());
    // 1.13 의 setDestructive 는 그 아래 판에 없다 — 모든 판에 있는 setWarning 을 쓴다.
    if (prompt.destructive) confirm.setWarning();
    else confirm.setCta();
    new ButtonComponent(buttons).setButtonText("취소").onClick(() => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    this.answer(false);
  }

  private confirm(): void {
    this.answer(true);
    this.close();
  }

  private answer(confirmed: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.onAnswer(confirmed);
  }
}
