import type { RowPropertyChanges } from "../types/sync.js";
import { plainFrontmatterValue } from "../utils/frontmatter.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";

/**
 * S-01 — DB 행의 속성은 «지난 동기화 뒤 로컬에서 바뀐 것» 만 보낸다.
 *
 * 로컬 frontmatter 는 Notion 속성의 평문 사본이다. rich_text 의 굵게 · 링크 · 멘션 · 색은
 * 빠져 있고, people 은 이름만 남는다. 행을 push 할 때마다 속성을 통째로 보내면 손대지 않은
 * 속성까지 평문으로 덮여 서식이 지워지고, 그 사이 Notion 에서 바뀐 다른 속성은 옛 값으로
 * 되돌아간다. 그래서 지난 동기화 시점의 파일(baseSnapshot)과 지금 파일의 frontmatter 를
 * 비교해 바뀐 키만 고른다.
 *
 * `title` 은 여기서 다루지 않는다 — 행 제목은 속성이 아니라 {@link rowTitle} 로 정한다.
 */

/**
 * 두 frontmatter 의 속성 차이.
 *
 * @param base 지난 동기화 시점의 frontmatter. 모르면 null — 그때는 비어 있지 않은 속성을
 *   전부 바뀐 것으로 본다(비교할 기준이 없으면 통째로 보내던 예전 동작과 같다).
 */
export function diffRowProperties(
  base: Readonly<Record<string, unknown>> | null,
  current: Readonly<Record<string, unknown>>,
): RowPropertyChanges {
  const changed: Record<string, unknown> = {};
  const cleared: string[] = [];
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(current)]);
  keys.delete("title");

  for (const key of keys) {
    const after = plainFrontmatterValue(current[key]);
    if (base === null) {
      if (!isEmptyValue(after)) changed[key] = after;
      continue;
    }
    const before = plainFrontmatterValue(base[key]);
    if (sameValue(before, after)) continue;
    if (isEmptyValue(after)) cleared.push(key);
    else changed[key] = after;
  }
  return { changed, cleared };
}

/**
 * 행 제목 — frontmatter `title` 이 있으면 그것, 없으면 파일 이름.
 *
 * pull 은 행마다 Notion 제목을 `title` 에 적는다. 파일 이름은 Notion 제목에서 파일명에 못
 * 쓰는 글자를 바꾼 것이라(`A/B` → `A-B`), 파일 이름을 제목으로 되밀면 원래 제목이 깨진다.
 */
export function rowTitle(frontmatter: Readonly<Record<string, unknown>>, path: string): string {
  const title = frontmatter.title;
  if (title === null || title === undefined) return wikilinkTitleFromPath(path);
  const text = String(plainFrontmatterValue(title));
  return text.trim() ? text : wikilinkTitleFromPath(path);
}

/**
 * 비어 있는 값. pull 은 빈 속성을 `null`(글 · 선택 · 날짜 · 숫자)로 적거나 아예 적지 않는다
 * (빈 배열). 손으로 고치면 `""` 가 되기도 한다 — 모두 같은 «비어 있음» 이다.
 */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    for (const key of keys) {
      if (!sameValue(ra[key], rb[key])) return false;
    }
    return true;
  }
  return false;
}
