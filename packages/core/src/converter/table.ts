/**
 * Notion 표 ↔ 볼트 파이프 표 (F-04).
 *
 * NFM 은 표를 `<table fit-page-width header-row header-column>` · `<colgroup><col color width>` ·
 * `<tr color>` · `<td color>` 로 내보낸다(2026-10-04 실측). 파이프 표에는 이 속성을 적을 자리가 없어
 * 예전 pull 은 속성을 버렸고, 다음 push 가 머리 열 · 열 너비 · 행/셀/열 색을 Notion 에서 지웠다.
 * 머리 행이 없는 표는 머리 행 표가 됐다 — 파이프 표를 받은 Notion 은 `header-row="true"` 표를 만든다.
 *
 * pull 은 속성을 셀 머리의 마커({@link tableMarker})에 싣는다 — 표 · 열은 첫 행의 셀, 행은 그 행의
 * 첫 셀, 셀은 그 셀이다. 표 셀 안의 `%%…%%` 는 읽기 보기 · Live Preview 둘 다 숨긴다(Obsidian 1.13.7
 * 실측). 마커가 셀과 함께 움직이므로 Obsidian 에서 행 · 열을 옮기거나 끼워도 속성이 제 자리에 남는다.
 *
 * push 는 마커가 하나라도 있는 표만 NFM 표로 되돌린다. 마커가 없는 표는 지금처럼 파이프 표로 보낸다.
 *
 * 인용(콜아웃 · 토글) 안에서 글 바로 뒤에 붙은 파이프 표는 표가 아니다 — 앞 문단 · 목록 항목 · 표에
 * 이어지는 글이 된다(Obsidian 1.13.7 실측). 그래서 pull 은 그 자리에 빈 인용 줄을 끼운다. push 는 앞
 * 표 바로 뒤의 표를 NFM 표로 보낸다 — 파이프 표 둘을 보내면 Notion 이 콜아웃 안에서는 사이의 빈 줄을
 * 버리고 한 표로 합쳐, 둘째 표의 구분행을 `---` 글 행으로 넣는다(2026-10-04 실측).
 */
import {
  MARKER_BRAND_RE,
  MARKER_PAYLOAD_CHAR,
  TABLE_MARKER_PARTS,
  parseAttrsPayload,
  tableMarker,
  type TableMarkerPart,
} from "../constants/markers.js";
import {
  CONTAINER_PREFIX_SOURCE,
  classifyContainerLines,
  codeInteriorRanges,
  isInsideRanges,
  nfmOpenTagSource,
  splitContainerPrefix,
} from "./container-indent.js";
import { nfmAttrString, parseNfmAttrs, type NfmAttrs } from "./nfm-attrs.js";

/**
 * 파이프 표를 받은 Notion 이 만드는 표 속성 — 새 파이프 표를 push 하면 `<table header-row="true">`
 * 로 돌아온다(2026-10-04 실측). 이 속성뿐인 표는 마커 없이 파이프 표로 둔다 — 그대로 push 해도
 * 같은 표가 된다.
 */
const PIPE_TABLE_ATTRS: NfmAttrs = [["header-row", "true"]];

// ─── pull: NFM 표 → 파이프 표 ───

/**
 * NFM 표 블록. 선행 그룹으로 **컨테이너 접두**(들여쓰기 + 인용 마커)를 함께 잡는다.
 *
 * NFM 의 비대칭 들여쓰기 때문이다 — `<table>` 태그 줄만 구조 들여쓰기를 갖고 `<tr>/<td>`
 * 는 열 0 에 있다. 접두를 잡지 않고 치환하면 **첫 행만** 접두를 물려받고 나머지 행은
 * 열 0 으로 떨어진다. 그러면 (a) 콜아웃이 그 자리에서 끊기고 (b) 구분행이 표 헤더와
 * 분리돼 표가 통째로 죽는다(결함⑧⑨ — 실측 96건·15노트).
 *
 * 여는 태그는 {@link nfmOpenTagSource} 로 **이름 경계까지** 확인한다. 이름 뒤를 열어
 * 두면 `<table_of_contents/>` 가 여는 표로 잡혀 거기서 첫 `</table>` 까지의 본문이
 * 통째로 사라진다.
 */
const NOTION_TABLE_RE = new RegExp(
  `^(${CONTAINER_PREFIX_SOURCE})${nfmOpenTagSource("table", "capture")}([\\s\\S]*?)</table>`,
  "gm",
);
/**
 * 표 행. **속성을 허용**해야 한다 — Notion 은 배경색이 지정된 행을
 * `<tr color="gray_bg">` 로 내보내고, 그 행은 대개 헤더 행이다.
 *
 * `<tr>` 만 잡으면 그 행이 통째로 조용히 사라진다. 표는 행 수만 하나 줄어든 채
 * 멀쩡해 보이고, 다음 행이 헤더 자리로 승격돼 표의 의미가 바뀐다
 * (실측: `5단계(22~28일)` 노트에서 `**결과**|**이유**|**해결책**` 헤더 소실).
 */
const TABLE_ROW_RE = /<tr(\s[^>]*)?>([\s\S]*?)<\/tr>/g;
const TABLE_CELL_RE = /<t([dh])(\s[^>]*)?>([\s\S]*?)<\/t\1>/g;
const ROW_START_RE = /<tr[\s>]/;
const COLGROUP_RE = /<colgroup>([\s\S]*?)<\/colgroup>/;
/** 열 하나. 지금 export 는 `<col width="120">`, 옛 export 는 `<col width="120"/>` 다(둘 다 실측). */
const COL_RE = /<col(\s[^>]*?)?\s*\/?>/g;

interface NfmCell {
  readonly attrs: NfmAttrs;
  readonly text: string;
}

interface NfmRow {
  readonly attrs: NfmAttrs;
  readonly cells: readonly NfmCell[];
}

function isAlignmentRow(cells: readonly NfmCell[]): boolean {
  return cells.every((c) => /^:?-{2,}:?$/.test(c.text.trim()));
}

/**
 * 셀 내용을 파이프 표 한 칸에 안전하게 담는다.
 *
 * 줄바꿈은 행 자체를 끊어 표를 죽이므로 `<br>` 로 접고(Obsidian 표가 렌더하는 유일한
 * 줄바꿈 표현), 셀 안 파이프는 열 경계로 오인되므로 이스케이프한다. 이스케이프 형태는
 * pull 뒷단 `unescapePipes` 가 되돌리지 않도록 표 밖 규칙과 구분되는 `\|` 를 쓴다.
 */
function toTableCell(raw: string): string {
  return raw
    .trim()
    .replace(/\r?\n/g, "<br>")
    .replace(/(?<!\\)\|/g, "\\|");
}

function parseRows(body: string): NfmRow[] {
  const rows: NfmRow[] = [];
  for (const row of body.matchAll(TABLE_ROW_RE)) {
    const cells = [...row[2]!.matchAll(TABLE_CELL_RE)].map((cell) => ({
      attrs: parseNfmAttrs(cell[2] ?? ""),
      text: toTableCell(cell[3]!),
    }));
    if (!isAlignmentRow(cells)) rows.push({ attrs: parseNfmAttrs(row[1] ?? ""), cells });
  }
  return rows;
}

/** 열마다의 속성 — `<colgroup>` 은 첫 행 앞에만 온다. 열 수만큼 `<col>` 이 온다(실측). */
function parseCols(body: string): NfmAttrs[] {
  const head = body.search(ROW_START_RE);
  const group = COLGROUP_RE.exec(head === -1 ? body : body.slice(0, head))?.[1] ?? "";
  return [...group.matchAll(COL_RE)].map((col) => parseNfmAttrs(col[1] ?? ""));
}

function sameAttrs(a: NfmAttrs, b: NfmAttrs): boolean {
  return a.length === b.length && a.every(([k, v]) => b.some(([bk, bv]) => bk === k && bv === v));
}

/**
 * 표 마커에 싣는 속성 — 파이프 표 그대로 되돌릴 수 있는 표면 싣지 않는다.
 *
 * 빠진 속성은 거짓이라(NFM 문서) 머리 행이 없는 표는 속성 없이 온다. 마커에는 `header-row=false` 를
 * 적는다 — 파이프 표의 첫 행은 머리 행처럼 보이므로 읽는 사람이 알아야 한다.
 */
function tableMarkerAttrs(attrs: NfmAttrs): NfmAttrs | undefined {
  const explicit: NfmAttrs = attrs.some(([k]) => k === "header-row")
    ? attrs
    : [["header-row", "false"], ...attrs];
  return sameAttrs(explicit, PIPE_TABLE_ATTRS) ? undefined : explicit;
}

function toPipeTable(prefix: string, attrs: NfmAttrs, cols: NfmAttrs[], rows: NfmRow[]): string {
  const colCount = Math.max(cols.length, ...rows.map((r) => r.cells.length));
  const table = tableMarkerAttrs(attrs);
  const lines = rows.map((row, r) => {
    const cells = Array.from({ length: colCount }, (_, c) => {
      const cell = row.cells[c];
      const col = r === 0 ? cols[c] : undefined;
      const markers = [
        r === 0 && c === 0 && table ? tableMarker("table", table) : "",
        col?.length ? tableMarker("table-col", col) : "",
        c === 0 && row.attrs.length > 0 ? tableMarker("table-row", row.attrs) : "",
        cell?.attrs.length ? tableMarker("table-cell", cell.attrs) : "",
      ];
      return `${markers.join("")}${cell?.text ?? ""}`;
    });
    return `| ${cells.join(" | ")} |`;
  });
  lines.splice(1, 0, `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`);
  // 표를 감싼 컨테이너의 접두를 **모든 행**에 입힌다 — 첫 행에만 남으면 표가 죽는다.
  return lines.map((line) => prefix + line).join("\n");
}

/** 바로 뒤에 표가 와도 되는 줄 — 제목 · 콜아웃 머리 줄. 표가 이어 붙지 않는다(1.13.7 실측). */
const TABLE_MAY_FOLLOW_RE = /^(?:#{1,6}\s|\[!)/;

/**
 * 표 앞에 끼울 빈 줄 — 앞 줄이 같은 인용의 글이면 그 인용의 빈 인용 줄(`>`)을, 맨 바깥이면 빈 줄을,
 * 아니면 빈 글을 돌려준다.
 *
 * 붙은 표는 앞 문단 · 목록 항목 · 표에 이어지는 글이 된다(실볼트 인용 안 38개 · 6노트). 붙은 두 표는
 * 한 표로 합쳐 보인다. 맨 바깥에서는 BlockSpacer 가 이어진 표 줄을 한 블록으로 묶어 두 표 사이를
 * 띄우지 못한다 — 빈 줄이 그 경계를 알린다. 목록 자식 표는 띄우지 않는다 — 빈 줄 뒤 4칸 들여쓴 표는
 * 첫 칸이 빈 다른 표로 그려진다(1.13.7 실측).
 */
function separatorBefore(content: string, offset: number, prefix: string): string {
  const quoteEnd = prefix.lastIndexOf(">");
  if (offset === 0 || (quoteEnd === -1 && prefix !== "")) return "";
  const quote = prefix.slice(0, quoteEnd + 1);
  const previous = content.slice(content.lastIndexOf("\n", offset - 2) + 1, offset - 1);
  if (!previous.startsWith(quote)) return "";
  const text = previous.slice(quote.length).trim();
  return text !== "" && !TABLE_MAY_FOLLOW_RE.test(text) ? `${quote}\n` : "";
}

/** NFM 표를 파이프 표로 — 속성은 셀 머리의 마커로 싣는다. */
export function nfmTablesToPipeTables(content: string): string {
  // 코드블록 안의 `<table>` 은 사용자가 적어 둔 **예제 코드**다. 구조로 오인해 치환하면
  // 그 자리에서 통째로 사라진다(실측: 한 노트 `<table` 29→4 · `<tr` 158→1).
  const code = codeInteriorRanges(content);
  return content.replace(
    NOTION_TABLE_RE,
    (match: string, prefix: string, attrs: string, body: string, offset: number) => {
      if (isInsideRanges(code, offset)) return match;
      const rows = parseRows(body);
      if (rows.length === 0) return match;
      return (
        separatorBefore(content, offset, prefix) +
        toPipeTable(prefix, parseNfmAttrs(attrs), parseCols(body), rows)
      );
    },
  );
}

// ─── push: 파이프 표 → NFM 표 ───

const TABLE_MARKER_SOURCE = `%%${MARKER_BRAND_RE}:(${TABLE_MARKER_PARTS.join("|")}):(${MARKER_PAYLOAD_CHAR}*?)%%`;
const TABLE_MARKER_RE = new RegExp(TABLE_MARKER_SOURCE, "g");
const HAS_TABLE_MARKER_RE = new RegExp(TABLE_MARKER_SOURCE);

/** 구분행 — `| --- | :-: |`. 칸이 하나인 표도 파이프는 하나 있다. */
const DELIMITER_ROW_RE = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;
const CELL_PIPE_RE = /(?<!\\)\|/;

function isDelimiterRow(body: string): boolean {
  const row = body.trim();
  return row.includes("|") && DELIMITER_ROW_RE.test(row);
}

function isPipeRow(body: string): boolean {
  return body.trim() !== "" && CELL_PIPE_RE.test(body);
}

/** 파이프 표 한 행을 칸으로 — 앞뒤 파이프를 떼고, 이스케이프하지 않은 파이프에서 자른다. */
function splitPipeRow(body: string): string[] {
  let row = body.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(CELL_PIPE_RE).map((cell) => cell.trim());
}

/** 마커를 걷어 내며 속성을 모은다. 같은 자리의 마커가 둘이면 앞의 것을 쓴다. */
class TableAttrs {
  table: NfmAttrs | undefined;
  readonly cols: Array<NfmAttrs | undefined> = [];

  /** 셀 하나의 마커를 걷는다 — 행 · 셀 속성은 돌려주고 표 · 열 속성은 모아 둔다. */
  take(cell: string, col: number): { text: string; row?: NfmAttrs; cell?: NfmAttrs } {
    const found: { row?: NfmAttrs; cell?: NfmAttrs } = {};
    const text = cell.replace(TABLE_MARKER_RE, (_m, part: TableMarkerPart, payload: string) => {
      const attrs = parseAttrsPayload(payload);
      if (part === "table") this.table ??= attrs;
      else if (part === "table-col") this.cols[col] ??= attrs;
      else if (part === "table-row") found.row ??= attrs;
      else found.cell ??= attrs;
      return "";
    });
    return { text: text.trim(), ...found };
  }
}

/** 마커가 든 파이프 표 한 개(머리 · 구분 · 몸 행)를 NFM 표 줄로. */
function toNfmTable(prefix: string, bodies: readonly string[]): string[] {
  const rows = bodies.filter((_, k) => k !== 1).map(splitPipeRow);
  // Notion 도 머리보다 칸이 많은 행을 버리지 않고 머리를 늘린다(2026-10-04 실측).
  const colCount = Math.max(...rows.map((r) => r.length));
  const attrs = new TableAttrs();
  const trs = rows.flatMap((cells) => {
    let rowAttrs: NfmAttrs | undefined;
    const tds = Array.from({ length: colCount }, (_, c) => {
      const taken = attrs.take(cells[c] ?? "", c);
      rowAttrs ??= taken.row;
      return `<td${nfmAttrString(taken.cell ?? [])}>${taken.text}</td>`;
    });
    return [`<tr${nfmAttrString(rowAttrs ?? [])}>`, ...tds, "</tr>"];
  });
  // 속성 없는 열은 `<col>` 로 자리를 지킨다 — `<col/>` 은 Notion 이 건너뛰어 뒤 열의 속성이
  // 한 칸씩 당겨진다(2026-10-04 실측).
  const colgroup = attrs.cols.some((col) => col !== undefined)
    ? [
        "<colgroup>",
        ...Array.from({ length: colCount }, (_, c) => `<col${nfmAttrString(attrs.cols[c] ?? [])}>`),
        "</colgroup>",
      ]
    : [];
  // 거짓 속성은 적지 않는다 — Notion 도 빠진 속성을 거짓으로 읽고 그렇게 내보낸다. 값을 적은
  // 속성을 HTML 처럼 «있으면 참» 으로 읽을 수도 있어 `header-row="false"` 를 보내지 않는다.
  const table = (attrs.table ?? PIPE_TABLE_ATTRS).filter(([, v]) => v !== "false");
  return [`<table${nfmAttrString(table)}>`, ...colgroup, ...trs, "</table>"].map(
    (line) => prefix + line,
  );
}

/**
 * 표 마커가 든 파이프 표를 NFM 표로 — {@link nfmTablesToPipeTables} 의 반대.
 *
 * 컨테이너 접두는 표의 모든 줄에 그대로 입힌다. 콜아웃 변환이 그 접두를 탭으로 바꾸고, Notion 은
 * 탭으로 들여쓴 `<tr>` · `<td>` 도 표로 읽는다(2026-10-04 실측). 코드 안의 표는 코드다.
 *
 * 앞 표 바로 뒤의 표(사이에 빈 줄만 있거나 붙은 것)는 마커가 없어도 NFM 표로 보낸다 — 태그가 두
 * 표의 경계를 적는다. 붙은 표는 둘째 표의 머리 · 구분행에서 가른다 — 예전 pull 이 인용 안 표를 붙여
 * 받았다.
 */
export function pipeTablesToNfmTables(content: string): string {
  const lines = content.split("\n");
  const parts = lines.map(splitContainerPrefix);
  const kinds = classifyContainerLines(parts.map((p) => p.body));
  const prose = (i: number) => kinds[i] === "prose";
  const startsTable = (i: number) => {
    const head = parts[i];
    const delimiter = parts[i + 1];
    return (
      head !== undefined &&
      prose(i) &&
      prose(i + 1) &&
      isPipeRow(head.body) &&
      delimiter?.prefix === head.prefix &&
      isDelimiterRow(delimiter.body)
    );
  };
  const out: string[] = [];
  /** 바로 앞 표 — 끝난 줄과 접두. */
  let previous: { end: number; prefix: string } | undefined;
  let i = 0;
  while (i < lines.length) {
    const head = parts[i]!;
    if (!startsTable(i)) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let end = i + 2;
    while (
      end < lines.length &&
      prose(end) &&
      parts[end]!.prefix === head.prefix &&
      isPipeRow(parts[end]!.body) &&
      !startsTable(end)
    ) {
      end++;
    }
    const afterTable =
      previous?.prefix === head.prefix &&
      parts.slice(previous.end, i).every((p) => p.body.trim() === "");
    const table = lines.slice(i, end);
    if (afterTable || HAS_TABLE_MARKER_RE.test(table.join("\n"))) {
      out.push(
        ...toNfmTable(
          head.prefix,
          parts.slice(i, end).map((p) => p.body),
        ),
      );
    } else {
      out.push(...table);
    }
    previous = { end, prefix: head.prefix };
    i = end;
  }
  return out.join("\n");
}

/** 표 마커를 걷는다 — 블록 방식 push(martian)는 표 속성을 싣지 못한다. */
export function stripTableMarkers(content: string): string {
  return content.replace(TABLE_MARKER_RE, "");
}
