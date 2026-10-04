import { MEDIA_PLACEHOLDER_HEAD } from "../constants/markers.js";
import { codeLineMask, indentWidth } from "../utils/md-regions.js";

/** 첨부 자리표시자 인용 줄 — 그룹 1 = 줄머리 들여쓰기. */
const PLACEHOLDER_LINE_RE = new RegExp(`^([ \\t]*)${MEDIA_PLACEHOLDER_HEAD}`);
const LEADING_SPACE_RE = /^[ \t]*/;

/**
 * 첨부 자리표시자보다 깊이 들여쓴 뒷줄이 있으면 자리표시자를 그 깊이로 들인다(S-33).
 *
 * Notion 은 인용보다 깊이 들여쓴 줄을 — 탭 · 공백 넷 · 공백 둘, 빈 줄을 사이에 두어도 — 그 인용의
 * 자식으로 묶는다. 업로드는 자리표시자 인용을 이미지로 바꾸며 지우므로 그 자식도 함께 지워졌다(실측
 * 2026-10-04, 생성 · 본문 교체 두 경로 같음). 실볼트에서는 임베드 뒤 빈 줄 · 네 칸 목록, 콜아웃 속
 * 목록 항목에 이어 쓴 임베드 뒤 더 깊은 하위 목록이 이 모양이었다.
 *
 * 같은 깊이로 들이면 자리표시자와 뒷줄이 형제가 되어 함께 앞 블록(목록 항목 · 문단)의 자식으로 간다
 * (실측 — 목록 · 문단 · 코드 블록 · 콜아웃 속 목록 모두). 이미지는 뒷줄 바로 앞에 놓인다.
 *
 * 아래에서 위로 본다 — 자리표시자가 잇달으면 아랫것을 들인 깊이를 윗것이 따른다. 코드 블록 속 줄은
 * 자리표시자가 아니고, 뒷줄이 코드 블록이면 여는 펜스 줄의 깊이를 본다.
 */
export function indentPlaceholdersToNextLine(content: string): string {
  const lines = content.split("\n");
  const inCode = codeLineMask(content);
  let below: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const indent = inCode[i] ? null : PLACEHOLDER_LINE_RE.exec(line)?.[1];
    if (indent !== undefined && indent !== null && below !== null) {
      if (indentWidth(below) > indentWidth(indent)) lines[i] = below + line.slice(indent.length);
    }
    below = LEADING_SPACE_RE.exec(lines[i]!)![0];
  }
  return lines.join("\n");
}
