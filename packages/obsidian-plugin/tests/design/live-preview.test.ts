// @vitest-environment happy-dom
/**
 * 편집 화면(Live Preview) 칠하기 (U-01) — 실제 CodeMirror 편집기에 확장을 걸고 그려진 줄을 본다.
 * Obsidian 의 Live Preview 여부 필드는 스텁이 켜 둔다(`tests/helpers/obsidian-stub.ts`).
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { designLivePreview } from "../../src/design/live-preview.js";

const OPTIONS = { calloutColorIsCss: true };
const views: EditorView[] = [];

function editor(doc: string, cursor = doc.length): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [editorLivePreviewField, designLivePreview(OPTIONS)],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const lineText = (view: EditorView, n: number): string =>
  (view.contentDOM.querySelectorAll(".cm-line")[n] as HTMLElement).textContent ?? "";

const marks = (view: EditorView): string[] =>
  Array.from(view.contentDOM.querySelectorAll("span[class*=im-nobsidian-]")).map(
    (span) => `${span.className}:${span.textContent}`,
  );

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
});

describe("designLivePreview", () => {
  const DOC = [
    "A1 %%im-nobsidian:color:red%%빨간 글자%%/color%% 와 기본 글자",
    "",
    "A2 보라 배경 문단 %%im-nobsidian:block-color:purple_bg%%",
    "",
    "끝",
  ].join("\n");

  it("커서가 없는 줄은 마커를 숨기고 짝 사이 글 · 블록 색을 칠한다", () => {
    const view = editor(DOC);

    expect(lineText(view, 0)).toBe("A1 빨간 글자 와 기본 글자");
    expect(lineText(view, 2)).toBe("A2 보라 배경 문단 ");
    expect(marks(view)).toEqual(["im-nobsidian-color-red:빨간 글자"]);
    expect(view.contentDOM.querySelectorAll(".cm-line")[2]!.className).toContain(
      "im-nobsidian-block im-nobsidian-bg-purple",
    );
  });

  it("커서가 닿은 줄은 마커를 드러낸다 — 고칠 수 있어야 한다. 칠하기는 그대로", () => {
    const view = editor(DOC, 3);

    expect(lineText(view, 0)).toBe("A1 %%im-nobsidian:color:red%%빨간 글자%%/color%% 와 기본 글자");
    expect(marks(view)).toEqual(["im-nobsidian-color-red:빨간 글자"]);
    expect(lineText(view, 2)).toBe("A2 보라 배경 문단 ");
  });

  it("제목 아래로 내린 색 마커 줄은 앞 제목을 칠한다 — 마커 줄은 칠하지 않는다", () => {
    const view = editor("## 파란 제목\n%%im-nobsidian:block-color:blue%%\n\n끝");
    const lines = view.contentDOM.querySelectorAll(".cm-line");

    expect(lines[0]!.className).toContain("im-nobsidian-block im-nobsidian-color-blue");
    expect(lines[1]!.className).not.toContain("im-nobsidian-block");
    expect(lineText(view, 1)).toBe("");
  });

  it("커서가 옮겨 가면 다시 숨긴다", () => {
    const view = editor(DOC, 3);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(lineText(view, 0)).toBe("A1 빨간 글자 와 기본 글자");
  });

  it("원문 모드(Live Preview 꺼짐)에서는 아무것도 하지 않는다", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [editorLivePreviewField.init(() => false), designLivePreview(OPTIONS)],
      }),
      parent: document.body,
    });
    views.push(view);

    expect(lineText(view, 0)).toBe("A1 %%im-nobsidian:color:red%%빨간 글자%%/color%% 와 기본 글자");
    expect(marks(view)).toEqual([]);
  });

  it("인라인 코드 안의 마커 모양 글은 숨기지 않는다", () => {
    const doc = "`%%im-nobsidian:color:red%%그대로%%/color%%`\n\n끝";
    const view = editor(doc);
    expect(lineText(view, 0)).toBe("`%%im-nobsidian:color:red%%그대로%%/color%%`");
    expect(marks(view)).toEqual([]);
  });
});
