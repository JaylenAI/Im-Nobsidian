/**
 * Notion API 요청 크기 한도 — https://developers.notion.com/reference/request-limits
 *
 * 한도를 넘는 값 하나가 요청 전체를 400 으로 만든다. 속성 갱신이면 행의 다른 속성까지
 * 함께 거부된다.
 */

/** rich text 객체 하나의 `text.content` 최대 글자 수. */
export const RICH_TEXT_CONTENT_MAX = 2000;

/** rich text 배열 하나의 최대 원소 수. */
export const RICH_TEXT_ARRAY_MAX = 100;
