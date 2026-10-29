/**
 * Notion 이 따로 두는 값 ↔ Bases 의 파일 속성 — `.base` 를 쓰는 쪽(생성기 · 필터 번역)과 읽는 쪽(볼트에서 고친 보기를
 * Notion 에 올리기 · 폴더 DB)이 같은 이름을 읽는다.
 *
 * 행의 제목은 프론트매터 키가 아니라 파일 이름이다. 만든 · 고친 시각은 Notion 페이지의 시각이 아니라 볼트 파일의
 * 시각이지만 Bases 에서 같은 뜻으로 쓸 수 있는 유일한 값이다.
 */
export const BASES_TITLE = "file.name";

/** Notion 시각 필터 · 정렬의 `timestamp` → Bases 파일 속성. */
export const BASES_TIMESTAMPS = {
  created_time: "file.ctime",
  last_edited_time: "file.mtime",
} as const;

export type NotionTimestamp = keyof typeof BASES_TIMESTAMPS;

/** Bases 파일 속성 → Notion `timestamp`. 시각 속성이 아니면 undefined. */
export function notionTimestampOf(column: string): NotionTimestamp | undefined {
  return (Object.keys(BASES_TIMESTAMPS) as NotionTimestamp[]).find(
    (timestamp) => BASES_TIMESTAMPS[timestamp] === column,
  );
}
