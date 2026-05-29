/**
 * 보존 마커(preserve marker) 단일 진실원(SSOT).
 *
 * 변환 불가 요소를 라운드트립 보존하기 위해 본문에 삽입하는 마커가 공유하는
 * 브랜드 토큰을 한곳에서 정의한다. 리브랜딩 시 {@link MARKER_BRAND}만 바꾸면
 * 모든 빌더·정규식에 반영된다.
 *
 * 주의: 마커 포맷(공백 유무)은 기존 vault·Notion에 이미 기록된 데이터와의 호환을
 * 위해 변경하지 않는다. 두 포맷이 공존한다 — 공백형(`%% brand:... %%`)과
 * 압축형(`%%brand:...%%`).
 */

/** 모든 보존 마커가 공유하는 브랜드 토큰. */
export const MARKER_BRAND = "im-nobsidian";

// ─── 의사 프로토콜 (링크 보존) ───

/** 위키링크 보존용 의사 프로토콜 prefix: `im-nobsidian://wikilink/`. */
export const WIKILINK_PROTOCOL = `${MARKER_BRAND}://wikilink/`;

/** 임베드 보존용 의사 프로토콜 prefix: `im-nobsidian://embed/`. */
export const EMBED_PROTOCOL = `${MARKER_BRAND}://embed/`;

// ─── 공백형 마커 `%% im-nobsidian:BODY %%` ───

/** 공백형 HTML 주석 마커 생성: `%% im-nobsidian:BODY %%`. */
export function spacedMarker(body: string): string {
  return `%% ${MARKER_BRAND}:${body} %%`;
}

/** 공백형 마커 종료 토큰: `%% im-nobsidian:end %%`. */
export const SPACED_END = spacedMarker("end");

// ─── 압축형 마커 `%%im-nobsidian:BODY%%` ───

/** 압축형 마커 생성: `%%im-nobsidian:BODY%%`. */
export function compactMarker(body: string): string {
  return `%%${MARKER_BRAND}:${body}%%`;
}

/** 토글 블록 보존 마커 (enhanced-md-converter / block-converter 공유). */
export const TOGGLE_START = compactMarker("toggle:start");
export const TOGGLE_END = compactMarker("toggle:end");

/** 컬럼 레이아웃 보존 마커 (block-converter). */
export const COLUMN_LIST_START = compactMarker("column-list:start");
export const COLUMN_LIST_END = compactMarker("column-list:end");
export const COLUMN_SEP = compactMarker("column");

/** 목차(table of contents) 블록 보존 마커. */
export const TOC_MARKER = compactMarker("toc");

/** YAML 프로퍼티 테이블 보존 태그 (yaml 코드블록 내 주석): `# im-nobsidian:properties`. */
export const PROPERTIES_TAG = `# ${MARKER_BRAND}:properties`;

// ─── 정규식 헬퍼 ───

/**
 * 정규식 패턴에 직접 삽입할 수 있는 브랜드 토큰.
 * 브랜드에 정규식 특수문자가 없어(하이픈은 문자클래스 밖에서 리터럴) 이스케이프 없이 사용 가능.
 * 사용 예: `new RegExp(`%% ${MARKER_BRAND_RE}:end %%`, "g")`
 */
export const MARKER_BRAND_RE = MARKER_BRAND;
