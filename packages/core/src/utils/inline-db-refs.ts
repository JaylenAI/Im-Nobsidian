import { MARKER_BRAND_RE } from "../constants/markers.js";

/**
 * 페이지 마크다운에서 인라인 데이터베이스 참조 ID 를 추출한다(하이픈 제거 32자리 hex).
 *
 * 신호 2종을 모두 잡는다:
 * 1. NFM `<database url="...">` 태그 — url 호스트가 워크스페이스에 따라
 *    `https://www.notion.so/<id>` 또는 `https://app.notion.com/p/<id>` 로 갈리는 것이
 *    실측됐으므로(콜아웃 내부 PARA DB 5개가 후자로 렌더되어 발견 누락), 호스트를 고정하지
 *    않고 url 값 안의 32자리 hex 만 취한다.
 * 2. blocks-API 폴백 변환기가 발행하는 보존 마커 `%%im-nobsidian:child-database:id=<uuid>...%%`
 *    — NFM 실패 페이지에서도 발견이 끊기지 않게 한다.
 */
export function extractInlineDbIds(markdown: string): string[] {
  const ids = new Set<string>();

  const tagRe = /<database\b[^>]*\burl="[^"]*?([a-f0-9]{32})[^"]*"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(markdown)) !== null) {
    if (m[1]) ids.add(m[1]);
  }

  const markerRe = new RegExp(`${MARKER_BRAND_RE}:child-database:id=([a-f0-9-]{32,36})`, "g");
  while ((m = markerRe.exec(markdown)) !== null) {
    if (m[1]) ids.add(m[1].replace(/-/g, ""));
  }

  return [...ids];
}
