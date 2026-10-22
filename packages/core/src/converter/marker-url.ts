/**
 * 보존 마커 링크(`[label](im-nobsidian://…/<target>)`)의 URL 부분 인코딩 SSOT.
 *
 * `encodeURIComponent` 는 `( ) ! ' * ~` 를 그대로 남긴다. 그중 괄호는 마크다운
 * 링크의 URL 경계 문자라, 괄호가 든 제목(`[[T24 대상 (1)]]` — Notion 이 붙이는
 * `(1)` 중복 접미사 때문에 실볼트에 558건/202파일)을 그대로 실으면 복원기가
 * 첫 `)` 에서 URL 을 끊어 `[[T24 대상 (1|T24 대상 (1)]])` 로 문법째 깨졌다(실측).
 *
 * 그래서 push 는 괄호까지 퍼센트 인코딩하고(=앞으로 만들어지는 마커는 안전),
 * 복원 정규식은 {@link MARKER_URL_CAPTURE} 로 균형 잡힌 괄호 한 겹까지 받아
 * **이미 Notion 에 올라가 있는 구버전 마커도 되살린다**. 둘 다 필요하다 — 인코딩만
 * 고치면 기존 페이지가 영영 깨진 채로 남는다.
 */

/**
 * 마커 URL 에 실을 대상 문자열 인코딩.
 *
 * `_` 도 인코딩한다 — 첨부 자리표시자(`%% im-nobsidian:local-file:<대상> %%`)는 링크 주소가 아니라
 * 글이라 Notion 이 마크다운으로 읽는다. 경로의 `__폴더__` 가 굵게가 되어 굵은 `폴더` 로 돌아와
 * 임베드가 깨졌다(2026-10-22 실데이터 E2E). 밑줄이 그대로 든 옛 마커도 {@link decodeMarkerTarget} 가 받는다.
 */
export function encodeMarkerTarget(target: string): string {
  return encodeURIComponent(target)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/_/g, "%5F");
}

/**
 * Notion 이 도메인처럼 보이는 글에 거는 자동 링크 — `[9.23.13.mov](http://9.23.13.mov)`. 마커 안의
 * 파일 이름(`.mov` 는 최상위 도메인이다)까지 링크가 되어 경로가 깨졌다(2026-10-22 실데이터 E2E).
 * 글자와 주소가 같을 때만 걷는다 — 다르면 글에 적힌 링크다.
 */
const NOTION_AUTOLINK_RE = /\[([^\][()\s]+)\]\(https?:\/\/([^()\s]+)\)/g;

/** {@link encodeMarkerTarget} 의 역변환. 잘못 인코딩된 입력은 원문을 그대로 돌려준다. */
export function decodeMarkerTarget(encoded: string): string {
  const unlinked = encoded.replace(NOTION_AUTOLINK_RE, (link, text: string, host: string) =>
    text === host ? text : link,
  );
  try {
    return decodeURIComponent(unlinked);
  } catch {
    return unlinked;
  }
}

/**
 * 마커 링크 URL 캡처 정규식 조각.
 *
 * 공백 없는 문자 + 균형 잡힌 괄호 한 겹까지 허용한다. `[^)]+` 였을 때 구버전
 * 산출물의 `…%20(1)` 이 `(1` 에서 잘렸다. 괄호 중첩까지는 정규식으로 못 세지만
 * 파일명·제목에 실제로 나타나는 형태는 한 겹이라 실측 범위를 모두 덮는다.
 */
export const MARKER_URL_CAPTURE = "((?:[^()\\s]|\\([^()]*\\))+)";

/**
 * 마커 링크 라벨 캡처 정규식 조각.
 *
 * `[` 를 라벨에 허용하면 안 된다. `[[[happy]]]` 가 push 에서 `[` + `[happy](…)` + `]` 로
 * 갈린 뒤, `[^\]]+` 라벨이 앞의 여는 대괄호까지 삼켜 라벨이 `[happy` 가 되고
 * `[[happy|[happy]]]` 라는 엉뚱한 별칭 링크로 복원됐다(실측).
 */
export const MARKER_LABEL_CAPTURE = "([^[\\]]+)";
