import { RICH_TEXT_ARRAY_MAX, RICH_TEXT_CONTENT_MAX } from "../constants/notion-limits.js";

/**
 * 글을 rich text 객체에 담을 조각으로 나눈다 — 객체 하나는 {@link RICH_TEXT_CONTENT_MAX}자까지라 긴 글을
 * 한 덩어리로 보내면 Notion 이 요청 전체를 거부한다. 서로게이트 쌍(이모지 등)은 가르지 않는다.
 *
 * @returns 조각들. 배열 한도({@link RICH_TEXT_ARRAY_MAX})를 넘을 만큼 길면 null — 담을 수 없다.
 */
export function richTextChunks(text: string): string[] | null {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk.length + char.length > RICH_TEXT_CONTENT_MAX) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length > RICH_TEXT_ARRAY_MAX ? null : chunks;
}
