import type { DesignColor, InlineStyle } from "@im-nobsidian/core";

/**
 * 디자인 마커가 칠하는 CSS 클래스 — 색 값은 `styles/main.css` 가 테마 변수로 정한다.
 * 읽기 보기와 편집 화면이 같은 클래스를 쓴다.
 */
export const DESIGN_CLASS = {
  underline: "im-nobsidian-underline",
  mention: "im-nobsidian-mention",
  /** 블록 색이 걸린 문단 · 제목 · 목록 항목 · 인용 — 배경일 때 여백을 준다. */
  block: "im-nobsidian-block",
  tableHeaderColumn: "im-nobsidian-table-header-column",
  tableNoHeaderRow: "im-nobsidian-table-no-header-row",
  /** 아이콘을 Notion 이모지로 바꾼 콜아웃의 아이콘 자리. */
  calloutEmoji: "im-nobsidian-callout-emoji",
  /** Notion 에서 아이콘을 지운 콜아웃의 아이콘 자리 — 숨긴다. */
  calloutNoIcon: "im-nobsidian-callout-no-icon",
  /** 펼친 Notion 컬럼 안의 블록 · 줄 — 열마다 왼쪽에 색 줄을 긋는다(#74). */
  column: "im-nobsidian-column",
  /** 열의 첫 블록 · 줄 — `열 2/3 · 50%` 이름표를 단다. */
  columnHead: "im-nobsidian-column-head",
} as const;

/** 열 색을 고르는 속성 — 값은 열 번호를 {@link COLUMN_COLOR_COUNT} 로 나눈 나머지. 이름표는 {@link COLUMN_LABEL_ATTR}. */
export const COLUMN_INDEX_ATTR = "data-im-nobsidian-column";

/** 열 색의 수 — `styles.css` 의 `[data-im-nobsidian-column="1|2|3"]` 규칙 셋 + 기본색. 규칙을 늘리면 같이 늘린다. */
export const COLUMN_COLOR_COUNT = 4;
export const COLUMN_LABEL_ATTR = "data-im-nobsidian-column-label";

/** `red` → `im-nobsidian-color-red`, `red_bg` → `im-nobsidian-bg-red`. */
export function colorClass(color: DesignColor): string {
  return `im-nobsidian-${color.background ? "bg" : "color"}-${color.name}`;
}

/** 이 색의 RGB 세 값을 담은 CSS 변수 — 콜아웃 색이 쓴다. */
export function colorRgbVar(color: DesignColor): string {
  return `var(--im-nobsidian-${color.name}-rgb)`;
}

export function styleClass(style: InlineStyle): string {
  if (style.kind === "color") return colorClass(style.color);
  return style.kind === "underline" ? DESIGN_CLASS.underline : DESIGN_CLASS.mention;
}
