import type { RowPropertyChanges } from "../types/sync.js";
import { mergeRowFrontmatter } from "../converter/frontmatter-merge.js";
import {
  isEmptyFrontmatterValue,
  plainFrontmatterValue,
  replaceFrontmatterLines,
} from "../utils/frontmatter.js";

/**
 * S-01 — DB 행의 속성은 «지난 동기화 뒤 로컬에서 바뀐 것» 만 보낸다.
 *
 * 로컬 frontmatter 는 Notion 속성의 평문 사본이다. rich_text 의 굵게 · 링크 · 멘션 · 색은
 * 빠져 있고, people 은 이름만 남는다. 행을 push 할 때마다 속성을 통째로 보내면 손대지 않은
 * 속성까지 평문으로 덮여 서식이 지워지고, 그 사이 Notion 에서 바뀐 다른 속성은 옛 값으로
 * 되돌아간다. 그래서 지난 동기화 시점의 파일(baseSnapshot)과 지금 파일의 frontmatter 를
 * 비교해 바뀐 키만 고른다.
 *
 * `title` 은 여기서 다루지 않는다 — 행 제목은 속성이 아니라 `note-title.ts` 의 규칙으로 정한다.
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
      if (!isEmptyFrontmatterValue(after)) changed[key] = after;
      continue;
    }
    const before = plainFrontmatterValue(base[key]);
    if (sameValue(before, after)) continue;
    if (isEmptyFrontmatterValue(after)) cleared.push(key);
    else changed[key] = after;
  }
  return { changed, cleared };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmptyFrontmatterValue(a) && isEmptyFrontmatterValue(b)) return true;
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

/**
 * 보내지 못한 속성을 Notion 에 남은 값으로 되돌린 사본 — 지난 동기화 사본(baseSnapshot)으로 적는다.
 *
 * 사본은 «Notion 과 맞춘 상태» 다. 보내지 못한 값까지 사본에 적으면 다음 push 가 바뀐 것이 없다고 보고
 * 영영 보내지 않는다 — 새 볼트로 받으면 그 값이 없다. 예: 같은 push 에서 뒤에 만들 행을 가리키는 relation.
 *
 * 그 키의 줄만 고친다 — frontmatter 를 다시 쓰면 다른 값의 모양이 바뀌어(`2026-10-23` →
 * `2026-10-23T00:00:00.000Z`) 다음 push 가 그 값을 바뀐 것으로 보낸다(2026-10-23 라이브).
 *
 * @param before 그 속성들의 Notion 쪽 값(지난 사본 · 원격). 없으면(새 행) 키를 뺀다.
 */
export function withUnsentProperties(
  content: string,
  keys: readonly string[],
  before: Readonly<Record<string, unknown>> | null,
): string {
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    if (before && Object.hasOwn(before, key)) kept[key] = plainFrontmatterValue(before[key]);
  }
  const lines = mergeRowFrontmatter(content, kept, new Set(keys));
  return (lines && replaceFrontmatterLines(content, lines)) ?? content;
}
