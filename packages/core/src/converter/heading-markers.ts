import { MARKER_BRAND_RE } from "../constants/markers.js";
import { mapOutsideCodeFences } from "../utils/md-regions.js";

/**
 * 제목 줄에 붙는 보존 마커(블록 색 · 토글 헤딩)를 제목 «아래 줄» 에 둔다.
 *
 * Obsidian 은 제목 줄의 `%%…%%` 를 제목 글자로 읽는다 — 2026-10-28 격리 Obsidian 1.12.4 실측에서
 * `metadataCache` 의 제목이 `빨간 제목 %%im-nobsidian:block-color:red%%` 였다. 개요 · `[[노트#제목]]` 제안 ·
 * 링크 해소가 그 글자를 쓰므로 `[[노트#빨간 제목]]` 이 그 제목을 찾지 못한다. 마커만 있는 줄을 제목 바로
 * 아래에 두면 제목은 깨끗하고(같은 실측), 그 줄은 주석이라 보이지 않는다.
 *
 * 변환기들은 예전 꼴(제목 줄 끝의 마커)만 안다. 그래서 pull 은 맨 끝에 내리고({@link placeHeadingMarkersBelow}),
 * push 는 맨 앞에서 다시 올린다({@link liftHeadingMarkers}). 예전 꼴로 받은 노트도 그대로 올라간다.
 */

/** 제목에서 옮기는 마커 — 블록 색과 토글 헤딩 시작. 토글 헤딩 끝(`toggle-heading:end`)은 제목에 붙지 않는다. */
const MARKER = `%%${MARKER_BRAND_RE}:(?:block-color:[a-z_]+|toggle-heading)%%`;
const MARKERS = `(?:${MARKER}[ \\t]*)+`;

const HEADING_WITH_MARKERS_RE = new RegExp(`^([\\t ]*)(#{1,6}[ \\t].*?)[ \\t]+(${MARKERS})$`, "gm");
const MARKER_LINE_AFTER_HEADING_RE = new RegExp(
  `^([\\t ]*#{1,6}[ \\t].*?)[ \\t]*\\n[\\t ]*(${MARKERS})$`,
  "gm",
);
const HEADING_LINE_RE = /^[\t ]*#{1,6}[ \t]/;
const MARKER_LINE_RE = new RegExp(`^[\\t ]*${MARKERS}$`);

/** pull — 제목 줄 끝의 마커를 제목 아래 줄로. 코드 안은 두고, 이미 내린 것은 그대로다. */
export function placeHeadingMarkersBelow(content: string): string {
  return mapOutsideCodeFences(content, (segment) =>
    segment.replace(
      HEADING_WITH_MARKERS_RE,
      (_m, indent: string, heading: string, markers: string) =>
        `${indent}${heading}\n${indent}${markers.trim()}`,
    ),
  );
}

/** push — 제목 바로 아래 줄의 마커를 제목 줄 끝으로 되올린다. 코드 안은 둔다. */
export function liftHeadingMarkers(content: string): string {
  return mapOutsideCodeFences(content, (segment) =>
    segment.replace(
      MARKER_LINE_AFTER_HEADING_RE,
      (_m, heading: string, markers: string) => `${heading} ${markers.trim()}`,
    ),
  );
}

/** 제목 줄인가. */
export function isHeadingLine(line: string): boolean {
  return HEADING_LINE_RE.test(line);
}

/** 제목 아래로 내린 마커만 있는 줄인가 — 앞줄이 제목일 때 그 제목의 것이다. */
export function isHeadingMarkerLine(line: string): boolean {
  return MARKER_LINE_RE.test(line);
}

/**
 * 한 섹션의 원문 줄 — 섹션이 제목으로 끝나고 다음 줄이 그 제목의 마커 줄이면 제목 줄 끝에 붙여 돌려준다.
 * Obsidian 은 그 마커 줄을 다음 섹션으로 가르므로, 읽기 화면이 제목을 칠하려면 다음 줄을 함께 봐야 한다.
 */
export function sectionLinesWithHeadingMarkers(
  all: readonly string[],
  start: number,
  end: number,
): string[] {
  const lines = all.slice(start, end + 1);
  const last = lines.length - 1;
  const next = all[end + 1];
  if (last >= 0 && next !== undefined && isHeadingLine(lines[last]!) && isHeadingMarkerLine(next)) {
    lines[last] = `${lines[last]} ${next.trim()}`;
  }
  return lines;
}
