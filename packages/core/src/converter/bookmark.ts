import type { BookmarkTarget } from "../types/convert.js";
import { compactNotionId } from "../utils/id.js";
import { mapOutsideCode } from "../utils/md-regions.js";

/**
 * F-09 — 북마크를 볼트에 그 주소로 보인다.
 *
 * Markdown API 는 북마크 블록을 주소 · 캡션 없이 `<unknown url="…/p/<페이지>#<블록>" alt="bookmark"/>`
 * 로만 보낸다(실측 2026-10-04). 이 태그로만 만든 링크는 「🔖 Bookmark」 라는 이름으로 Notion 의 그
 * 블록을 가리켜, 누르면 원래 사이트가 아니라 Notion 이 열렸다(실볼트 166개 · 54노트). 받을 때 블록을
 * 읽어(`NotionClient.getBookmarks`) 보이는 링크에 북마크의 주소와 캡션을 넣는다.
 *
 * 왕복은 그대로 뒤따르는 보존 마커가 맡는다 — push 는 보이는 링크를 마커와 한 쌍으로 버리고 받은
 * 태그를 돌려보내, Notion 이 원래 블록을 남긴다. 그래서 볼트에서 고친 주소는 Notion 에 가지 않는다.
 */

/** 블록 자리 태그 — 그룹 1 = url, 그룹 2 = 나머지 속성. */
const UNKNOWN_URL_TAG_RE = /<unknown url="([^"]*)"([^>]*)\/>/g;
const ALT_BOOKMARK_RE = /\balt="bookmark"/;
/** 자리 태그 url 의 블록 ID — `#` 뒤다(하이픈 없는 32자리, 실측). */
const BLOCK_ID_OF_URL_RE = /#([0-9a-fA-F-]{32,36})$/;

/** 자리 태그 url 이 가리키는 블록 ID(하이픈 없이). 블록을 가리키지 않으면 undefined. */
export function bookmarkBlockId(url: string): string | undefined {
  const id = BLOCK_ID_OF_URL_RE.exec(url)?.[1];
  return id === undefined ? undefined : compactNotionId(id);
}

/** 받은 본문의 북마크 블록 ID — 코드 안의 태그는 빼고. */
export function bookmarkBlockIds(nfm: string): string[] {
  const ids = new Set<string>();
  mapOutsideCode(nfm, (segment) => {
    for (const m of segment.matchAll(UNKNOWN_URL_TAG_RE)) {
      const id = ALT_BOOKMARK_RE.test(m[2]!) ? bookmarkBlockId(m[1]!) : undefined;
      if (id !== undefined) ids.add(id);
    }
    return segment;
  });
  return [...ids];
}

/** 보이는 링크의 이름 — 아이콘 뒤에 캡션, 캡션이 없으면 주소. 블록을 읽지 못했으면 정해 둔 이름. */
export function bookmarkLabel(target?: BookmarkTarget): string {
  if (target === undefined) return "🔖 Bookmark";
  return `🔖 ${linkText(target.caption.trim() === "" ? target.url : target.caption)}`;
}

/**
 * 링크 이름에 넣을 글 — 한 줄로 펴고, 링크와 뒤따르는 마커를 깨는 글자를 막는다. 대괄호는 링크를
 * 일찍 닫고, 백틱은 코드로 대괄호를 삼키며, `%%` 는 Obsidian 주석을 열어 뒤따르는 마커까지 가린다.
 */
function linkText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/%%+/g, "%")
    .replace(/[\\[\]`]/g, "\\$&");
}
