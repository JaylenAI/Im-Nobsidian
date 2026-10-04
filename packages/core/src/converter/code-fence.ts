import { indentWidth, type CodeFence } from "../utils/md-regions.js";

/*
 * 코드 펜스 속 코드 — 지문 · 줄머리 · Obsidian 이 보여 주는 글(S-20 · S-22). 펜스를 찾는 것은
 * `utils/md-regions` 의 `scanCodeFences` 다.
 */

/** 여는 줄 머리의 인용 표시 — 펜스 앞의 마지막 `>` 까지. */
const QUOTE_LEAD_RE = /^(?:[\t ]*>)*/;

/** 코드의 지문 — 공백을 모두 뺀 내용. 컨테이너 들여쓰기 · 줄 끝 공백이 달라도 같은 코드로 본다. */
export function codeFingerprint(fence: CodeFence): string {
  return fence.code.join("\n").replace(/\s+/g, "");
}

/** 코드에 Notion 이 펜스로 읽을 줄(```로 시작)이 있는가 — 있으면 Notion 이 블록을 거기서 가른다. */
export function hasBacktickFenceLine(fence: CodeFence): boolean {
  return fence.code.some((line) => /^[\t ]*```/.test(line));
}

/**
 * 코드 줄의 머리 — 여는 줄의 인용 표시와, 펜스까지의 들여쓰기(목록 표시는 같은 폭의 공백으로).
 * 코드 줄을 새로 쓸 때 이 머리를 붙이면 같은 컨테이너 · 같은 깊이의 코드 줄이 된다.
 */
export function codeLineLead(fence: CodeFence): string {
  const quotes = QUOTE_LEAD_RE.exec(fence.lead)![0];
  return quotes + fence.lead.slice(quotes.length).replace(/[^\t ]/g, " ");
}

/**
 * Obsidian 이 보여 주는 코드 — 코드 줄마다 펜스까지의 들여쓰기 폭만큼 뗀다(CommonMark: 펜스가 N칸
 * 들여써졌으면 코드 줄에서 N칸까지 뗀다). 인용 표시는 이미 떼어져 있다({@link CodeFence.code}).
 */
export function fenceCodeText(fence: CodeFence): string {
  const lead = codeLineLead(fence);
  const width = indentWidth(lead.slice(QUOTE_LEAD_RE.exec(lead)![0].length));
  return fence.code.map((line) => dedentColumns(line.replace(/\r$/, ""), width)).join("\n");
}

/** 줄머리 공백을 `width` 칸까지 뗀다 — 탭이 그 폭을 넘기면 그 앞에서 멈춘다. */
function dedentColumns(line: string, width: number): string {
  let column = 0;
  let i = 0;
  for (; i < line.length && column < width; i++) {
    const ch = line[i];
    const next = ch === " " ? column + 1 : ch === "\t" ? column + 4 - (column % 4) : Infinity;
    if (next > width) break;
    column = next;
  }
  return line.slice(i);
}
