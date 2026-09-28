import { describe, it, expect, vi, afterEach } from "vitest";
import { ButtonComponent } from "obsidian";
import type { LocalChange } from "@im-nobsidian/core";
import { DiscardConfirmModal, discardPrompt } from "../src/discard-confirm-modal.js";

function change(type: LocalChange["type"], path: string): LocalChange {
  return { path, type, currentHash: type === "deleted" ? "" : "h2", previousHash: "h1" };
}

/** 연 창이 놓은 제목 · 문단과 단추(글 · 색 · 누르면 부를 것). 단추는 놓은 차례다. */
function opened(target: LocalChange, onAnswer = vi.fn()) {
  const texts = vi.spyOn(ButtonComponent.prototype, "setButtonText");
  const clicks = vi.spyOn(ButtonComponent.prototype, "onClick");
  const warnings = vi.spyOn(ButtonComponent.prototype, "setWarning");
  const ctas = vi.spyOn(ButtonComponent.prototype, "setCta");
  const modal = new DiscardConfirmModal({} as never, target, onAnswer);
  const createEl = vi.spyOn(modal.contentEl as { createEl: () => unknown }, "createEl");
  const createDiv = vi.spyOn(modal.contentEl as { createDiv: () => unknown }, "createDiv");
  const addClass = vi.spyOn(modal.modalEl as { addClass: () => void }, "addClass");
  modal.onOpen();
  return {
    modal,
    onAnswer,
    modalClasses: addClass.mock.calls.map(([cls]) => cls),
    elements: createEl.mock.calls.map(([tag, options]) => [
      tag,
      (options as { text: string }).text,
      (options as { cls?: string }).cls,
    ]),
    containers: createDiv.mock.calls.map(([options]) => (options as { cls: string }).cls),
    labels: texts.mock.calls.map(([text]) => text),
    /** 되돌리기 단추(첫째)와 취소 단추(둘째)를 누른다. */
    press: (index: number) => (clicks.mock.calls[index]![0] as () => void)(),
    warningCount: warnings.mock.calls.length,
    ctaCount: ctas.mock.calls.length,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("되돌리기 확인 창에 보일 것", () => {
  it("고친 노트는 편집이 사라진다고 말하고 단추를 경고색으로 둔다", () => {
    expect(discardPrompt(change("modified", "a/고친.md"))).toEqual({
      title: "고친 내용을 되돌릴까요?",
      body: "지난 동기화 뒤에 고친 내용이 사라지고 지난 동기화 때의 글로 돌아갑니다. Notion 은 바뀌지 않습니다.",
      confirmText: "되돌리기",
      destructive: true,
    });
  });

  it("지운 노트는 다시 만든다고 말한다 — 잃는 것이 없어 경고색이 아니다", () => {
    expect(discardPrompt(change("deleted", "지운.md"))).toEqual({
      title: "지운 노트를 되살릴까요?",
      body: "지난 동기화 때의 글로 노트를 다시 만듭니다. Notion 은 바뀌지 않습니다.",
      confirmText: "되살리기",
      destructive: false,
    });
  });
});

describe("DiscardConfirmModal", () => {
  it("열면 무엇을 되돌리는지와 그 노트의 경로, 되돌리기 · 취소 단추를 Obsidian 확인 창 모양으로 놓는다", () => {
    const view = opened(change("modified", "a/고친.md"));

    expect(view.modalClasses).toEqual(["im-nobsidian-discard-modal"]);
    expect(view.elements).toEqual([
      ["h2", "고친 내용을 되돌릴까요?", undefined],
      ["p", "a/고친.md", "im-nobsidian-conflict-path"],
      [
        "p",
        "지난 동기화 뒤에 고친 내용이 사라지고 지난 동기화 때의 글로 돌아갑니다. Notion 은 바뀌지 않습니다.",
        undefined,
      ],
    ]);
    expect(view.containers).toEqual(["modal-button-container"]);
    expect(view.labels).toEqual(["되돌리기", "취소"]);
    expect([view.warningCount, view.ctaCount]).toEqual([1, 0]);
  });

  it("지운 노트는 되살리기 단추를 주 단추 색으로 둔다", () => {
    const view = opened(change("deleted", "지운.md"));

    expect(view.labels).toEqual(["되살리기", "취소"]);
    expect([view.warningCount, view.ctaCount]).toEqual([0, 1]);
  });

  it("되돌리기를 누르면 한 번만 되돌린다고 알린다 — 닫히며 다시 알리지 않는다", () => {
    const view = opened(change("modified", "a/고친.md"));
    const close = vi.spyOn(view.modal, "close");

    view.press(0);
    view.modal.close();

    expect(close).toHaveBeenCalled();
    expect(view.onAnswer.mock.calls).toEqual([[true]]);
  });

  it("취소를 누르면 되돌리지 않는다고 한 번 알린다", () => {
    const view = opened(change("modified", "a/고친.md"));

    view.press(1);
    view.modal.close();

    expect(view.onAnswer.mock.calls).toEqual([[false]]);
  });

  it("고르지 않고 닫으면(Esc · 바깥 클릭) 되돌리지 않는다고 한 번 알린다", () => {
    const view = opened(change("deleted", "지운.md"));

    view.modal.close();
    view.modal.close();

    expect(view.onAnswer.mock.calls).toEqual([[false]]);
  });
});
