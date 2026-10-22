/**
 * 볼트에서 노트로 보는 파일 — 확장자 `.md` 를 대소문자 없이 본다. 노트 판정과 경로 → 이름의 유일한 규칙(B15).
 *
 * Obsidian 은 `노트.MD` 도 노트로 연다(1.13.7 실측: 확장자 `md`, 이름 `노트`, `[[노트]]` 가 그 파일로 해소).
 * 예전에는 판정이 자리마다 달랐다. CLI 의 볼트 목록은 소문자 `.md` 만 노트로 보고 `.MD` 를 첨부로 올렸고,
 * 플러그인은 Obsidian 의 목록을 써서 노트로 올렸다. 경로를 제목으로 바꾸는 함수 둘도 하나는 `.MD` 를 떼고
 * 하나는 떼지 않아, 같은 노트의 위키링크 이름과 Notion 제목이 달랐다.
 *
 * 새로 쓰는 노트의 확장자는 늘 소문자 `.md` 다 — 이 규칙은 «읽을 때» 의 것이다.
 */
const MARKDOWN_EXTENSION = /\.md$/i;

/** 노트(마크다운 파일)의 경로 · 이름인가. */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION.test(path);
}

/** 노트 확장자를 뗀다 — 노트가 아니면 그대로. */
export function stripMarkdownExtension(path: string): string {
  return path.replace(MARKDOWN_EXTENSION, "");
}

/** 경로의 노트 이름 — 마지막 조각에서 노트 확장자를 뗀다(`폴더/노트.MD` → `노트`). */
export function noteNameFromPath(path: string): string {
  return stripMarkdownExtension(path.slice(path.lastIndexOf("/") + 1));
}
