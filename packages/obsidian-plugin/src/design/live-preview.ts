import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import {
  hasDesignMarker,
  readColumnLayout,
  readDesignLine,
  type ColumnPlace,
} from "@im-nobsidian/core";
import { columnAttributes, hasColumns } from "./columns.js";
import { DESIGN_CLASS, colorClass, styleClass } from "./design-classes.js";
import { decorateRendered, type RenderOptions } from "./render-dom.js";
import { TABLE_LINE_RE } from "./visible-text.js";

/**
 * 편집 화면(Live Preview)의 디자인 마커 (U-01).
 *
 * Obsidian 은 `%%…%%` 를 편집 화면에서 흐린 글자로 그린다 — 마커 글자가 본문에 섞여 보이고 서식은
 * 보이지 않았다. 커서가 없는 줄의 마커를 숨기고(Obsidian 이 `**` 를 숨기는 것처럼), 짝 마커 사이 글 ·
 * 블록 색이 걸린 줄을 칠한다. 원문 모드(Source mode)에서는 아무것도 하지 않는다 — 원문을 보는 자리다.
 *
 * 콜아웃 · 표는 편집 화면에서도 위젯으로 그려진다. 그 안은 읽기 보기와 같은 방식으로 칠한다.
 *
 * 펼친 Notion 컬럼은 열마다 줄에 색 줄을 긋고, 숨긴 열 구분 마커 줄에 이름표를 단다(#74).
 */
export function designLivePreview(options: RenderOptions): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;
      private readonly observer: MutationObserver;
      private frame = 0;

      constructor(private readonly view: EditorView) {
        this.decorations = buildDecorations(view);
        // 위젯은 늦게(비동기로) 그려진다 — 그려진 뒤에 칠한다.
        this.observer = new MutationObserver(() => this.scheduleWidgets());
        this.observer.observe(view.contentDOM, { childList: true, subtree: true });
        this.scheduleWidgets();
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.startState.field(editorLivePreviewField) !==
            update.state.field(editorLivePreviewField)
        ) {
          this.decorations = buildDecorations(update.view);
        }
      }

      destroy(): void {
        this.observer.disconnect();
        window.cancelAnimationFrame(this.frame);
      }

      private scheduleWidgets(): void {
        window.cancelAnimationFrame(this.frame);
        this.frame = window.requestAnimationFrame(() => decorateWidgets(this.view, options));
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/**
 * 코드 블록 줄이면 사용자가 적은 글자다 — Obsidian 마크다운 문법 트리의 노드 이름(`hmd-codeblock`)으로
 * 가린다. 인라인 코드는 줄 읽기(`readDesignLine`)가 건너뛴다.
 */
function inCodeBlock(view: EditorView, pos: number): boolean {
  return /codeblock/i.test(syntaxTree(view.state).resolveInner(pos, 1).name);
}

/** 문서마다의 컬럼 자리 — 문서(Text)는 바뀔 때마다 새 객체라 그대로 열쇠가 된다. */
const columnLayouts = new WeakMap<Text, (ColumnPlace | undefined)[]>();

function columnLayoutOf(doc: Text): (ColumnPlace | undefined)[] {
  let places = columnLayouts.get(doc);
  if (!places) {
    const text = doc.toString();
    places = hasColumns(text) ? readColumnLayout(text.split("\n")) : [];
    columnLayouts.set(doc, places);
  }
  return places;
}

function buildDecorations(view: EditorView): DecorationSet {
  if (!view.state.field(editorLivePreviewField)) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const selection = view.state.selection.ranges;
  const columns = columnLayoutOf(doc);

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      const place = columns[line.number - 1];
      const column = columnAttributes(place, place?.head === true);
      if (column) {
        ranges.push(
          Decoration.line({ class: column.className, attributes: column.attributes }).range(
            line.from,
          ),
        );
      }
      if (!hasDesignMarker(line.text) || inCodeBlock(view, line.from)) continue;
      const design = readDesignLine(line.text);
      // 커서 · 선택이 닿은 줄은 마커를 드러낸다 — 고칠 수 있어야 한다.
      const reveal = selection.some((r) => r.from <= line.to && r.to >= line.from);

      if (design.blockColor && !TABLE_LINE_RE.test(line.text)) {
        ranges.push(
          Decoration.line({
            class: `${DESIGN_CLASS.block} ${colorClass(design.blockColor)}`,
          }).range(line.from),
        );
      }
      for (const s of design.styled) {
        if (s.to > s.from) {
          ranges.push(
            Decoration.mark({ class: styleClass(s.style) }).range(
              line.from + s.from,
              line.from + s.to,
            ),
          );
        }
      }
      if (!reveal) {
        for (const m of design.markers) {
          ranges.push(Decoration.replace({}).range(line.from + m.from, line.from + m.to));
        }
      }
    }
  }
  return Decoration.set(ranges, true);
}

/** 위젯 원문 — 위젯 첫 줄부터 같은 블록(인용 접두 · 표 줄)이 이어지는 데까지. */
function widgetLines(doc: Text, firstLine: number, isTable: boolean): string[] {
  const lines: string[] = [];
  const same = isTable
    ? (text: string) => TABLE_LINE_RE.test(text)
    : (text: string) => /^[\t ]*>/.test(text);
  for (let n = firstLine; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (!same(text)) break;
    lines.push(text);
  }
  return lines;
}

/** 위젯의 그려진 내용 → 칠할 때의 원문. 내용이 다시 그려지면 새 요소라 다시 칠한다. */
const painted = new WeakMap<Element, string>();

function decorateWidgets(view: EditorView, options: RenderOptions): void {
  if (!view.state.field(editorLivePreviewField, false)) return;
  const widgets = view.contentDOM.querySelectorAll<HTMLElement>(
    ".cm-embed-block.cm-callout, .cm-embed-block.cm-table-widget",
  );
  for (const widget of Array.from(widgets)) {
    let pos: number;
    try {
      pos = view.posAtDOM(widget);
    } catch {
      continue;
    }
    const doc = view.state.doc;
    const lines = widgetLines(
      doc,
      doc.lineAt(pos).number,
      widget.classList.contains("cm-table-widget"),
    );
    const source = lines.join("\n");
    const content = widget.firstElementChild;
    // 같은 내용을 같은 원문으로 이미 칠했으면 건너뛴다 — 칠하는 것도 DOM 을 바꿔 관찰자를 다시 부른다.
    if (!content || painted.get(content) === source) continue;
    painted.set(content, source);
    decorateRendered(widget, lines, options);
  }
}
