import { columnLabel, readColumnLayout, type ColumnPlace } from "@im-nobsidian/core";
import { COLUMN_INDEX_ATTR, COLUMN_LABEL_ATTR, DESIGN_CLASS } from "./design-classes.js";

/**
 * 펼친 Notion 컬럼의 열 경계 (#74).
 *
 * Obsidian 은 마크다운을 옆으로 나란히 그리지 못한다 — pull 은 컬럼을 위아래로 펼치고 경계를 마커 줄로
 * 남긴다(ADR-008). 마커는 주석이라 보이지 않아, 어디까지가 한 열인지 알 수 없었다. 열마다 왼쪽에 색 줄을
 * 긋고 열의 첫 블록에 `열 2/3 · 50%` 이름표를 단다. 블록을 옮기거나 감싸지 않는다 — 읽기 보기는 섹션을
 * 스스로 다시 그리고, 편집 화면은 줄 단위다.
 */

/** 줄마다의 컬럼 자리 — 같은 원문이면 다시 읽지 않는다(읽기 보기는 섹션마다 노트 전체를 넘긴다). */
let cached: {
  text: string;
  lines: readonly string[];
  places: (ColumnPlace | undefined)[];
} | null = null;

function layoutOf(text: string): { lines: readonly string[]; places: (ColumnPlace | undefined)[] } {
  if (cached?.text !== text) {
    const lines = hasColumns(text) ? text.split("\n") : [];
    cached = { text, lines, places: lines.length > 0 ? readColumnLayout(lines) : [] };
  }
  return cached;
}

/** 컬럼 마커가 있을 수 있는가 — 없으면 줄을 나누지 않는다. */
export function hasColumns(text: string): boolean {
  return text.includes(":column-list:start%%");
}

/** 줄에 붙일 속성 — 컬럼 밖이면 null. 이름표는 `labeled` 일 때만. */
export function columnAttributes(
  place: ColumnPlace | undefined,
  labeled: boolean,
): { className: string; attributes: Record<string, string> } | null {
  if (!place) return null;
  const attributes: Record<string, string> = { [COLUMN_INDEX_ATTR]: String(place.index % 4) };
  if (labeled) attributes[COLUMN_LABEL_ATTR] = columnLabel(place);
  return {
    className: labeled ? `${DESIGN_CLASS.column} ${DESIGN_CLASS.columnHead}` : DESIGN_CLASS.column,
    attributes,
  };
}

/**
 * 읽기 보기의 섹션 하나(`lineStart`~`lineEnd` 줄)를 칠한다. 섹션의 열은 그 섹션의 첫 글 줄이 정한다 —
 * 앞 열의 끝 글과 다음 열의 구분 마커가 한 문단에 붙어 오는 노트가 있다(실볼트). 마커 줄은 그려지지 않으므로
 * 이름표는 그 열에서 글이 처음 나오는 섹션에 단다.
 */
export function decorateColumnSection(
  el: HTMLElement,
  text: string,
  lineStart: number,
  lineEnd: number,
): void {
  const { lines, places } = layoutOf(text);
  if (places.length === 0) return;
  for (let line = lineStart; line <= lineEnd && line < lines.length; line++) {
    const place = places[line];
    if (!place || place.head || lines[line]!.trim() === "") continue;
    const decoration = columnAttributes(place, firstContentOfColumn(lines, places, line));
    if (!decoration) return;
    el.classList.add(...decoration.className.split(" "));
    for (const [name, value] of Object.entries(decoration.attributes)) el.setAttribute(name, value);
    return;
  }
}

/** 이 줄 앞으로 같은 열에 글 줄이 없는가 — 구분 마커 줄 · 빈 줄만 있다. */
function firstContentOfColumn(
  lines: readonly string[],
  places: readonly (ColumnPlace | undefined)[],
  line: number,
): boolean {
  for (let prev = line - 1; prev >= 0; prev--) {
    const place = places[prev];
    if (!place) return true;
    if (place.head) return true;
    if (lines[prev]!.trim() !== "") return false;
  }
  return true;
}
