/**
 * Notion API 요청 크기 한도 — https://developers.notion.com/reference/request-limits
 *
 * 한도를 넘는 값 하나가 요청 전체를 400 으로 만든다. 속성 갱신이면 행의 다른 속성까지
 * 함께 거부된다.
 */

/** rich text 객체 하나의 `text.content` 최대 글자 수. */
export const RICH_TEXT_CONTENT_MAX = 2000;

/** files 속성 파일 하나의 `name` 최대 글자 수(검증 오류 문구 「name.length should be ≤ 100」 로 실측). */
export const FILE_NAME_MAX = 100;

/** rich text 배열 하나의 최대 원소 수. */
export const RICH_TEXT_ARRAY_MAX = 100;

/** 블록 자식 배열 하나(append 요청 · 블록의 `children`)의 최대 원소 수. */
export const BLOCK_CHILDREN_MAX = 100;

/**
 * append 요청 하나가 품는 자식의 깊이 — 요청에 담은 블록 아래로 두 단계까지(칼럼 묶음의 칼럼은 세지
 * 않는다). SDK 요청 타입도 그만큼만 자식을 받는다.
 */
export const BLOCK_NESTING_MAX = 2;

/** 요청 하나에 담는 블록(자식 · 표의 행 포함)의 최대 수. */
export const REQUEST_BLOCKS_MAX = 1000;

/** 요청 본문의 최대 크기(바이트). */
export const REQUEST_BYTES_MAX = 500_000;
