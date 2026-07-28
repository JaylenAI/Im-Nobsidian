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

/**
 * 토글 헤딩(`### 제목 {toggle="true"}`) 보존 마커 쌍.
 *
 * NFM 은 토글 헤딩을 "속성 붙은 제목 + 탭 한 단계 들여쓴 자식"으로 내보낸다. Obsidian 에
 * 대응 문법이 없어 속성을 그대로 두면 제목 뒤에 `{toggle="true"}` 가 노출되고(실볼트 256건),
 * 자식의 구조적 탭이 4-space 로 확장되어 콜아웃이 코드블록으로 오파싱된다(524건).
 *
 * 끝 마커가 필요한 이유: pull 이 자식을 열 0 으로 내리면 **자식과 후속 형제가
 * 구분되지 않는다**. NFM 원본에서는 자식만 탭을 갖고 형제는 열 0 이라 경계가 명확한데,
 * 그 정보를 마커로 옮겨 싣지 않으면 push 가 형제까지 토글 안으로 빨아들인다.
 * 끝 마커가 없는 구버전 볼트 문서를 위해 push 는 "다음 동급 이상 제목까지"로 폴백한다.
 */
export const TOGGLE_HEADING_START = compactMarker("toggle-heading");
export const TOGGLE_HEADING_END = compactMarker("toggle-heading:end");

/**
 * 인용/콜아웃 들여쓰기 깊이 보존 마커.
 *
 * pull 은 구조적 들여쓰기를 Obsidian 이 코드블록으로 오파싱하지 않는 폭(2칸)으로
 * 클램프한다 — "2칸 = 한 단계"가 관례이므로 깊이 1 은 마커 없이 복원된다.
 * 두 단계 이상은 2칸으로 표현할 수 없어 이 마커가 깊이를 대신 싣는다
 * (실볼트 콜아웃 머리줄 699개 중 깊이 ≥2 는 8개 — 마커 노이즈를 98.9% 줄이는 선택).
 */
export function calloutIndentMarker(depth: number): string {
  return compactMarker(`callout-indent:${depth}`);
}

/** 컬럼 레이아웃 보존 마커 (block-converter). */
export const COLUMN_LIST_START = compactMarker("column-list:start");
export const COLUMN_LIST_END = compactMarker("column-list:end");
export const COLUMN_SEP = compactMarker("column");

/** 목차(table of contents) 블록 보존 마커. */
export const TOC_MARKER = compactMarker("toc");

/**
 * synced block 보존 마커 쌍. Notion `<synced_block[_reference] url="...">` 태그를
 * pull 때 벗겨 내용만 남기면 push 때 일반 블록으로 박제되어 **동기화 참조가 끊긴다**
 * (실측: 태그를 되밀면 참조 보존, 태그 없이 내용만 되밀면 참조 소실).
 * 시작 마커에 태그 종류(kind)와 원본 url 을 실어 push 때 태그를 재조립한다.
 */
export type SyncedKind = "ref" | "orig";

export function syncedStartMarker(kind: SyncedKind, url: string): string {
  return compactMarker(`synced:start:kind=${kind}&url=${encodeURIComponent(url)}`);
}
export const SYNCED_END = compactMarker("synced:end");

/**
 * breadcrumb 블록 보존 마커. Notion breadcrumb 은 마크다운 표현이 없어 pull 시
 * 빈 문자열로 소실됐다 — 이 마커로 자리를 남겨 push 시 breadcrumb 블록으로 복원한다.
 */
export const BREADCRUMB_MARKER = compactMarker("breadcrumb");

/**
 * 디자인 속성 보존 마커 (ADR-008). NFM raw 는 콜아웃 아이콘/색을 태그 속성으로,
 * 블록 색을 줄 끝 `{color="…"}` 로 내보낸다 — Obsidian 에 대응 문법이 없어 pull 때
 * 이 마커로 실어 두고 push 때 정준형 속성으로 재조립한다.
 */
export function calloutStyleMarker(params: { icon?: string; color?: string }): string {
  const kv: string[] = [];
  if (params.icon) kv.push(`icon=${encodeURIComponent(params.icon)}`);
  if (params.color) kv.push(`color=${encodeURIComponent(params.color)}`);
  return compactMarker(`callout-style:${kv.join("&")}`);
}

/** 색상 토글(`<details color="…">`) 보존 마커. */
export function toggleColorMarker(color: string): string {
  return compactMarker(`toggle-color:${color}`);
}

/** 블록 색(`{color="…"}`) 보존 마커. */
export function blockColorMarker(color: string): string {
  return compactMarker(`block-color:${color}`);
}

/** YAML 프로퍼티 테이블 보존 태그 (yaml 코드블록 내 주석): `# im-nobsidian:properties`. */
export const PROPERTIES_TAG = `# ${MARKER_BRAND}:properties`;

// ─── 정규식 헬퍼 ───

/**
 * 마커 페이로드 한 글자 — 줄바꿈이 아니고, 종결자 `%%` 를 열지 않는 문자.
 *
 * 페이로드를 `[^%]` 로 끊으면 `50% 압축` 같은 **홑 `%`** 에서 마커 매칭이 깨진다.
 * 새로 만드는 마커는 경로를 퍼센트 인코딩해 홑 `%` 가 남지 않지만, 이미 Notion 에
 * 올라가 있는 구버전 마커에는 원문 `%` 가 그대로 들어 있다 — 그쪽도 살려야 하므로
 * "`%` 는 받되 `%%` 는 받지 않는다"로 넓힌다(`marker-url.ts` 와 같은 이중 대응).
 */
export const MARKER_PAYLOAD_CHAR = "(?:[^\\n%]|%(?!%))";

/**
 * push 가 심는 미디어 자리표시자 quote 의 **머리 부분** 패턴 원문.
 * `> 📎 파일명 %% im-nobsidian:local-image|local-file:경로 %%` 한 줄이 통째로 하나의
 * 블록이어야 업로드 성공 뒤 image/file 블록으로 제자리 교체된다
 * (`converter/pre-processors/embed.ts` 의 `placeholder` 주석 참조).
 *
 * 예전 두 줄 형태로 이미 Notion 에 올라가 있는 문서가 남아 있어 개행은 선택적으로 받는다.
 * 뒤에 경로 캡처를 붙여 복원용으로 쓰거나(`local-image-restorer`), 앞에 `^` 를 붙여
 * "이 줄이 자리표시자인가" 판정에 쓴다(`enhanced-md-converter`).
 *
 * 파일명 부분은 {@link MARKER_PAYLOAD_CHAR} 로 받는다 — `50%.png` 처럼 `%` 가 든 이름을
 * `[^\n%]*` 로 끊으면 자리표시자 전체가 복원되지 않고 마커 원문이 본문에 노출됐다(실측).
 */
export const MEDIA_PLACEHOLDER_HEAD = `>\\s*📎\\s*${MARKER_PAYLOAD_CHAR}*(?:\\n>)?\\s*%%\\s*${MARKER_BRAND}:local-(?:image|file):`;

/**
 * 정규식 패턴에 직접 삽입할 수 있는 브랜드 토큰.
 * 브랜드에 정규식 특수문자가 없어(하이픈은 문자클래스 밖에서 리터럴) 이스케이프 없이 사용 가능.
 * 사용 예: `new RegExp(`%% ${MARKER_BRAND_RE}:end %%`, "g")`
 */
export const MARKER_BRAND_RE = MARKER_BRAND;

/**
 * 본문에 실린 **브랜드 마커 토큰 하나**를 통째로 잡는 패턴 — 공백형
 * (`%% im-nobsidian:… %%`)·압축형(`%%im-nobsidian:…%%`)·닫는 토큰(`%%/color%%`)을 모두 받는다.
 *
 * `%%` 를 **위치로만** 짝짓는 스캐너(대표적으로 Obsidian 주석 제거기)가 마커의 구분자를
 * 자기 구분자로 오인하면 본문이 통째로 사라진다. 실측: `100%%` 같은 홑 `%%` 가 있는 문서에
 * `==하이라이트==` 가 함께 있으면, `100%%` 의 `%%` 와 색상 마커 여는 `%%` 가 짝지어져
 * 그 사이 문장 전체와 하이라이트 본문이 삭제됐다(D-COMMENT-PAIR).
 * 마커 토큰을 먼저 떼어 내는 {@link mapOutsideMarkers} 의 SSOT.
 */
export const MARKER_TOKEN_RE = new RegExp(
  `%%\\s*(?:${MARKER_BRAND_RE}:${MARKER_PAYLOAD_CHAR}*|/[A-Za-z][\\w-]*)\\s*%%`,
  "g",
);
