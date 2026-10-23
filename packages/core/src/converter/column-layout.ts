import { COLUMN_SEP_SOURCE, MARKER_BRAND_RE } from "../constants/markers.js";

/**
 * Notion 컬럼이 볼트 노트의 어느 줄에 걸치나 (#74).
 *
 * pull 은 컬럼을 위아래로 펼치고 경계를 마커 줄로 남긴다(ADR-008) — `column-list:start` · 열마다
 * `column[:ratio=N]` · `column-list:end`. Obsidian 은 마크다운을 옆으로 나란히 그리지 못하므로, 플러그인은
 * 이 결과로 열의 경계를 보이게 칠한다. 마커 모양의 주인이 이 패키지라 읽기도 여기 둔다.
 *
 * 컨테이너(콜아웃 · 토글) 안의 컬럼은 pull 이 마커를 지우고 펼친다 — 마커 줄은 맨 앞 들여쓰기만 받는다.
 */

/** 컬럼 안의 줄 하나가 놓인 자리. */
export interface ColumnPlace {
  /** 노트 안에서 몇 번째 컬럼 묶음인가 — 0 부터. */
  readonly group: number;
  /** 묶음 안에서 몇 번째 열인가 — 0 부터. */
  readonly index: number;
  /** 묶음의 열 수. */
  readonly count: number;
  /** 열 너비(%) — Notion 이 비율을 주지 않았으면 undefined. */
  readonly ratio?: number;
  /** 이 열의 첫 줄인가 — 열 구분 마커 줄이다. */
  readonly head: boolean;
}

const START_RE = new RegExp(`^[\\t ]*%%${MARKER_BRAND_RE}:column-list:start%%[\\t ]*$`);
const END_RE = new RegExp(`^[\\t ]*%%${MARKER_BRAND_RE}:column-list:end%%[\\t ]*$`);
const SEP_RE = new RegExp(`^[\\t ]*${COLUMN_SEP_SOURCE}[\\t ]*$`);
const FENCE_RE = /^[\t ]*(`{3,}|~{3,})/;

/**
 * 줄마다 놓인 컬럼 자리 — 컬럼 밖 줄 · 묶음의 시작/끝 마커 줄은 undefined. 닫히지 않은 묶음은 노트 끝까지다.
 * 코드 블록 안의 마커 모양 글은 마커가 아니다.
 */
export function readColumnLayout(lines: readonly string[]): (ColumnPlace | undefined)[] {
  const places: (ColumnPlace | undefined)[] = new Array<ColumnPlace | undefined>(lines.length);
  let group = -1;
  let fence: string | null = null;
  // 열려 있는 묶음 — 열마다 [구분 마커 줄, 비율]. 묶음이 닫히면 열 수를 알고 칠한다.
  let open: { start: number; columns: { line: number; ratio?: number }[] } | null = null;

  const close = (end: number): void => {
    if (!open) return;
    const { columns } = open;
    columns.forEach((column, index) => {
      const until = columns[index + 1]?.line ?? end;
      for (let line = column.line; line < until; line++) {
        places[line] = {
          group,
          index,
          count: columns.length,
          ...(column.ratio === undefined ? {} : { ratio: column.ratio }),
          head: line === column.line,
        };
      }
    });
    open = null;
  };

  lines.forEach((line, i) => {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) fence = null;
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      return;
    }
    if (START_RE.test(line)) {
      close(i);
      group++;
      open = { start: i, columns: [] };
      return;
    }
    if (!open) return;
    if (END_RE.test(line)) {
      close(i);
      return;
    }
    const sep = SEP_RE.exec(line);
    if (sep) {
      const ratio = sep[1] === undefined ? undefined : Number(sep[1]);
      open.columns.push({ line: i, ...(Number.isFinite(ratio) ? { ratio } : {}) });
    }
  });
  close(lines.length);
  return places;
}

/** 열 이름표 — `열 2/3 · 50%`. 비율이 없으면 `열 2/3`. */
export function columnLabel(place: ColumnPlace): string {
  const head = `열 ${place.index + 1}/${place.count}`;
  return place.ratio === undefined ? head : `${head} · ${formatRatio(place.ratio)}%`;
}

function formatRatio(ratio: number): string {
  return String(Math.round(ratio * 100) / 100);
}
