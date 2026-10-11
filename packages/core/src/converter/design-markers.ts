import {
  MARKER_BRAND_RE,
  MARKER_PAYLOAD_CHAR,
  parseAttrsPayload,
  type TableMarkerPart,
} from "../constants/markers.js";
import { NOTION_COLOR_NAMES } from "../view/color-map.js";
import type { NotionColor } from "../view/types.js";

/**
 * 디자인 마커 읽기 — 볼트 노트 한 줄에 실린 마커가 «무엇을 어디에» 칠하는지 (U-01).
 *
 * pull 은 Obsidian 에 문법이 없는 Notion 서식(글자색 · 밑줄 · 멘션 · 블록 색 · 콜아웃/토글 스타일 ·
 * 표 속성)을 `%%…%%` 마커로 싣는다(ADR-008 · F-01 · F-04). 마커는 Obsidian 주석이라 읽기 보기에서는
 * 지워지고, 편집 화면(Live Preview)에서는 글자로 보인다 — 서식은 어느 쪽에서도 보이지 않는다.
 * 플러그인 렌더러가 이 결과로 칠한다. 마커 모양의 주인이 이 패키지(`constants/markers.ts`)라 읽기도
 * 여기 둔다 — 모양을 바꾸면 이 파일과 그 시험이 같이 깨진다.
 */

/** Notion 색 하나 — `red` · `red_bg` · `red_background` 를 같은 값으로 읽는다. */
export interface DesignColor {
  readonly name: Exclude<NotionColor, "default">;
  readonly background: boolean;
}

/** 글 구간에 걸리는 서식. */
export type InlineStyle =
  | { readonly kind: "color"; readonly color: DesignColor }
  | { readonly kind: "underline" }
  | { readonly kind: "mention" };

/** 줄 안의 글자 위치 `[from, to)`. */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

export interface StyledRange extends LineRange {
  readonly style: InlineStyle;
}

/** 마커를 걷어 낸 글 조각과 그 조각에 걸린 서식 — 마커가 없는 글도 조각이 된다(서식 없음). */
export interface DesignSegment extends LineRange {
  readonly text: string;
  readonly styles: readonly InlineStyle[];
}

/**
 * 콜아웃 · 토글 머리 줄의 스타일. `icon` 이 null 이면 Notion 에서 아이콘이 없는 콜아웃이다
 * (마커에 icon 이 없다). 토글은 아이콘을 싣지 않는다(undefined).
 */
export interface CalloutDesign {
  readonly color?: DesignColor;
  readonly icon?: string | null;
}

/** 표 한 줄(행)의 속성 — 셀 번호는 0 부터, 파이프 사이 칸 차례다. */
export interface TableLineDesign {
  readonly headerRow?: boolean;
  readonly headerColumn?: boolean;
  readonly rowColor?: DesignColor;
  /** 셀 번호 → 셀 색. */
  readonly cellColors: ReadonlyMap<number, DesignColor>;
  /** 셀 번호 → 열 색(머리 행의 `table-col` 마커가 그 열 전체에 건다). */
  readonly columnColors: ReadonlyMap<number, DesignColor>;
}

export interface DesignLine {
  /** 줄에 있는 우리 마커 전부 — 편집 화면이 숨긴다. 짝이 맞은 닫는 토큰(`%%/color%%` 등)도 든다. */
  readonly markers: readonly LineRange[];
  /** 짝 마커 사이의 글 — 편집 화면이 칠한다. */
  readonly styled: readonly StyledRange[];
  /** 마커를 걷어 낸 차례대로의 글 조각 — 읽기 보기가 그려진 글과 맞춰 칠한다. */
  readonly segments: readonly DesignSegment[];
  readonly blockColor?: DesignColor;
  /** 콜아웃 · 토글 머리 줄의 스타일. */
  readonly callout?: CalloutDesign;
  readonly table?: TableLineDesign;
}

const PAIRED_KINDS = ["color", "underline", "mention"] as const;
type PairedKind = (typeof PAIRED_KINDS)[number];

/** 우리 마커 하나(공백형 · 압축형) 또는 짝 마커의 닫는 토큰. */
const TOKEN_RE = new RegExp(
  `%%\\s*${MARKER_BRAND_RE}:(${MARKER_PAYLOAD_CHAR}*?)\\s*%%|%%/(${PAIRED_KINDS.join("|")})%%`,
  "g",
);

const BRAND_PROBE_RE = new RegExp(`%%\\s*${MARKER_BRAND_RE}:`);

/** 이 글에 우리 마커가 하나라도 있나 — 렌더러가 마커 없는 블록을 건너뛰는 데 쓴다. */
export function hasDesignMarker(text: string): boolean {
  return BRAND_PROBE_RE.test(text);
}

const COLOR_TOKEN_RE = /^([a-z]+)(?:_(?:bg|background))?$/;

/** Notion 색 토큰을 읽는다. `default` · 모르는 색은 칠할 것이 없다(undefined). */
export function parseDesignColor(token: string | undefined): DesignColor | undefined {
  const match = token === undefined ? null : COLOR_TOKEN_RE.exec(token);
  const name = match?.[1] as NotionColor | undefined;
  if (name === undefined || name === "default" || !NOTION_COLOR_NAMES.includes(name)) {
    return undefined;
  }
  return { name, background: token !== name };
}

/**
 * 인라인 코드 구간 — 그 안의 마커 모양 글은 사용자가 적은 글자다. 여는 백틱 줄과 길이가 같은
 * 다음 백틱 줄이 닫는다(CommonMark). 닫히지 않은 백틱은 글자다.
 */
function inlineCodeRanges(line: string): LineRange[] {
  const ranges: LineRange[] = [];
  const open = /`+/g;
  let start: RegExpExecArray | null;
  while ((start = open.exec(line)) !== null) {
    const close = new RegExp(`(?<!\`)${"`".repeat(start[0].length)}(?!\`)`, "g");
    close.lastIndex = start.index + start[0].length;
    const end = close.exec(line);
    if (end === null) continue;
    ranges.push({ from: start.index, to: end.index + end[0].length });
    open.lastIndex = end.index + end[0].length;
  }
  return ranges;
}

const inside = (ranges: readonly LineRange[], at: number): boolean =>
  ranges.some((r) => at >= r.from && at < r.to);

/** 표 줄이면 `at` 앞의 파이프 수로 셀 번호를 센다(코드 · 이스케이프 `\|` 는 빼고). */
function cellIndexAt(line: string, at: number, code: readonly LineRange[]): number {
  let pipes = 0;
  for (let i = 0; i < at; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\" && !inside(code, i)) pipes++;
  }
  return pipes - 1;
}

const TABLE_LINE_RE = /^[\t >]*\|/;

interface OpenMarker {
  readonly kind: PairedKind;
  readonly style: InlineStyle;
  readonly to: number;
}

interface TableAccumulator {
  headerRow?: boolean;
  headerColumn?: boolean;
  rowColor?: DesignColor;
  cellColors: Map<number, DesignColor>;
  columnColors: Map<number, DesignColor>;
}

function readTableMarker(
  table: TableAccumulator,
  part: TableMarkerPart,
  payload: string,
  cell: number,
): void {
  const attrs = new Map(parseAttrsPayload(payload));
  const color = parseDesignColor(attrs.get("color"));
  if (part === "table") {
    if (attrs.has("header-row")) table.headerRow = attrs.get("header-row") === "true";
    if (attrs.has("header-column")) table.headerColumn = attrs.get("header-column") === "true";
  } else if (part === "table-row" && color) {
    table.rowColor = color;
  } else if (part === "table-cell" && color) {
    table.cellColors.set(cell, color);
  } else if (part === "table-col" && color) {
    table.columnColors.set(cell, color);
  }
}

function readCalloutStyle(payload: string): CalloutDesign {
  const attrs = new Map(parseAttrsPayload(payload));
  return { color: parseDesignColor(attrs.get("color")), icon: attrs.get("icon") || null };
}

/** 모르는 색의 짝 — 짝 맞춤에만 쓰고 결과에서는 뺀다. */
const NO_STYLE: InlineStyle = { kind: "mention" };

/** 한 줄을 읽는다. 마커가 없는 줄은 글 조각 하나뿐인 결과를 돌려준다. */
export function readDesignLine(line: string): DesignLine {
  const code = inlineCodeRanges(line);
  const isTable = TABLE_LINE_RE.test(line);
  const markers: LineRange[] = [];
  const styled: StyledRange[] = [];
  const open: OpenMarker[] = [];
  const table: TableAccumulator = { cellColors: new Map(), columnColors: new Map() };
  let blockColor: DesignColor | undefined;
  let callout: CalloutDesign | undefined;
  let sawTable = false;

  for (const token of line.matchAll(TOKEN_RE)) {
    const from = token.index;
    const to = from + token[0].length;
    if (inside(code, from)) continue;

    const closing = token[2] as PairedKind | undefined;
    if (closing !== undefined) {
      const at = open.map((o) => o.kind).lastIndexOf(closing);
      if (at === -1) continue; // 짝 없는 닫는 토큰은 우리 것이 아니다 — 숨기지 않는다
      const [opener] = open.splice(at, 1);
      styled.push({ from: opener!.to, to: from, style: opener!.style });
      markers.push({ from, to });
      continue;
    }

    markers.push({ from, to });
    const body = token[1]!;
    const colon = body.indexOf(":");
    const kind = colon === -1 ? body : body.slice(0, colon);
    const payload = colon === -1 ? "" : body.slice(colon + 1);

    if (kind === "color") {
      const color = parseDesignColor(payload);
      // 모르는 색도 짝은 맞춘다 — 닫는 토큰을 숨기고 글은 칠하지 않는다.
      open.push({ kind: "color", style: color ? { kind: "color", color } : NO_STYLE, to });
    } else if (kind === "underline") {
      open.push({ kind: "underline", style: { kind: "underline" }, to });
    } else if (kind.startsWith("mention-")) {
      open.push({ kind: "mention", style: { kind: "mention" }, to });
    } else if (kind === "block-color") {
      blockColor = parseDesignColor(payload) ?? blockColor;
    } else if (kind === "callout-style") {
      callout = readCalloutStyle(payload);
    } else if (kind === "toggle-color") {
      callout = { color: parseDesignColor(payload) };
    } else if (isTable && isTablePart(kind)) {
      sawTable = true;
      readTableMarker(table, kind, payload, cellIndexAt(line, from, code));
    }
  }

  // 바깥 짝이 먼저 — 닫는 차례(안쪽부터)가 아니라 여는 차례로 둔다. 여는 마커마다 길이가 있어
  // 두 짝의 시작이 같을 수 없다.
  const realStyled = styled.filter((s) => s.style !== NO_STYLE).sort((a, b) => a.from - b.from);
  return {
    markers,
    styled: realStyled,
    segments: segmentsOf(line, markers, realStyled),
    ...(blockColor ? { blockColor } : {}),
    ...(callout ? { callout } : {}),
    ...(sawTable ? { table } : {}),
  };
}

function isTablePart(kind: string): kind is TableMarkerPart {
  return kind === "table" || kind === "table-col" || kind === "table-row" || kind === "table-cell";
}

function segmentsOf(
  line: string,
  markers: readonly LineRange[],
  styled: readonly StyledRange[],
): DesignSegment[] {
  const sorted = [...markers].sort((a, b) => a.from - b.from);
  const segments: DesignSegment[] = [];
  let at = 0;
  for (const cut of [...sorted, { from: line.length, to: line.length }]) {
    if (cut.from > at) {
      const from = at;
      const to = cut.from;
      segments.push({
        from,
        to,
        text: line.slice(from, to),
        styles: styled.filter((s) => s.from <= from && s.to >= to).map((s) => s.style),
      });
    }
    at = Math.max(at, cut.to);
  }
  return segments;
}
