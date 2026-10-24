// @vitest-environment happy-dom
/**
 * 펼친 Notion 컬럼의 열 경계 (#74) — 읽기 보기는 섹션마다, 편집 화면은 줄마다 칠한다.
 * 노트 모양은 실볼트(E2E 2026-10-23) 그대로다 — 앞 열의 끝 글과 다음 열 구분 마커가 한 문단에 붙어 온다.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { decorateColumnSection } from "../../src/design/columns.js";
import { designLivePreview } from "../../src/design/live-preview.js";

const NOTE = [
  "머리 문단", // 0
  "", // 1
  "%%im-nobsidian:column-list:start%%", // 2
  "%%im-nobsidian:column:ratio=18.75%%", // 3
  "", // 4
  "왼쪽 첫 글", // 5
  "", // 6
  "왼쪽 둘째 글", // 7
  "<br>", // 8
  "%%im-nobsidian:column:ratio=81.25%%", // 9
  "오른쪽 글", // 10
  "%%im-nobsidian:column-list:end%%", // 11
  "", // 12
  "꼬리 문단", // 13
].join("\n");

/** 읽기 보기가 섹션 하나(`from`~`to` 줄)를 그린 div. */
function section(from: number, to: number): HTMLElement {
  const el = document.createElement("div");
  decorateColumnSection(el, NOTE, from, to);
  return el;
}

describe("decorateColumnSection — 읽기 보기", () => {
  it("열 안의 섹션에 열 번호를, 열에서 글이 처음 나오는 섹션에 이름표를 단다", () => {
    const first = section(5, 5);
    expect(first.className).toBe("im-nobsidian-column im-nobsidian-column-head");
    expect(first.getAttribute("data-im-nobsidian-column")).toBe("0");
    expect(first.getAttribute("data-im-nobsidian-column-label")).toBe("열 1/2 · 18.75%");

    const second = section(7, 9);
    expect(second.className).toBe("im-nobsidian-column");
    expect(second.getAttribute("data-im-nobsidian-column")).toBe("0");
    expect(second.hasAttribute("data-im-nobsidian-column-label")).toBe(false);

    const right = section(10, 10);
    expect(right.getAttribute("data-im-nobsidian-column")).toBe("1");
    expect(right.getAttribute("data-im-nobsidian-column-label")).toBe("열 2/2 · 81.25%");
  });

  it("컬럼 밖 섹션 · 마커만 있는 섹션은 건드리지 않는다", () => {
    for (const [from, to] of [
      [0, 0],
      [2, 3],
      [13, 13],
    ] as const) {
      const el = section(from, to);
      expect(el.className).toBe("");
      expect(el.attributes.length).toBe(0);
    }
  });

  it("컬럼이 없는 노트는 줄을 나누지도 않는다", () => {
    const el = document.createElement("div");
    decorateColumnSection(el, "그냥 글\n\n둘째 글", 0, 2);
    expect(el.className).toBe("");
  });
});

describe("designLivePreview — 컬럼 줄", () => {
  const views: EditorView[] = [];
  afterEach(() => views.splice(0).forEach((view) => view.destroy()));

  it("열 안의 줄에 열 번호를, 숨긴 구분 마커 줄에 이름표를 단다", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: NOTE,
        selection: { anchor: 0 },
        extensions: [editorLivePreviewField, designLivePreview({ calloutColorIsCss: true })],
      }),
      parent: document.body,
    });
    views.push(view);
    const lines = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line"));

    expect(lines[0]!.className).not.toContain("im-nobsidian-column");
    expect(lines[2]!.className).not.toContain("im-nobsidian-column");
    expect(lines[3]!.className).toContain("im-nobsidian-column-head");
    expect(lines[3]!.getAttribute("data-im-nobsidian-column-label")).toBe("열 1/2 · 18.75%");
    expect(lines[3]!.textContent).toBe("");
    expect(lines[5]!.getAttribute("data-im-nobsidian-column")).toBe("0");
    expect(lines[5]!.className).not.toContain("im-nobsidian-column-head");
    expect(lines[10]!.getAttribute("data-im-nobsidian-column")).toBe("1");
    expect(lines[11]!.className).not.toContain("im-nobsidian-column");
  });
});
