import {
  hasDesignMarker,
  readDesignLine,
  type CalloutDesign,
  type DesignLine,
  type TableLineDesign,
} from "@im-nobsidian/core";
import { DESIGN_CLASS, colorClass, colorRgbVar, styleClass } from "./design-classes.js";
import {
  TABLE_LINE_RE,
  TABLE_SEPARATOR_RE,
  blockPrefixLength,
  splitTableCells,
  toVisibleText,
} from "./visible-text.js";

/**
 * 그려진 블록(읽기 보기의 섹션 · 편집 화면의 콜아웃/표 위젯)에 디자인 마커를 칠한다 (U-01).
 *
 * 마커는 그리기 «전» 에 지워진다 — 무엇을 칠할지는 그 블록의 원문 줄로 안다. 블록 단위(콜아웃 ·
 * 표 · 문단 · 목록 항목)는 차례로 짝짓고, 글 단위(색 · 밑줄 · 멘션)는 원문 조각을 보이는 글로 바꿔
 * 그려진 글에서 차례대로 찾는다. 짝이 안 맞으면 칠하지 않는다 — 다른 블록을 칠하는 것보다 낫다.
 */
export interface RenderOptions {
  /** Obsidian 1.13 부터 `--callout-color` 는 RGB 세 값이 아니라 완전한 CSS 색이다. */
  readonly calloutColorIsCss: boolean;
}

const CALLOUT_HEAD_RE = /^[\t ]*(?:>[\t ]?)+\[![^\]]+\]/;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** 글을 찾지 않는 자리 — 코드는 사용자가 적은 글자, 나머지는 Obsidian 이 붙인 장식이다. */
const SKIP_SELECTOR =
  "code, pre, svg, .callout-icon, .callout-fold, .collapse-indicator, .table-col-drag-handle, .table-row-drag-handle, .frontmatter, .list-bullet";

export function decorateRendered(
  root: HTMLElement,
  lines: readonly string[],
  options: RenderOptions,
): void {
  if (!lines.some(hasDesignMarker)) return;
  const designs = lines.map((line) => (hasDesignMarker(line) ? readDesignLine(line) : undefined));

  decorateCallouts(root, lines, designs, options);
  decorateTables(root, lines, designs);
  decorateBlocks(root, lines, designs);
  decorateInline(root, lines, designs);
}

function decorateCallouts(
  root: HTMLElement,
  lines: readonly string[],
  designs: readonly (DesignLine | undefined)[],
  options: RenderOptions,
): void {
  const heads = lines.flatMap((line, i) => (CALLOUT_HEAD_RE.test(line) ? [designs[i]] : []));
  const callouts = Array.from(root.querySelectorAll<HTMLElement>(".callout"));
  if (heads.length === 0 || heads.length !== callouts.length) return;
  heads.forEach((design, i) => {
    if (design?.callout) applyCallout(callouts[i]!, design.callout, options);
  });
}

function applyCallout(el: HTMLElement, style: CalloutDesign, options: RenderOptions): void {
  // 토글은 테두리 · 바탕 없는 Notion 토글 모양이다(main.css) — 색은 블록 색처럼 칠한다.
  if (el.dataset.callout === "toggle") {
    if (style.color) el.classList.add(DESIGN_CLASS.block, colorClass(style.color));
    return;
  }
  if (style.color) {
    const rgb = colorRgbVar(style.color);
    el.style.setProperty("--callout-color", options.calloutColorIsCss ? `rgb(${rgb})` : rgb);
  }
  const icon = el.querySelector<HTMLElement>(":scope > .callout-title > .callout-icon");
  if (!icon || style.icon === undefined) return;
  if (style.icon === null) {
    icon.style.display = "none";
  } else if (EMOJI_RE.test(style.icon)) {
    // Notion 의 이모지 아이콘 — 내장 아이콘(경로)은 가까운 것이 없어 기본 아이콘을 둔다.
    // 아이콘 안을 바꾸지 않고 CSS 로 덮는다. 1.12.4 는 후처리기 뒤에 아이콘을 다시 그려, 바꾼 안이
    // 지워졌다(실측). 요소에 단 클래스 · 속성은 남는다.
    icon.classList.add(DESIGN_CLASS.calloutEmoji);
    icon.dataset.imNobsidianEmoji = style.icon;
  }
}

/** 표 줄 묶음 — 이어진 표 줄이 표 하나다. 구분 줄은 행이 아니라 뺀다. */
function tableBlocks(lines: readonly string[]): number[][] {
  const blocks: number[][] = [];
  let current: number[] | null = null;
  lines.forEach((line, i) => {
    if (!TABLE_LINE_RE.test(line)) {
      current = null;
      return;
    }
    if (current === null) {
      current = [];
      blocks.push(current);
    }
    if (!TABLE_SEPARATOR_RE.test(line)) current.push(i);
  });
  return blocks;
}

function decorateTables(
  root: HTMLElement,
  lines: readonly string[],
  designs: readonly (DesignLine | undefined)[],
): void {
  const blocks = tableBlocks(lines);
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>("table"));
  if (blocks.length === 0 || blocks.length !== tables.length) return;
  blocks.forEach((rows, t) => {
    const table = tables[t]!;
    const trs = Array.from(table.querySelectorAll<HTMLTableRowElement>("tr"));
    if (trs.length !== rows.length) return;
    const head = designs[rows[0]!]?.table;
    if (head?.headerRow === false) table.classList.add(DESIGN_CLASS.tableNoHeaderRow);
    rows.forEach((lineIndex, r) => {
      const cells = Array.from(trs[r]!.children) as HTMLElement[];
      applyRow(cells, designs[lineIndex]?.table, head);
    });
  });
}

function applyRow(
  cells: readonly HTMLElement[],
  row: TableLineDesign | undefined,
  head: TableLineDesign | undefined,
): void {
  cells.forEach((cell, c) => {
    if (head?.headerColumn && c === 0) cell.classList.add(DESIGN_CLASS.tableHeaderColumn);
    const color = row?.cellColors.get(c) ?? row?.rowColor ?? head?.columnColors.get(c);
    if (color) cell.classList.add(colorClass(color));
  });
}

/** 블록 색 — 문단 · 제목 · 인용은 그 요소, 목록은 그 줄의 항목(`data-line`)을 칠한다. */
function decorateBlocks(
  root: HTMLElement,
  lines: readonly string[],
  designs: readonly (DesignLine | undefined)[],
): void {
  designs.forEach((design, i) => {
    if (!design?.blockColor || TABLE_LINE_RE.test(lines[i]!) || CALLOUT_HEAD_RE.test(lines[i]!)) {
      return;
    }
    const target =
      root.querySelector<HTMLElement>(`li[data-line="${i}"]`) ??
      root.querySelector<HTMLElement>(
        ":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > blockquote",
      );
    target?.classList.add(DESIGN_CLASS.block, colorClass(design.blockColor));
  });
}

interface TextRun {
  readonly node: Text;
  readonly start: number;
}

function collectText(root: HTMLElement): { text: string; runs: TextRun[] } {
  const runs: TextRun[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIP_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    runs.push({ node: node as Text, start: text.length });
    text += (node as Text).data;
  }
  return { text, runs };
}

interface Wrap {
  readonly from: number;
  readonly to: number;
  readonly classes: string[];
}

function decorateInline(
  root: HTMLElement,
  lines: readonly string[],
  designs: readonly (DesignLine | undefined)[],
): void {
  if (!designs.some((d) => d && d.styled.length > 0)) return;
  const { text, runs } = collectText(root);
  const wraps: Wrap[] = [];
  let cursor = 0;

  lines.forEach((line, i) => {
    if (TABLE_SEPARATOR_RE.test(line)) return;
    const prefix = blockPrefixLength(line);
    const segments = designs[i]?.segments ?? [{ from: 0, to: line.length, styles: [] }];
    const table = TABLE_LINE_RE.test(line);
    for (const segment of segments) {
      if (segment.to <= prefix) continue;
      const source = line.slice(Math.max(segment.from, prefix), segment.to);
      for (const piece of table ? splitTableCells(source) : [source]) {
        const visible = toVisibleText(piece).trim();
        if (visible === "") continue;
        const at = text.indexOf(visible, cursor);
        if (at === -1) continue;
        cursor = at + visible.length;
        if (segment.styles.length > 0) {
          wraps.push({ from: at, to: cursor, classes: segment.styles.map(styleClass) });
        }
      }
    }
  });

  // 뒤에서부터 감싼다 — 앞 자리의 글 위치가 바뀌지 않는다.
  for (const wrap of wraps.reverse()) wrapRange(runs, wrap);
}

function wrapRange(runs: readonly TextRun[], { from, to, classes }: Wrap): void {
  for (let k = runs.length - 1; k >= 0; k--) {
    const { node, start } = runs[k]!;
    const end = start + node.data.length;
    if (end <= from || start >= to) continue;
    const a = Math.max(from, start) - start;
    const b = Math.min(to, end) - start;
    if (b < node.data.length) node.splitText(b);
    const target = a > 0 ? node.splitText(a) : node;
    const span = document.createElement("span");
    span.className = classes.join(" ");
    target.replaceWith(span);
    span.appendChild(target);
  }
}
