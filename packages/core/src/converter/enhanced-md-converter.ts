import {
  MARKER_BRAND_RE,
  compactMarker,
  TOGGLE_START,
  TOGGLE_END,
  COLUMN_LIST_START,
  COLUMN_LIST_END,
  COLUMN_SEP_SOURCE,
  columnMarker,
  WIKILINK_PROTOCOL,
  syncedStartMarker,
  type SyncedKind,
  SYNCED_END,
  calloutStyleMarker,
  toggleColorMarker,
  blockColorMarker,
  MEDIA_PLACEHOLDER_HEAD,
  MARKER_PAYLOAD_CHAR,
  tocMarker,
  embedMarker,
  unknownMentionMarker,
} from "../constants/markers.js";
import { decodeMarkerTarget, MARKER_URL_CAPTURE, MARKER_LABEL_CAPTURE } from "./marker-url.js";
import {
  CONTAINER_PREFIX_SOURCE,
  codeInteriorRanges,
  dedentContainerBody,
  indentContainerBody,
  isInsideRanges,
  nfmOpenTagSource,
  splitContainerPrefix,
} from "./container-indent.js";
import {
  applyCalloutIndent,
  clampCalloutIndent,
  quoteCalloutBody,
  readCalloutIndentDepth,
  restoreBodyIndent,
} from "./callout-indent.js";
import { convertToggleHeadings, restoreToggleHeadings } from "./toggle-heading.js";
import { mapOutsideCodeFences } from "../utils/md-regions.js";
import { formatWikilink } from "../utils/wikilink-title.js";

const NOTION_CALLOUT_RE = /^::: callout\n([\s\S]*?)\n:::/gm;
const NOTION_PAGE_MENTION_RE = /<mention-page id="([^"]+)">([\s\S]*?)<\/mention-page>/g;
const NOTION_USER_MENTION_RE = /<mention-user id="[^"]*">([^<]*)<\/mention-user>/g;
const NOTION_DATE_MENTION_RE = /<mention-date start="([^"]*)"(?: end="([^"]*)")?[^>]*\/>/g;
const NOTION_UNKNOWN_RE = /<unknown id="([^"]*)"([^>]*)\/>/g;
const NOTION_UNKNOWN_URL_RE = /<unknown url="([^"]*)"([^>]*)\/>/g;

const NOTION_AUDIO_RE = /[\t ]*<audio src="([^"]*)">([\s\S]*?)<\/audio>/g;
const NOTION_VIDEO_RE = /[\t ]*<video src="([^"]*)">([\s\S]*?)<\/video>/g;
const NOTION_PDF_RE = /[\t ]*<pdf src="([^"]*)">([\s\S]*?)<\/pdf>/g;
const NOTION_FILE_RE = /[\t ]*<file src="([^"]*)">([\s\S]*?)<\/file>/g;
const NOTION_TAB_RE = /<tab title="([^"]*)">([\s\S]*?)<\/tab>/g;
/** 라벨 달린 Notion 페이지 링크. id 는 하이픈 유무 양쪽으로 온다(실측). */
const NOTION_LABELED_PAGE_LINK_RE = new RegExp(
  `\\[${MARKER_LABEL_CAPTURE}\\]\\(https?:\\/\\/(?:[a-z]+\\.)?notion\\.(?:so|com)\\/(?:p\\/)?([a-f0-9]{32}|[a-f0-9-]{36})\\)`,
  "g",
);

export function notionEnhancedToObsidian(enhanced: string): string {
  let result = enhanced;

  // 토글 헤딩이 가장 먼저 — 자식을 열 0 으로 내려야 아래 컨테이너 변환이 들여쓰기를
  // 재적용하지 않는다. NFM raw 형태에만 의존하므로 어떤 변환보다 앞서도 안전하다.
  result = convertToggleHeadings(result);
  result = convertSyncedBlockRef(result);
  result = convertContainers(result);
  result = convertFencedCallouts(result);
  result = convertPageMentions(result);
  result = convertPageLinks(result);
  result = convertUserMentions(result);
  result = convertDateMentions(result);
  result = convertMediaTags(result);
  result = convertTabBlocks(result);
  result = preserveUnknownBlocks(result);
  result = preserveNfmOnlyBlocks(result);
  result = convertNotionMath(result);
  result = convertNotionTables(result);
  result = convertSpans(result);
  result = convertDatabaseBlocks(result);
  result = convertBlockColorAttrs(result);
  result = removeEmptyBlocks(result);
  result = unescapePipes(result);
  result = unescapeNotionChars(result);
  result = unescapeBrackets(result);
  result = ensureCalloutContinuity(result);
  result = separateAdjacentCallouts(result);
  // 들여쓰기 클램프가 가장 마지막 — 위 변환기들은 모두 탭 기준 구조 들여쓰기를 전제로
  // 경계를 판정한다. 먼저 누르면 그 판정이 어긋난다(callout-indent 주석 참조).
  result = clampCalloutIndent(result);

  return result;
}

/**
 * Notion Markdown API 는 링크로 재해석될 소지가 있는 대괄호를 **전부** escape 해서
 * 돌려준다 — 평문 위키링크 `\[\[..\]\]` 뿐 아니라 그냥 대괄호로 감싼 글자
 * `\[대괄호\]`, 각주 `\[^1\]` 도 마찬가지다(실 Notion 실측).
 * (resolved 위키링크는 mention 이 되어 이 경로를 타지 않고, unresolved 만 평문으로 남는다)
 * 그대로 두면 볼트에 백슬래시가 눌러앉고 위키링크 기능도 죽으므로 pull 시 되돌린다.
 *
 * 위키링크 패턴(`\[\[..\]\]`)으로만 풀면 중첩을 못 이긴다 — `\[\[\[happy\]\]\]` 는
 * 안쪽 한 쌍만 잡혀 `\[[[happy]]\]` 라는 반쯤 풀린 문자열이 남는다(실측). 짝을 맞추는
 * 대신 escape 자체를 걷어내야 중첩 깊이와 무관하게 옳다.
 *
 * 세 가지는 건드리지 않는다:
 *  - `\\[` 처럼 **백슬래시 자신이 escape 된** 경우. 여기서 `[` 는 escape 된 적이 없다.
 *    이걸 구분하지 않으면 왕복마다 백슬래시를 한 겹씩 갉아먹어 파일이 영영 수렴하지
 *    않는다(정규식 패턴을 본문에 적어 둔 노트에서 실측).
 *  - `\[..\](..)` — 사용자가 "링크로 보이지 말라"고 escape 한 것이다. 풀면 없던 링크가 생긴다.
 *  - 펜스 코드블록 안 — 코드 리터럴은 원문 그대로여야 한다.
 */
function unescapeBrackets(content: string): string {
  return mapOutsideCodeFences(content, (segment) =>
    // 첫 갈래가 escape 된 백슬래시 쌍을 통째로 소비해, 뒤따르는 대괄호가 escape 로
    // 오인되지 않게 한다. 갈래 순서가 곧 우선순위다.
    segment.replace(/\\\\|\\\[[^\n[\]]*\\\]\(|\\([[\]])/g, (match, bracket: string | undefined) =>
      bracket === undefined ? match : bracket,
    ),
  );
}

export function obsidianToNotionEnhanced(obsidian: string): string {
  let result = obsidian;

  result = convertTogglesToHtml(result);
  result = restoreTabBlocks(result);
  result = convertObsidianCallouts(result);
  result = restoreMediaTags(result);
  result = restoreUnknownBlocks(result);
  result = restoreNfmOnlyBlocks(result);
  result = restoreColorSpans(result);
  result = restoreBlockColorMarkers(result);
  result = restoreUnderlineSpans(result);
  result = convertMentionPageIdToUrl(result);
  result = restoreWikilinkPreserveLinks(result);
  result = restoreSyncedBlocks(result);
  // 컬럼 재조립은 마지막 — 영역 내부 내용이 위 모든 변환을 먼저 통과해야 하고,
  // 잔여 디자인 마커 안전망(strip)도 여기서 함께 처리된다.
  result = reassembleColumns(result);
  // 토글 헤딩이 가장 마지막 — 본문이 위 변환을 모두 통과한 뒤에 탭 한 단계를 입혀야
  // 각 변환기가 열 0 기준으로 동작할 수 있다(pull 의 정확한 역순).
  result = restoreToggleHeadings(result);

  return result;
}

// ─── Push 방향: 위키링크 → Notion markdown API 호환 표현 ───
//
// 배경: Notion 공식 markdown API(`pages.create({markdown})`, `updateMarkdown`)는
//   - `<mention-page id="X">label</mention-page>` 를 **통째로 삭제**한다(레이블까지 소실).
//   - `<mention-page url="https://www.notion.so/<id>"/>` 만 진짜 page mention 으로 인식한다.
//   - 커스텀 스킴 링크(`[label](im-nobsidian://wikilink/..)`)는 링크를 버리고 텍스트만 남긴다.
//   - 평문 `[[target]]` 는 텍스트로 escape 보존되어 round-trip 시 정확히 복원된다.
// 따라서 파이프라인(WikilinkResolver)이 만든 표현을 위 규칙에 맞게 한 번 더 변환한다.

const MENTION_PAGE_ID_RE = /<mention-page id="([^"]+)">[\s\S]*?<\/mention-page>/g;
const WIKILINK_PRESERVE_LINK_RE = new RegExp(
  `\\[${MARKER_LABEL_CAPTURE}\\]\\(${WIKILINK_PROTOCOL}${MARKER_URL_CAPTURE}\\)`,
  "g",
);

// resolved 위키링크: id 기반 mention → Notion 이 수용하는 url 기반 mention 으로 변환
function convertMentionPageIdToUrl(content: string): string {
  return content.replace(MENTION_PAGE_ID_RE, (_match, id: string) => {
    const nohyph = id.replace(/-/g, "");
    return `<mention-page url="https://www.notion.so/${nohyph}"/>`;
  });
}

// unresolved 위키링크: preserve-link → 평문 위키링크 (Notion 이 텍스트로 보존, round-trip 수렴)
function restoreWikilinkPreserveLinks(content: string): string {
  return content.replace(WIKILINK_PRESERVE_LINK_RE, (_match, label: string, enc: string) => {
    return formatWikilink(decodeMarkerTarget(enc), label);
  });
}

// ── 컨테이너(토글/콜아웃/칼럼) 통합 변환 ──────────────────────────────────────
//
// Notion Markdown API 는 <details>/<callout>/<columns> 를 중첩 깊이만큼 탭으로 들여쓴
// 직계 자식으로 표현한다. 타입별로 분리된 순차 패스로 처리하면 두 문제가 생긴다:
//   (1) 교차 중첩(콜아웃-in-칼럼-in-토글)을 한 패스가 다룰 수 없다.
//   (2) 안쪽 컨테이너를 먼저 풀며 그 선행 들여쓰기를 열 0 으로 당기면, 부모 본문의
//       들여쓰기가 불균등해져 dedent 공통최소값이 0 → 구조적 탭이 살아남아
//       `> \t\t…` prefix/탭 폭주가 된다(결함②). 또한 평면 비탐욕 정규식은 중첩 콜아웃을
//       잘못 짝지어(바깥 열림 ↔ 안쪽 닫힘) 고아 태그를 남겼다.
//
// 해결: 타입 불문 "가장 안쪽" 컨테이너부터 한 루프에서 변환한다. body 패턴이 내부에
// 어떤 컨테이너 시작 태그도 없음을 부정선읽기로 보장하므로(콜아웃 SPAN 과 동일 관용),
// 매 패스의 매치는 항상 최내곽이다. 각 컨테이너의 선행 들여쓰기를 캡처해 본문 변환 후
// 출력의 모든 줄에 **다시 입혀**, 변환 결과가 형제 줄과 같은 깊이에 머물게 한다. 그러면
// 부모의 dedent 가 그 레벨을 통째로 균등 제거한다. 변환 결과엔 컨테이너 태그가 없으므로
// 다음 패스에서 부모가 새 innermost 가 되어 임의 깊이·교차 중첩이 올바른 순서로 환원된다.

// body: 내부에 어떤 컨테이너 시작 태그도 없는(=가장 안쪽) 구간. 부정선읽기가 START 태그만
// 차단하므로 비탐욕 *? 가 자신의 닫는 태그에서 멈춘다(</callout> 등은 차단되지 않음).
// `<details` 는 `>` 없이 차단한다 — 색상 토글은 `<details color="green_bg">` 처럼 속성이
// 붙어 오므로(실측: RAG 구축 방법 페이지) 리터럴 `<details>` 만 차단하면 속성형 중첩이
// innermost 판정을 뚫고 바깥-열림↔안쪽-닫힘 mis-pair 가 된다.
const NO_CONTAINER_BODY = "(?:(?!<details|<callout|<columns)[\\s\\S])*?";

// <summary> 제목: 첫 </summary> 에서 반드시 멈추고 중첩 컨테이너 시작 태그를 넘지 않는다.
// 단순 `[\s\S]*?` 는 본문이 닫는 태그에 도달 못 할 때 첫 </summary> 너머로 백트랙해
// 바깥 토글을 안쪽 </summary>/</details> 와 잘못 짝짓는다(중첩 토글 mis-pair, 결함②).
const SUMMARY_TITLE = "((?:(?!<\\/summary>|<details|<summary>)[\\s\\S])*?)";

// <summary> 는 선택이다 — 제목 없는 빈 토글은 `<details>\n\n</details>` 로 오고(실측:
// AI Music 페이지), 색상 토글은 여는 태그에 속성이 붙는다. 둘 다 필수로 요구하면
// 매치 실패 → 원문 HTML 태그가 볼트에 그대로 누수된다.
// 여는 태그 뒤는 `[ \t]*\n?` 로 개행 하나만 넘는다 — 무조건 `\s*` 로 삼키면 summary 없는
// 토글에서 첫 본문 줄의 구조적 탭까지 먹어 dedent 공통최소값을 0 으로 무너뜨린다(실 push
// 왕복 프로브 실측: `> \t본문` 탭 누수). summary 앞 공백·빈 줄은 옵션 그룹 안에서만
// 허용한다 — summary 부재 시 그룹 전체가 백트래킹되어 본문 들여쓰기가 온전히 남는다.
const INNERMOST_DETAILS_RE = new RegExp(
  `([\\t ]*)<details([^>]*)>[ \\t]*\\n?(?:\\s*<summary>${SUMMARY_TITLE}<\\/summary>)?(${NO_CONTAINER_BODY})<\\/details>`,
  "g",
);
const INNERMOST_CALLOUT_RE = new RegExp(
  `([\\t ]*)${nfmOpenTagSource("callout", "capture")}\\n?(${NO_CONTAINER_BODY})<\\/callout>`,
  "g",
);
const INNERMOST_COLUMNS_RE = new RegExp(
  `([\\t ]*)${nfmOpenTagSource("columns")}\\n?(${NO_CONTAINER_BODY})<\\/columns>`,
  "g",
);
// 이름 경계 확인이 `<column` 과 `<columns` 를 갈라 준다. 속성부는 캡처한다 — 너비 비율이
// `<column ratio="62.5">` 로 실려 오므로 버리면 push 가 레이아웃을 균등 분할로 되돌린다.
const COLUMN_WRAP_RE = new RegExp(
  `[\\t ]*${nfmOpenTagSource("column", "capture")}\\n?([\\s\\S]*?)[\\t ]*<\\/column>\\n?`,
  "g",
);

// 캡처한 선행 들여쓰기를 변환 결과의 비어있지-않은 모든 줄에 다시 입힌다.
function reindentLines(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split("\n")
    .map((line) => (line === "" ? line : indent + line))
    .join("\n");
}

// 컨테이너 여는 태그의 icon/color 속성 파서 (ADR-008). NFM 정준형:
// `<callout icon="⚠️" color="red_bg">`, `<details color="green_bg">`.
function parseDesignAttrs(attrs: string): { icon?: string; color?: string } {
  const icon = /\bicon="([^"]*)"/.exec(attrs)?.[1];
  const color = /\bcolor="([^"]*)"/.exec(attrs)?.[1];
  return { icon: icon || undefined, color: color || undefined };
}

/**
 * `<column ratio="62.5">` 의 너비 비율 파서.
 *
 * **십진수만** 통과시킨다. 비율은 마커 페이로드로 실려 `%%…%%` 안에 들어가는데, 검증 없이
 * 속성 값을 그대로 옮기면 `%%` 나 개행이 든 값 하나가 마커를 두 동강 내 그 자리의 칼럼
 * 경계 전체를 무너뜨린다. 형식을 벗어난 값은 비율만 버리고 칼럼은 살린다.
 */
function parseColumnRatio(attrs: string): string | undefined {
  return /\bratio="(\d+(?:\.\d+)?)"/.exec(attrs)?.[1];
}

// <details> → > [!toggle]- (본문은 dedent 후 `> ` prefix). dedent 가 코드펜스를 열 0 으로
// 정렬해 `> \t``` ` cascade 를 차단하고(결함①), 부모 패스에서 다시 `> ` 가 입혀지면
// `> > ` 형태의 올바른 Obsidian 중첩이 된다.
// color 속성(색상 토글)은 마커로 제목 줄에 실어 push 재조립에 쓴다(ADR-008).
function toggleToCallout(title: string, rawBody: string, color?: string): string {
  const body = dedentContainerBody(rawBody);
  // 제목 없는 빈 토글은 머리줄만 남긴다(`> [!toggle]- ` 꼬리 공백·빈 `>` 줄 방지)
  const head = ["> [!toggle]-", title.trim(), color ? toggleColorMarker(color) : ""]
    .filter((part) => part !== "")
    .join(" ");
  if (body.trim() === "") return head;
  return `${head}\n${quoteCalloutBody(body)}`;
}

// <columns>/<column> → 평탄화하되 경계를 컬럼 마커로 남긴다(ADR-008). 마커 어휘는
// legacy block 경로(block-converter)와 동일 — push 가 <columns> 정준형으로 재조립한다.
// 각 칼럼 본문은 dedent 로 구조적 탭까지 벗긴다(결함②: 탭 하나만 벗기던 기존 동작 교체).
//
// **빈 칼럼도 자리를 지킨다**(D-EMPTY-COLUMN). Notion 레이아웃에서 빈 칼럼은 여백을 주는
// 실제 구성요소인데, 예전엔 내용이 없다는 이유로 걷어내 3열이 2열로 접혔다. 그 상태로
// push 하면 사용자의 **Notion 레이아웃 자체가 파괴**된다(오프라인 실측: 3열 → pull 2열
// → push `<column>` 2개). 마커만 남기고 본문을 비워 두면 칼럼 수가 보존된다.
function flattenColumns(body: string): string {
  const cols: Array<{ ratio?: string; body: string }> = [];
  const re = new RegExp(COLUMN_WRAP_RE.source, COLUMN_WRAP_RE.flags);
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(body)) !== null) {
    matched = true;
    cols.push({ ratio: parseColumnRatio(m[1] ?? ""), body: dedentContainerBody(m[2]!) });
  }
  // <column> 래퍼가 전혀 없을 때만 폴백 dedent. 래퍼가 있으나 **전부** 빈 칼럼이면
  // 레이아웃이 아무것도 담지 않은 것이므로 "" 반환(태그 제거됨). 폴백을 여기서 걸면
  // 빈 칼럼의 <column> 태그가 샌다.
  if (!matched) return dedentContainerBody(body);
  if (cols.every((c) => c.body.trim() === "")) return "";
  return [
    COLUMN_LIST_START,
    ...cols.map((c) => `${columnMarker(c.ratio)}\n${c.body}`),
    COLUMN_LIST_END,
  ].join("\n");
}

function convertContainers(content: string): string {
  let result = content;
  let safety = 0;
  while (
    safety++ < 2000 &&
    (result.includes("<details") || result.includes("<callout") || result.includes("<columns"))
  ) {
    const before = result;
    result = result.replace(
      INNERMOST_DETAILS_RE,
      (_m, indent: string, attrs: string, title: string | undefined, body: string) =>
        reindentLines(toggleToCallout(title ?? "", body, parseDesignAttrs(attrs).color), indent),
    );
    result = result.replace(
      INNERMOST_CALLOUT_RE,
      (_m, indent: string, attrs: string, body: string) =>
        reindentLines(calloutBodyToObsidian(body, parseDesignAttrs(attrs)), indent),
    );
    result = result.replace(INNERMOST_COLUMNS_RE, (_m, indent: string, body: string) =>
      reindentLines(flattenColumns(body), indent),
    );
    if (result === before) break;
  }
  return result;
}

/**
 * 컬럼 구조 마커 **하나만** 있는 줄 — 콜아웃/토글 안에 중첩된 경우까지 잡도록 컨테이너
 * 접두(들여쓰기 + 인용)를 허용한다.
 *
 * 이 줄은 내용이 아니라 **레이아웃 경계**다. 콜아웃 제목으로 흡수되면 경계가 소실되면서
 * 사용자의 Notion 열 구성이 push 에서 평탄화된다(D-EMPTY-COLUMN 과 같은 이유).
 */
const COLUMN_MARKER_LINE_RE = new RegExp(
  `^${CONTAINER_PREFIX_SOURCE}(?:${COLUMN_SEP_SOURCE}|%%${MARKER_BRAND_RE}:column-list:(?:start|end)%%)[\\t ]*$`,
);

/**
 * 이미 인용 접두를 얻은 줄 — 안쪽 변환이 먼저 끝난 **중첩 콜아웃/토글/인용**의 머리다.
 * ({@link CONTAINER_PREFIX_SOURCE} 는 `>` 를 삼키므로 여기서는 쓸 수 없다.)
 */
const QUOTED_LINE_RE = /^[\t ]*>/;

/**
 * 콜아웃 제목으로 끌어올리면 안 되는 본문 첫 줄인가.
 *
 * 제목 자리로 올린 줄은 본문에서 빠진다. 그 줄이 내용이 아니라 **구조**면 구조가 사라진다.
 * 컬럼 경계 마커면 열 구성이 무너지고, 중첩 컨테이너의 머리면 그 컨테이너가
 * `> [!note] > [!toggle]- 제목` 한 줄로 뭉개져 push 가 `<details>` 를 되살리지 못한다
 * (실측: `<details>` 5개·3노트 소실).
 */
function isStructuralFirstLine(line: string): boolean {
  return COLUMN_MARKER_LINE_RE.test(line) || QUOTED_LINE_RE.test(line);
}

function calloutBodyToObsidian(body: string, style?: { icon?: string; color?: string }): string {
  // 콜아웃 본문도 토글과 동일한 코드펜스 cascade 위험이 있으므로 같은 dedent 를 적용한다.
  const lines = dedentContainerBody(body)
    .split("\n")
    .filter((l, i, arr) => !(i === 0 && l === "") && !(i === arr.length - 1 && l === ""));
  const titleIndex = isStructuralFirstLine(lines[0] ?? "") ? -1 : 0;
  const firstLine = titleIndex === 0 ? (lines[0] ?? "") : "";

  // NFM 정준형은 아이콘을 icon 속성으로 나른다 — 속성이 하나라도 있으면 정준형이므로
  // 첫 줄 이모지 파싱을 건너뛴다(첫 글자가 이모지인 본문을 아이콘으로 오식하면 소실).
  // 속성 없는 레거시(<callout>\n💡 제목, ::: callout 펜스)는 첫 줄 이모지 경로를 유지한다.
  const emojiMatch =
    style?.icon || style?.color ? null : /^([\p{Emoji}️‍]+)\s*(.*)/u.exec(firstLine);
  const rawIcon = style?.icon ?? (emojiMatch ? emojiMatch[1]! : undefined);
  // 업로드 이미지 아이콘은 만료되는 서명 URL 로만 노출된다(풀마다 서명이 바뀌어 churn,
  // push 하면 만료 URL 오염) — URL 아이콘은 마커에 싣지 않고 색만 보존한다(degrade).
  const icon = rawIcon !== undefined && /^https?:\/\//i.test(rawIcon) ? undefined : rawIcon;
  const type = icon ? emojiToCalloutType(icon) : "note";
  const title = emojiMatch ? emojiMatch[2]! : firstLine;
  // 앞뒤 **빈 줄만** 떨군다. `trim()` 은 첫 줄의 선행 공백까지 먹어 버려, 같은 깊이의
  // 형제 중 첫 줄만 한 단계 얕게 렌더된다(실측: 콜아웃 안 토글 헤딩 두 개가 서로 다른
  // 깊이로 보임 — 앞의 것은 `> ###`, 뒤의 것은 `>   ###`).
  const rest = lines
    .slice(titleIndex + 1)
    .join("\n")
    .replace(/^(?:[\t ]*\n)+/, "")
    .replace(/\n[\t ]*$/, "");

  // icon/color 는 마커로 제목 줄에 실어 push 가 정준형 속성으로 재조립한다(ADR-008).
  // 단, 아이콘이 type 기본 이모지와 같고 색이 없으면 push 가 type 에서 동일 아이콘을
  // 재생성하므로 마커를 생략한다 — 흔한 기본 콜아웃에서 볼트 노이즈를 없앤다.
  // 마커의 icon 부재는 "아이콘 없는 콜아웃"을 뜻하므로, 마커를 낼 때는 실제 속성만 싣는다.
  const needsMarker =
    Boolean(style?.color) || (icon !== undefined && calloutTypeToEmoji(type) !== icon);
  const styleTail = needsMarker ? ` ${calloutStyleMarker({ icon, color: style?.color })}` : "";
  const calloutTitle = title ? `> [!${type}] ${title}${styleTail}` : `> [!${type}]${styleTail}`;
  const calloutBody = rest.trim() ? `\n${quoteCalloutBody(rest)}` : "";

  return calloutTitle + calloutBody;
}

// 푸시 측 내부 표현인 `::: callout` 펜스 폼만 처리한다(탭 중첩이 아니라 폭주 없음).
// Notion 풀 API 의 <callout> 태그는 convertContainers 가 담당한다.
function convertFencedCallouts(content: string): string {
  return content.replace(NOTION_CALLOUT_RE, (_match, body: string) => calloutBodyToObsidian(body));
}

function convertPageMentions(content: string): string {
  let result = content.replace(NOTION_PAGE_MENTION_RE, (_match, _id: string, text: string) => {
    const cleaned = text.trim();
    return `[[${cleaned}]]`;
  });
  // url 기반 page mention 은 두 형태로 온다:
  //   - self-closing            `<mention-page url="..32hex.."/>`
  //   - 라벨 동반(breadcrumb 등) `<mention-page url="..32hex..">제목</mention-page>`
  // 둘 다 page id 로 환원해 `[[notion:id]]` 로 만들고, 후처리 resolveNotionLinks 가 정식
  // 제목으로 해소한다. mention 라벨은 항상 대상 페이지의 현재 제목이므로 id 해소가 SSOT —
  // 라벨을 버려도 무손실이며, 같은 줄의 다른 위키링크와 일관된 표현이 된다.
  //
  // URL 호스트/경로는 워크스페이스·API 버전에 따라 여러 형태로 온다(실측 — clean-slate
  // pull 18건이 전부 신형 `app.notion.com/p/<id>`): `www.notion.so/<id>`,
  // `notion.so/<id>`, `app.notion.com/p/<id>`. `notion.so` 만 보던 기존 정규식은 신형을
  // 놓쳐 콜아웃 breadcrumb 에 raw 태그가 남았다(F27). 임의 서브도메인 + `.so`/`.com` +
  // 선택적 `/p/` 로 일반화한다. id 는 항상 32 hex 라 오탐 위험이 낮다.
  // (`[^>]*?` 는 `>` 를 넘지 않는 lazy 매치, alternation 으로 self-closing/라벨형을 한 번에 처리)
  result = result.replace(
    /<mention-page\s+url="https?:\/\/(?:[a-z]+\.)?notion\.(?:so|com)\/(?:p\/)?([a-f0-9]{32})"[^>]*?(?:\/>|>[\s\S]*?<\/mention-page>)/g,
    (_match, id: string) => `[[notion:${id}]]`,
  );
  // 라벨을 가진 페이지 링크(`[별칭](https://www.notion.so/<id>)`)는 mention 이 아니다 —
  // 별칭이 붙은 위키링크를 push 가 이 형태로 내보낸다(mention 은 라벨을 못 가지므로).
  // 라벨을 살린 채 id 로 환원해, 후처리 역조회가 `[[대상|별칭]]` 까지 복원하게 한다.
  result = result.replace(NOTION_LABELED_PAGE_LINK_RE, (_match, label: string, id: string) => {
    const normalized = id.replace(/-/g, "");
    return `[[notion:${normalized}|${label}]]`;
  });
  return result;
}

function convertUserMentions(content: string): string {
  return content.replace(NOTION_USER_MENTION_RE, (_match, name: string) => `@${name}`);
}

function convertDateMentions(content: string): string {
  return content.replace(NOTION_DATE_MENTION_RE, (_match, start: string, end?: string) => {
    return end ? `${start} → ${end}` : start;
  });
}

/**
 * 마크다운 표현이 없는 블록의 **가시 폴백** — 클릭 가능한 링크 + 권위 마커 한 쌍.
 *
 * 마커만 남기면 읽기뷰에서 빈 줄로 보여 사용자가 소실로 오해한다. 링크는 보여주기용이고
 * 왕복 권위는 뒤따르는 마커(인코딩된 원본 URL)가 갖는다. 둘을 **공백 없이** 인접시켜
 * push 때 {@link DEGRADE_LINK_SOURCE} 가 한 쌍으로 소비 → Notion drift 를 막는다.
 *
 * 목적지의 괄호는 반드시 인코딩한다. 짝 패턴이 `\([^)]*\)` 로 끝을 잡으므로 날 괄호가
 * 경계를 앞당겨 끊고, 그러면 링크 잔해가 Notion 본문에 평문으로 박제된다(실측 재현:
 * `https://ex.com/a(b)c`). `%28`/`%29` 는 경로·질의 어디서든 원문과 동치다.
 */
function degradeLink(label: string, url: string, marker: string): string {
  return `[${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})${marker}`;
}

/** {@link degradeLink} 가 앞세운 가시 링크. 마커 패턴 앞에 붙여 한 쌍으로 소비한다. */
const DEGRADE_LINK_SOURCE = "(?:\\[[^\\]]*\\]\\([^)]*\\))?";

// 2D: <unknown> → 보존 마커 (삭제 대신 보존)
function preserveUnknownBlocks(content: string): string {
  let result = content.replace(NOTION_UNKNOWN_RE, (_match, id: string, attrs: string) => {
    const typeMatch = /type="([^"]*)"/.exec(attrs);
    const altMatch = /alt="([^"]*)"/.exec(attrs);
    const blockType = altMatch?.[1] ?? typeMatch?.[1] ?? "unknown";
    return compactMarker(`unknown:id=${id}&type=${blockType}`);
  });
  result = result.replace(NOTION_UNKNOWN_URL_RE, (_match, url: string, attrs: string) => {
    const altMatch = /alt="([^"]*)"/.exec(attrs);
    const blockType = altMatch?.[1] ?? "bookmark";
    const marker = compactMarker(`unknown:id=${encodeURIComponent(url)}&type=${blockType}`);
    const label =
      blockType === "embed"
        ? "🔗 Embed"
        : blockType === "bookmark"
          ? "🔖 Bookmark"
          : `🔗 ${blockType}`;
    return degradeLink(label, url, marker);
  });
  return result;
}

// NFM 전용 자기완결 태그들. 이름 뒤가 `\s` 또는 `/` 로 **닫히는 것**까지 확인한다 —
// `<table>`/`<table_of_contents>` 처럼 접두가 겹치는 이름이 실재하기 때문이다
// ({@link nfmOpenTagSource} 주석 참조).
const NOTION_TOC_RE = /<table_of_contents(?:\s+color="([^"]*)")?\s*\/>/g;
/** 임베드는 여는/닫는 태그 쌍으로 오지만 내부는 항상 비어 있다(코퍼스 27개 전건 실측). */
const NOTION_EMBED_RE = /<embed\s+src="([^"]*)"[^>]*>\s*<\/embed>/g;
const NOTION_UNKNOWN_MENTION_RE = /<unknown_mention\s+url="([^"]*)"([^>]*?)\/>/g;

/**
 * 마크다운 표현이 없는 NFM 전용 블록을 보존 마커로 옮긴다.
 *
 * {@link preserveUnknownBlocks} 가 `<unknown …/>` 만 처리해, Notion 이 **이름을 붙여
 * 내보내는** 나머지 태그들은 볼트에 원시 HTML 로 눌러앉았다(실측: `<embed>` 27개·2노트,
 * `<unknown_mention>` 8개·8노트, `<table_of_contents>` 3개·3노트). 원시 태그는 편집뷰에
 * 그대로 보이고, push 때는 Notion 이 해석하지 못해 평문으로 박제된다.
 */
function preserveNfmOnlyBlocks(content: string): string {
  let result = content.replace(NOTION_TOC_RE, (_match, color?: string) => tocMarker(color));
  result = result.replace(NOTION_EMBED_RE, (_match, src: string) =>
    degradeLink("🔗 Embed", src, embedMarker(src)),
  );
  return result.replace(NOTION_UNKNOWN_MENTION_RE, (_match, url: string, attrs: string) =>
    unknownMentionMarker(url, /alt="([^"]*)"/.exec(attrs)?.[1]),
  );
}

/**
 * synced block 태그를 마커 쌍으로 보존한다. 과거엔 태그를 벗기고 내용만 남겨,
 * push 시 일반 블록으로 박제되어 **동기화 참조가 영구히 끊겼다**(실측: 태그를
 * 그대로 되밀면 replace_content 가 참조를 보존한다 — 동일 내용·주변 수정 모두).
 * 내용은 마커 사이에 dedent 되어 그대로 노출되므로 Obsidian 에서 자연스럽게 보이고,
 * 후속 변환 단계(콜아웃·미디어 등)도 간섭 없이 처리한다. url 없는 태그는 복원
 * 불가능하므로 기존처럼 내용만 남긴다.
 */
function convertSyncedBlockRef(content: string): string {
  // 다른 컨테이너(`convertContainers`)와 같은 관용: 태그의 선행 들여쓰기를 캡처해 본문을
  // dedent 한 뒤, 산출물 **전체 줄**(마커 포함)에 그 들여쓰기를 다시 입힌다.
  //
  // 마커를 열 0 에 뱉으면 안 된다. 이 영역이 칼럼/콜아웃 안에 있을 때 열 0 짜리 마커 줄이
  // 부모 `dedentContainerBody` 의 공통최소값을 0 으로 끌어내려, 부모의 구조적 탭이 한 겹도
  // 벗겨지지 않는다. 그러면 push 가 매번 새로 입히는 탭이 고스란히 쌓여 왕복마다 본문이
  // 들여쓰기만큼 자란다(실볼트 `AI Engineer` 페이지가 왕복당 +4B 로 무한 증식함을 실측).
  const rebuild = (
    match: string,
    indent: string,
    attrs: string,
    kind: SyncedKind,
    openRe: RegExp,
    closeRe: RegExp,
  ): string => {
    const inner = dedentContainerBody(
      match.slice(indent.length).replace(openRe, "").replace(closeRe, ""),
    );
    const url = /url="([^"]*)"/.exec(attrs)?.[1];
    if (!url) return reindentLines(inner, indent);
    return reindentLines(`${syncedStartMarker(kind, url)}\n${inner}\n${SYNCED_END}`, indent);
  };

  // `synced_block` 은 `synced_block_reference` 의 접두다 — 이름 경계를 확인하지 않으면
  // 참조 블록이 원본 블록으로 잡혀 URL 종류가 뒤바뀐다({@link nfmOpenTagSource}).
  const replaceSynced = (text: string, name: string, kind: SyncedKind): string =>
    text.replace(
      new RegExp(`([\\t ]*)${nfmOpenTagSource(name, "capture")}[\\s\\S]*?<\\/${name}>`, "g"),
      (match, indent: string, attrs: string) =>
        rebuild(
          match,
          indent,
          attrs,
          kind,
          new RegExp(`${nfmOpenTagSource(name)}\\n?`),
          new RegExp(`</${name}>`),
        ),
    );

  let result = replaceSynced(content, "synced_block_reference", "ref");
  result = replaceSynced(result, "synced_block", "orig");
  return result;
}

/**
 * push 방향: synced 보존 마커 쌍 → `<synced_block[_reference] url="...">` 재조립.
 * 내용은 NFM 컨테이너 규약대로 탭 1단 들여쓴다. 사용자가 마커를 지웠으면 이 단계가
 * 매치하지 않아 내용이 일반 블록으로 전송된다(의도된 degrade — 참조 해제로 간주).
 */
// params 는 encodeURIComponent 된 URL 을 포함해 `%` 가 섞인다(`https%3A%2F...`) —
// `[^%]*` 는 첫 `%` 에서 끊기므로 반드시 lazy 매치(개행 전까지)여야 한다.
const SYNCED_MARKER_PAIR_RE = new RegExp(
  `%%${MARKER_BRAND_RE}:synced:start:(.*?)%%\\n?([\\s\\S]*?)%%${MARKER_BRAND_RE}:synced:end%%`,
  "g",
);

function restoreSyncedBlocks(content: string): string {
  return content.replace(SYNCED_MARKER_PAIR_RE, (_match, params: string, body: string) => {
    const kind = /kind=(ref|orig)/.exec(params)?.[1] ?? "orig";
    const encoded = /url=([^&]*)/.exec(params)?.[1] ?? "";
    let url = encoded;
    try {
      url = decodeURIComponent(encoded);
    } catch {
      // 잘못 인코딩된 경우 원문 유지
    }
    if (!url) return body.trim();
    const tag = kind === "ref" ? "synced_block_reference" : "synced_block";
    const indented = indentContainerBody(body.trim());
    return `<${tag} url="${url}">\n${indented}\n</${tag}>`;
  });
}

// 2A: 미디어 태그 → Obsidian 마크다운
function convertMediaTags(content: string): string {
  let result = content;

  result = result.replace(NOTION_AUDIO_RE, (_match, src: string, caption: string) => {
    const cap = caption.trim();
    return cap ? `[🔊 ${cap}](${src})` : `[🔊 audio](${src})`;
  });

  result = result.replace(NOTION_VIDEO_RE, (_match, src: string, caption: string) => {
    const cap = caption.trim();
    return cap ? `[🎬 ${cap}](${src})` : `[🎬 video](${src})`;
  });

  result = result.replace(NOTION_PDF_RE, (_match, src: string, caption: string) => {
    const cap = caption.trim();
    return cap ? `[📄 ${cap}](${src})` : `[📄 pdf](${src})`;
  });

  result = result.replace(NOTION_FILE_RE, (_match, src: string, caption: string) => {
    const cap = caption.trim();
    return cap ? `[📎 ${cap}](${src})` : `[📎 file](${src})`;
  });

  return result;
}

// 2B: <tab> → 보존 마커
function convertTabBlocks(content: string): string {
  return content.replace(NOTION_TAB_RE, (_match, title: string, body: string) => {
    const trimmed = body.trim();
    const indented = trimmed
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `> [!tab] ${title}\n${indented}`;
  });
}

// 2C: <span underline> / <span color> → 보존 마커 (균형 매칭, 중첩 안전)
//
// 비탐욕 단일 정규식(`<span ...>([\s\S]*?)</span>`)은 중첩 span 에서 첫 `</span>` 에
// 멈춰 바깥 span 의 닫는 토큰 순서를 뒤집는다(rank6/I3 — 사용자가 보는 Obsidian 마커가
// `%%/color%%%%/underline%%` 처럼 잘못 중첩됨). 대신 **안쪽(중첩 없는) span 부터** 마커로
// 치환한다: 마커엔 `<span` 이 없으므로 다음 패스에서 바깥 span 이 다시 innermost 가 되어
// 임의 깊이 중첩이 올바른 순서로 환원된다. body 패턴 `(?:(?!<span )[\s\S])*?` 가 내부에
// 또 다른 span 시작이 없음을 보장해 "가장 안쪽"만 매칭한다.
const INNERMOST_SPAN_RE =
  /<span (?:underline="true"|color="([^"]+)")>((?:(?!<span )[\s\S])*?)<\/span>/g;

function convertSpans(content: string): string {
  let result = content;
  let safety = 0;
  while (safety++ < 1000) {
    const next = result.replace(
      INNERMOST_SPAN_RE,
      (_match, color: string | undefined, inner: string) =>
        color !== undefined
          ? `${compactMarker(`color:${color}`)}${inner}%%/color%%`
          : `${compactMarker("underline")}${inner}%%/underline%%`,
    );
    if (next === result) break;
    result = next;
  }
  return result;
}

// pull 이 제목 줄에 실은 색상 토글 마커(ADR-008). 값은 Notion 색 토큰([a-z_]).
const TOGGLE_COLOR_MARKER_RE = new RegExp(`\\s*%%${MARKER_BRAND_RE}:toggle-color:([a-z_]+)%%`);

function convertTogglesToHtml(content: string): string {
  // 제목 `(.*)`: 빈 제목 토글(`> [!toggle]-`)도 매치해야 pull 산출물이 왕복 수렴한다.
  // 간격은 `[ \t]*` — `\s*` 는 빈 제목에서 개행을 삼켜 본문 첫 줄을 제목으로 오파싱한다.
  //
  // 본문 줄의 **끝 개행은 소비하지 않는다**(`\n>` 를 줄머리에 두는 형태). 끝 개행까지
  // 삼키면 토글 뒤에 있던 빈 줄이 한 겹 사라져 `</details>` 와 다음 블록이 문단 구분
  // 없이 맞붙고, 그 손실이 왕복마다 하나씩 누적돼 파일이 영영 수렴하지 않는다
  // (실볼트 11파일이 왕복 1회당 1~3바이트씩 계속 잠식됨을 실측).
  //
  // 선행 들여쓰기 `([ \t]{0,3})` 를 받는 이유: pull 이 리스트/칼럼 안 토글을 코드블록
  // 임계 아래로 클램프해 내려보내기 때문이다(callout-indent). 열 0 에만 앵커하면 그
  // 토글들이 push 에서 **통째로 사라진다** — 실볼트 `Creai LLM.md` 왕복 실측에서
  // `<details>` 8개가 0개가 됐다. 본문 줄은 역참조 `\1` 로 같은 들여쓰기를 요구해
  // 이웃 블록을 삼키지 않는다.
  const calloutToggleRe = /^([ \t]{0,3})> \[!toggle\]-[ \t]*(.*)((?:\n\1>.*)*)/gm;

  let result = content;
  let prev = "";
  let safety = 0;
  while (result !== prev && safety++ < 100) {
    prev = result;
    result = result.replace(
      calloutToggleRe,
      (_match, indent: string, rawTitle: string, body: string) => {
        const { depth, title } = readCalloutIndentDepth(indent, rawTitle);
        // 색상 토글 마커 → <details color> 속성으로 재조립(ADR-008)
        const colorMatch = TOGGLE_COLOR_MARKER_RE.exec(title);
        const cleanTitle = colorMatch ? title.replace(TOGGLE_COLOR_MARKER_RE, "") : title;
        const attrs = colorMatch ? ` color="${colorMatch[1]}"` : "";
        const bodyText = restoreBodyIndent(
          body
            .split("\n")
            .map((line) => line.replace(/^[ \t]*>\s?/, ""))
            .join("\n"),
        ).trim();
        const html = `<details${attrs}>\n<summary>${cleanTitle.trim()}</summary>\n\n${bodyText}\n\n</details>`;
        return applyCalloutIndent(html, depth);
      },
    );
  }

  const startRe = new RegExp(escapeRegex(TOGGLE_START), "g");
  const endRe = new RegExp(escapeRegex(TOGGLE_END), "g");

  safety = 0;
  while (result.includes(TOGGLE_START) && safety++ < 100) {
    const startIdx = result.indexOf(TOGGLE_START);
    const endIdx = findMatchingEnd(result, startIdx + TOGGLE_START.length);
    if (endIdx === -1) break;

    const inner = result.slice(startIdx + TOGGLE_START.length, endIdx).trim();
    const titleMatch = /^- (.+)$/m.exec(inner);
    const title = titleMatch ? titleMatch[1]! : "";
    const body = inner
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim();

    const html = `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
    result = result.slice(0, startIdx) + html + result.slice(endIdx + TOGGLE_END.length);
  }

  result = result.replace(startRe, "").replace(endRe, "");
  // 마커 쌍(TOGGLE_START/END) 경로는 끝 마커가 줄 안에 인라인으로 박혀 있을 수 있어
  // 닫는 태그 뒤에 다음 블록이 개행 없이 붙는다(`</details>[🎬 video](url)` — 실 push
  // 프로브에서 Notion 이 그 줄의 video 태그를 통째로 폐기함을 실측).
  result = result.replace(/^([\t ]*<\/details>)(?!\n|$)/gm, "$1\n");
  return result;
}

function findMatchingEnd(content: string, startFrom: number): number {
  let depth = 1;
  let pos = startFrom;

  while (pos < content.length && depth > 0) {
    const nextStart = content.indexOf(TOGGLE_START, pos);
    const nextEnd = content.indexOf(TOGGLE_END, pos);

    if (nextEnd === -1) return -1;

    if (nextStart !== -1 && nextStart < nextEnd) {
      depth++;
      pos = nextStart + TOGGLE_START.length;
    } else {
      depth--;
      if (depth === 0) return nextEnd;
      pos = nextEnd + TOGGLE_END.length;
    }
  }

  return -1;
}

// pull 이 제목 줄에 실은 콜아웃 스타일 마커(ADR-008). params 는 encodeURIComponent 된
// 이모지를 포함해 `%` 가 섞이므로 반드시 lazy 매치여야 한다(P3 synced 마커와 동일 교훈).
const CALLOUT_STYLE_MARKER_RE = new RegExp(`\\s*%%${MARKER_BRAND_RE}:callout-style:(.*?)%%`);

function parseCalloutStyleParams(params: string): { icon?: string; color?: string } {
  const style: { icon?: string; color?: string } = {};
  for (const kv of params.split("&")) {
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    const key = kv.slice(0, eq);
    const value = decodeURIComponent(kv.slice(eq + 1));
    if (key === "icon") style.icon = value;
    else if (key === "color") style.color = value;
  }
  return style;
}

// Obsidian 콜아웃 → NFM 정준형 `<callout icon color>` 태그 (ADR-008).
//
// 기존 `::: callout` 펜스 + 본문 첫 줄 이모지 방출은 NFM 이 이모지를 아이콘이 아닌
// **리터럴 본문 텍스트**로 박제함을 실측 — 정준형은 아이콘/색이 여는 태그의 속성이다.
// pull 이 실은 스타일 마커가 있으면 그대로 재조립하고, 마커 없는 사용자 작성 콜아웃은
// type→이모지를 icon 속성으로 낸다. 본문은 정준형대로 한 단계 탭 들여쓴다.
// 중첩 콜아웃·토글은 body 를 재귀 변환해 태그 중첩으로 보존한다(기존 단일 패스는
// 내부 헤드가 리터럴 `> [!x]` 줄로 새어 나갔다).
function convertObsidianCallouts(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // 선행 들여쓰기는 pull 의 클램프(callout-indent)가 남긴 것 — 받지 않으면 리스트/칼럼
    // 안 콜아웃이 push 에서 리터럴 `> [!x]` 텍스트로 Notion 에 박제된다.
    const headerMatch = /^([ \t]{0,3})> \[!(\w+)\]([-+])?[ \t]*(.*)$/.exec(lines[i]!);
    const type = headerMatch?.[2]?.toLowerCase();
    // toggle/tab 헤드는 전용 변환기(convertTogglesToHtml/restoreTabBlocks) 소관 —
    // 콜아웃으로 오변환하지 않는다.
    if (headerMatch && type !== "toggle" && type !== "tab") {
      const indentRead = readCalloutIndentDepth(headerMatch[1]!, headerMatch[4]!);
      const depth = indentRead.depth;
      let title = indentRead.title;
      let style: { icon?: string; color?: string } = {};
      const styleMatch = CALLOUT_STYLE_MARKER_RE.exec(title);
      if (styleMatch) {
        style = parseCalloutStyleParams(styleMatch[1]!);
        title = title.replace(CALLOUT_STYLE_MARKER_RE, "");
      } else {
        style.icon = calloutTypeToEmoji(type!);
      }

      const bodyLines: string[] = [];
      i++;
      // 본문은 머리줄과 **같은 들여쓰기**를 요구한다 — 여백이 다르면 다른 컨테이너다.
      // 빈 연속줄 `>` 도 본문의 일부다(콜아웃 내 단락 구분) — `> ` 만 받으면 끊긴다.
      const quote = `${headerMatch[1]!}>`;
      while (i < lines.length && (lines[i] === quote || lines[i]!.startsWith(`${quote} `))) {
        bodyLines.push(lines[i] === quote ? "" : lines[i]!.slice(quote.length + 1));
        i++;
      }
      // 내부에 남은 토글/콜아웃 헤드(원문 깊이 2+)는 quote 한 겹이 벗겨져 이제 깊이 1 —
      // 전용 변환기를 재귀 적용해 태그 중첩으로 만든다.
      const innerConverted = convertObsidianCallouts(
        convertTogglesToHtml(restoreBodyIndent(bodyLines.join("\n"))),
      );

      const attrs = `${style.icon ? ` icon="${style.icon}"` : ""}${style.color ? ` color="${style.color}"` : ""}`;
      const block: string[] = [`<callout${attrs}>`];
      const cleanTitle = title.trim();
      if (cleanTitle) block.push(`\t${cleanTitle}`);
      if (innerConverted.trim() !== "") {
        block.push(...indentContainerBody(innerConverted).split("\n"));
      }
      block.push("</callout>");
      result.push(...applyCalloutIndent(block.join("\n"), depth).split("\n"));
    } else {
      result.push(lines[i]!);
      i++;
    }
  }

  return result.join("\n");
}

const EMOJI_TYPE_MAP: Record<string, string> = {
  "💡": "tip",
  ℹ️: "info",
  "⚠️": "warning",
  "🔥": "danger",
  "✅": "success",
  "❌": "failure",
  "❓": "question",
  "📝": "note",
  "📌": "abstract",
  "🐛": "bug",
  "💬": "quote",
  "📋": "example",
};

const TYPE_EMOJI_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(EMOJI_TYPE_MAP).map(([k, v]) => [v, k]),
);

function emojiToCalloutType(emoji: string): string {
  return EMOJI_TYPE_MAP[emoji] ?? "note";
}

function calloutTypeToEmoji(type: string): string | undefined {
  return TYPE_EMOJI_MAP[type.toLowerCase()];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NOTION_PAGE_LINK_RE = /<page url="[^"]*">([\s\S]*?)<\/page>/g;
/**
 * 빈 문단 토큰(`<empty-block/>`). 선행 여백을 **인용 접두 앞**에서 받아야 한다 —
 * 여백을 인용 뒤에만 두면 `\t> <empty-block/>`(리스트/칼럼 안 콜아웃의 빈 줄)이 매칭되지
 * 않아 토큰 원문이 그대로 볼트에 새어 나간다(실측: `Creai LLM.md` pull 961행).
 */
const NOTION_EMPTY_BLOCK_RE = /^([\t ]*(?:>[\t ]*)*)<empty-block\/>[\t ]*\n?/gm;

function convertPageLinks(content: string): string {
  return content.replace(NOTION_PAGE_LINK_RE, (_match, text: string) => {
    const cleaned = text.replace(/\*\*/g, "").trim();
    return `[[${cleaned}]]`;
  });
}

// placeholder 에 databaseId 를 보존 마커로 부착한다. 표시 텍스트만 남기면 pull 후처리
// (db-placeholder-rewriter)가 어느 .base 로 임베드를 재작성해야 할지 알 수 없다.
// url 호스트는 www.notion.so / app.notion.com/p 로 갈리는 것이 실측됐으므로 32-hex 만 취한다.
function convertDatabaseBlocks(content: string): string {
  return content.replace(
    /<database\b([^>]*)>([\s\S]*?)<\/database>/g,
    (_match, attrs: string, title: string) => {
      const clean = title.trim();
      const placeholder = `**${clean}** *(Notion DB)*`;
      const idMatch = /\burl="[^"]*?([a-f0-9]{32})[^"]*"/.exec(attrs);
      if (!idMatch?.[1]) return placeholder;
      return `${placeholder}${compactMarker(
        `child-database:id=${idMatch[1]}&title=${encodeURIComponent(clean)}`,
      )}`;
    },
  );
}

// 블록 색: NFM raw 는 문단/제목/리스트/인용의 색을 줄 끝 `{color="…"}` 로 내보낸다
// (2026-07-16 실측). Obsidian 에 대응 문법이 없어 줄 끝 형태는 보존 마커로 바꾸고
// (push 가 `{color=}` 로 재조립, ADR-008), 줄 끝이 아닌 잔여 형태만 기존대로 걷어낸다.
const TRAILING_BLOCK_COLOR_RE = /[ \t]*\{color="([a-z_]+)"\}(?=[ \t]*$)/gm;

function convertBlockColorAttrs(content: string): string {
  return content
    .replace(TRAILING_BLOCK_COLOR_RE, (_m, color: string) => ` ${blockColorMarker(color)}`)
    .replace(/\s*\{color="[^"]*"\}/g, "");
}

// 인접 컨테이너 블록 분리 — Notion markdown 은 블록들을 빈 줄 없이 연속 줄로 내보내므로
// 변환된 콜아웃/토글이 연달아 붙으면 Obsidian 이 하나의 blockquote 로 융합해 두 번째
// 콜아웃 헤드가 첫 콜아웃의 본문 텍스트가 된다. 그 상태로 push 하면 두 번째 토글이
// 첫 토글 안의 리터럴 `\[!toggle\]-` 문단으로 Notion 에 실제 오염된다(실 push 왕복
// 프로브 실측). 콜아웃 헤드 직전 줄이 같은 깊이 이상의 quote 줄이면 한 단계 얕은
// quote 구분줄을 삽입한다 — 깊이 1 은 빈 줄, 깊이 2 는 `>` (안쪽만 닫고 바깥은 유지).
//
// 선행 들여쓰기(`^([\t ]*)`)까지 받아야 하는 이유: 리스트/칼럼 안의 형제 토글은 구조적
// 탭을 달고 오므로 열 0 에만 앵커하면 **분리가 전혀 일어나지 않는다**. 실측(`Creai LLM.md`
// NFM 973~975행: `\t</details>` 바로 다음 줄이 `\t<details>`) — 두 토글이 한 blockquote 로
// 융합돼 둘째 토글의 머리줄이 첫째의 본문 텍스트가 되고, push 왕복에서 `<details>` 가
// 8개 → 7개로 줄었다. 이 함수는 클램프 이전 단계라 탭 형태를 그대로 다뤄야 한다.
const CALLOUT_HEAD_RE = /^([\t ]*)((?:> )*)> \[!\w+\][-+]?/;

function separateAdjacentCallouts(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const head = CALLOUT_HEAD_RE.exec(line);
    if (head && out.length > 0) {
      const parentPrefix = `${head[1]!}${head[2]!}`;
      const prev = out[out.length - 1]!;
      if (prev.startsWith(`${parentPrefix}>`)) {
        out.push(parentPrefix.trimEnd());
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/** 인용 접두만 남은 줄인지 — `> > ` 처럼 `>` 를 하나라도 품은 여백. */
const QUOTE_ONLY_PREFIX_RE = /^[\t ]*(?:>[\t ]*)+$/;

/**
 * 빈 문단 토큰을 실제 빈 줄로 되돌린다.
 *
 * 콜아웃 **안**의 토큰은 인용 접두를 남긴다. 열 0 빈 줄로 바꾸면 Obsidian 이 거기서
 * 인용을 닫아 버려 뒤따르는 본문이 콜아웃 밖으로 떨어진다. 중첩 컬럼에서는 이 절단이
 * 시작·끝 마커를 서로 다른 콜아웃 본문으로 갈라 놓아 push 가 레이아웃을 재조립하지
 * 못했다(실측: `건강검진.md` 등 3노트 9개 `<columns>` 소실).
 */
function removeEmptyBlocks(content: string): string {
  return content.replace(NOTION_EMPTY_BLOCK_RE, (_match, prefix: string) =>
    QUOTE_ONLY_PREFIX_RE.test(prefix) ? `${prefix.trimEnd()}\n` : "\n",
  );
}

const NOTION_INLINE_MATH_RE = /\$`([^`]+)`\$/g;
const NOTION_BLOCK_MATH_RE = /\$\$\n```\n([\s\S]*?)\n```\n\$\$/g;

function convertNotionMath(content: string): string {
  let result = content.replace(NOTION_BLOCK_MATH_RE, (_match, eq: string) => {
    return `$$\n${eq.trim()}\n$$`;
  });
  result = result.replace(NOTION_INLINE_MATH_RE, (_match, eq: string) => `$${eq}$`);
  result = result.replace(/\\\$([^$]+?)\\\$/g, (_match, inner: string) => {
    const unescaped = inner.replace(/\\\^/g, "^").replace(/\\~/g, "~");
    return `$${unescaped}$`;
  });
  return result;
}

function unescapeNotionChars(content: string): string {
  return content.replace(/\\~/g, "~").replace(/\\\^/g, "^");
}

/**
 * NFM 표 블록. 선행 그룹으로 **컨테이너 접두**(들여쓰기 + 인용 마커)를 함께 잡는다.
 *
 * NFM 의 비대칭 들여쓰기 때문이다 — `<table>` 태그 줄만 구조 들여쓰기를 갖고 `<tr>/<td>`
 * 는 열 0 에 있다. 접두를 잡지 않고 치환하면 **첫 행만** 접두를 물려받고 나머지 행은
 * 열 0 으로 떨어진다. 그러면 (a) 콜아웃이 그 자리에서 끊기고 (b) 구분행이 표 헤더와
 * 분리돼 표가 통째로 죽는다(결함⑧⑨ — 실측 96건·15노트).
 *
 * 여는 태그는 {@link nfmOpenTagSource} 로 **이름 경계까지** 확인한다. 이름 뒤를 열어
 * 두면 `<table_of_contents/>` 가 여는 표로 잡혀 거기서 첫 `</table>` 까지의 본문이
 * 통째로 사라진다.
 */
const NOTION_TABLE_RE = new RegExp(
  `^(${CONTAINER_PREFIX_SOURCE})${nfmOpenTagSource("table")}([\\s\\S]*?)</table>`,
  "gm",
);
/**
 * 표 행. **속성을 허용**해야 한다 — Notion 은 배경색이 지정된 행을
 * `<tr color="gray_bg">` 로 내보내고, 그 행은 대개 헤더 행이다.
 *
 * `<tr>` 만 잡으면 그 행이 통째로 조용히 사라진다. 표는 행 수만 하나 줄어든 채
 * 멀쩡해 보이고, 다음 행이 헤더 자리로 승격돼 표의 의미가 바뀐다
 * (실측: `5단계(22~28일)` 노트에서 `**결과**|**이유**|**해결책**` 헤더 소실).
 */
const TABLE_ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const TABLE_CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;

function isAlignmentRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

/**
 * 셀 내용을 파이프 표 한 칸에 안전하게 담는다.
 *
 * 줄바꿈은 행 자체를 끊어 표를 죽이므로 `<br>` 로 접고(Obsidian 표가 렌더하는 유일한
 * 줄바꿈 표현), 셀 안 파이프는 열 경계로 오인되므로 이스케이프한다. 이스케이프 형태는
 * pull 뒷단 `unescapePipes` 가 되돌리지 않도록 표 밖 규칙과 구분되는 `\|` 를 쓴다.
 */
function toTableCell(raw: string): string {
  return raw
    .trim()
    .replace(/\r?\n/g, "<br>")
    .replace(/(?<!\\)\|/g, "\\|");
}

function convertNotionTables(content: string): string {
  // 코드블록 안의 `<table>` 은 사용자가 적어 둔 **예제 코드**다. 구조로 오인해 치환하면
  // 그 자리에서 통째로 사라진다(실측: 한 노트 `<table` 29→4 · `<tr` 158→1).
  const code = codeInteriorRanges(content);
  return content.replace(NOTION_TABLE_RE, (_match, prefix: string, tableBody: string, offset) => {
    if (isInsideRanges(code, offset as number)) return _match;
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;
    const rowRe = new RegExp(TABLE_ROW_RE.source, TABLE_ROW_RE.flags);

    while ((rowMatch = rowRe.exec(tableBody)) !== null) {
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      const cellRe = new RegExp(TABLE_CELL_RE.source, TABLE_CELL_RE.flags);
      while ((cellMatch = cellRe.exec(rowMatch[1]!)) !== null) {
        cells.push(toTableCell(cellMatch[1]!));
      }
      if (!isAlignmentRow(cells)) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) return _match;

    const colCount = Math.max(...rows.map((r) => r.length));
    const lines: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const padded = rows[i]!;
      while (padded.length < colCount) padded.push("");
      lines.push(`| ${padded.join(" | ")} |`);
      if (i === 0) {
        lines.push(`| ${padded.map(() => "---").join(" | ")} |`);
      }
    }

    // 표를 감싼 컨테이너의 접두를 **모든 행**에 입힌다 — 첫 행에만 남으면 표가 죽는다.
    return lines.map((line) => prefix + line).join("\n");
  });
}

// ─── Push 방향: 보존 마커 → Enhanced MD 복원 ───

const OBSIDIAN_MEDIA_AUDIO_RE = /\[🔊\s*([^\]]*)\]\(([^)]+)\)/g;
const OBSIDIAN_MEDIA_VIDEO_RE = /\[🎬\s*([^\]]*)\]\(([^)]+)\)/g;
const OBSIDIAN_MEDIA_PDF_RE = /\[📄\s*([^\]]*)\]\(([^)]+)\)/g;
const OBSIDIAN_MEDIA_FILE_RE = /\[📎\s*([^\]]*)\]\(([^)]+)\)/g;

function restoreMediaTags(content: string): string {
  let result = content;

  // pull 은 캡션 없는 미디어에 타입명 플레이스홀더(`[🎬 video](src)`)를 붙인다.
  // 그대로 복원하면 Notion 에 "video" 캡션이 실제로 생기는 단방향 drift — 빈 캡션으로 환원.
  const restore = (tag: string) => (_match: string, caption: string, src: string) => {
    const cap = caption.trim() === tag ? "" : caption;
    return `<${tag} src="${src}">${cap}</${tag}>`;
  };

  result = result.replace(OBSIDIAN_MEDIA_AUDIO_RE, restore("audio"));
  result = result.replace(OBSIDIAN_MEDIA_VIDEO_RE, restore("video"));
  result = result.replace(OBSIDIAN_MEDIA_PDF_RE, restore("pdf"));
  result = result.replace(OBSIDIAN_MEDIA_FILE_RE, restore("file"));

  return result;
}

// 토글과 같은 이유로 본문 줄의 끝 개행은 소비하지 않는다({@link convertTogglesToHtml} 주석).
const OBSIDIAN_TAB_RE = /^> \[!tab\]\s*(.+)((?:\n> .*)*)/gm;

function restoreTabBlocks(content: string): string {
  return content.replace(OBSIDIAN_TAB_RE, (_match, title: string, body: string) => {
    const unquoted = body
      .split("\n")
      .map((line) => line.replace(/^> /, ""))
      .join("\n")
      .trim();
    return `<tab title="${title}">${unquoted}</tab>`;
  });
}

// {@link degradeLink} 가 앞세운 가시 링크를 마커와 **한 쌍으로** 소비한다.
// 공백 없는 인접만 매칭하므로 사용자가 직접 쓴 링크는 영향받지 않는다.
const OBSIDIAN_UNKNOWN_RE = new RegExp(
  `${DEGRADE_LINK_SOURCE}%%${MARKER_BRAND_RE}:unknown:id=([^&]+)&type=([^%]+)%%`,
  "g",
);

function restoreUnknownBlocks(content: string): string {
  return content.replace(OBSIDIAN_UNKNOWN_RE, (_match, id: string, type: string) => {
    const decoded = decodeURIComponent(id);
    if (decoded.startsWith("http")) {
      return `<unknown url="${decoded}" alt="${type}"/>`;
    }
    return `<unknown id="${id}" type="${type}"/>`;
  });
}

// 페이로드는 퍼센트 인코딩되어 홑 `%` 를 남기지 않으므로 MARKER_PAYLOAD_CHAR 로 읽는다
// (`[^%]` 로 끊으면 인코딩된 `%3A` 첫 글자에서 마커가 깨진다).
const OBSIDIAN_TOC_RE = new RegExp(`%%${MARKER_BRAND_RE}:toc(?::color=([^%]+))?%%`, "g");
const OBSIDIAN_EMBED_RE = new RegExp(
  `${DEGRADE_LINK_SOURCE}%%${MARKER_BRAND_RE}:embed:src=(${MARKER_PAYLOAD_CHAR}+)%%`,
  "g",
);
// url·alt 는 각각 인코딩되어 있으므로 페이로드에 남는 홑 `&` 는 우리가 넣은 구분자뿐이다.
const OBSIDIAN_UNKNOWN_MENTION_RE = new RegExp(
  `%%${MARKER_BRAND_RE}:unknown-mention:url=(${MARKER_PAYLOAD_CHAR}+)%%`,
  "g",
);

/** {@link preserveNfmOnlyBlocks} 의 역함수 — 마커를 NFM 전용 태그로 되돌린다. */
function restoreNfmOnlyBlocks(content: string): string {
  let result = content.replace(OBSIDIAN_TOC_RE, (_match, color?: string) =>
    color ? `<table_of_contents color="${color}"/>` : `<table_of_contents/>`,
  );
  result = result.replace(
    OBSIDIAN_EMBED_RE,
    (_match, src: string) => `<embed src="${decodeURIComponent(src)}"></embed>`,
  );
  return result.replace(OBSIDIAN_UNKNOWN_MENTION_RE, (_match, payload: string) => {
    const [url, alt] = payload.split("&alt=");
    const altAttr = alt ? ` alt="${decodeURIComponent(alt)}"` : "";
    return `<unknown_mention url="${decodeURIComponent(url ?? "")}"${altAttr}/>`;
  });
}

const OBSIDIAN_COLOR_RE = new RegExp(
  `%%${MARKER_BRAND_RE}:color:([^%]+)%%([\\s\\S]*?)%%\\/color%%`,
  "g",
);

function restoreColorSpans(content: string): string {
  return content.replace(OBSIDIAN_COLOR_RE, (_match, color: string, text: string) => {
    return `<span color="${color}">${text}</span>`;
  });
}

const OBSIDIAN_UNDERLINE_RE = new RegExp(
  `%%${MARKER_BRAND_RE}:underline%%([\\s\\S]*?)%%\\/underline%%`,
  "g",
);

function restoreUnderlineSpans(content: string): string {
  return content.replace(OBSIDIAN_UNDERLINE_RE, (_match, text: string) => {
    return `<span underline="true">${text}</span>`;
  });
}

// ─── 디자인 마커 재조립 (ADR-008) ───

// 블록 색 마커 → 줄 끝 `{color="…"}` (NFM 정준형)
const OBSIDIAN_BLOCK_COLOR_RE = new RegExp(
  `[ \\t]*%%${MARKER_BRAND_RE}:block-color:([a-z_]+)%%`,
  "g",
);

function restoreBlockColorMarkers(content: string): string {
  return content.replace(OBSIDIAN_BLOCK_COLOR_RE, (_m, color: string) => ` {color="${color}"}`);
}

// 컬럼 마커 영역 → <columns>/<column> 정준형 재조립. 마커 어휘는 legacy block 경로와
// 공유(markers.ts SSOT). 영역 안 내용은 이미 모든 push 변환이 끝난 상태이므로
// (파이프라인 마지막에 실행) 정준형대로 탭 한 단계씩 들여쓰기만 하면 된다.
//
// 본문은 **시작 마커를 품지 않는 구간**으로 제한한다 — 즉 매 패스의 매치가 항상
// 최내곽이다(pull 쪽 {@link INNERMOST_COLUMNS_RE} 와 같은 관용). 단순 비탐욕
// `[\s\S]*?` 로 받으면 바깥 START 가 **안쪽 END** 에서 닫혀, 짝을 잃은 안쪽 START 와
// 바깥 END 가 아래 "잔여 마커 제거" 청소에 걷혀 중첩 한 겹이 통째로 평탄화됐다
// (실볼트 `올인원 가계부 _Lite_`: 마커 24→22 · column-list 4→2, `영화`: 49→42 실측).
//
// 마커 줄의 선행 들여쓰기도 받는다. pull 은 토글 헤딩의 자식 칼럼을 들여쓴 채 내보내는데
// (실볼트 `영화.md`: `### … {toggle="true"}` 밑 4칸), 열 0 만 매칭하면 그 영역이 통째로
// 아래 청소에 걷혀 위젯 6개가 사라졌다(마커 49→42 실측). 캡처한 들여쓰기는 재조립 결과에
// 다시 입혀 형제 줄과 같은 깊이에 머물게 한다(pull 쪽 `reindentLines` 와 같은 관용).
const INNERMOST_COLUMN_REGION_RE = new RegExp(
  `^([ \\t]*)${escapeRegex(COLUMN_LIST_START)}[ \\t]*\\n` +
    `((?:(?!^[ \\t]*${escapeRegex(COLUMN_LIST_START)})[\\s\\S])*?)` +
    `\\n?^[ \\t]*${escapeRegex(COLUMN_LIST_END)}[ \\t]*$\\n?`,
  "gm",
);

/**
 * 마커 영역 안을 칼럼 단위로 가른다 — 구분 마커에 실린 너비 비율을 함께 돌려준다.
 *
 * `String.split` 에 캡처 그룹이 있는 정규식을 주면 구분자 캡처가 결과 배열에 끼어들어
 * "본문·비율·본문·비율…" 이 뒤섞인다. 인덱스 홀짝을 세는 대신 직접 훑어 의미가 드러나는
 * 구조로 돌려준다.
 */
function splitColumnSegments(inner: string): Array<{ ratio?: string; body: string }> {
  const sepRe = new RegExp(`^[ \\t]*${COLUMN_SEP_SOURCE}[ \\t]*$`, "gm");
  const segments: Array<{ ratio?: string; body: string }> = [];
  let cursor = 0;
  // split 의 첫 조각과 같은 의미 — **첫 마커 앞** 구간. 마커를 칼럼 사이 구분자로 쓴
  // 레거시 문서에선 이게 진짜 첫 칼럼이므로 비율 없이 먼저 담는다.
  let pending: { ratio?: string; body: string } = { ratio: undefined, body: "" };
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(inner)) !== null) {
    pending.body = inner.slice(cursor, m.index);
    segments.push(pending);
    pending = { ratio: m[1], body: "" };
    cursor = m.index + m[0].length;
  }
  pending.body = inner.slice(cursor);
  segments.push(pending);
  return segments.map((s) => ({ ...s, body: s.body.replace(/^\n/, "").replace(/\n$/, "") }));
}

function reassembleColumns(content: string): string {
  let result = content;
  // 최내곽부터 한 겹씩 — 재조립 결과엔 마커가 남지 않으므로 다음 패스에서 부모가
  // 새 최내곽이 된다. 더 이상 바뀌지 않으면 멈춘다(중첩 깊이만큼만 돈다).
  let safety = 0;
  while (result.includes(COLUMN_LIST_START) && safety++ < 100) {
    const before = result;
    result = result.replace(INNERMOST_COLUMN_REGION_RE, (_m, indent: string, inner: string) => {
      const segments = splitColumnSegments(indent ? dedentContainerBody(inner) : inner);
      // 첫 조각은 **첫 마커 앞** 구간이다. pull 이 내보내는 정준형에선 칼럼마다 마커가
      // 하나씩 붙으므로 이 조각이 비어 있고, 칼럼이 아니라 구조적 잔여물이다.
      // 반대로 마커를 칼럼 **사이 구분자**로 쓴 레거시 문서에선 첫 조각이 진짜 첫 칼럼이다.
      // 그래서 "비어 있을 때만" 떨군다 — 무조건 slice(1) 하면 레거시 첫 칼럼이 사라진다.
      const cols = segments[0]?.body.trim() === "" ? segments.slice(1) : segments;
      // 나머지 빈 조각은 **버리지 않는다**(D-EMPTY-COLUMN). 빈 칼럼은 Notion 레이아웃의
      // 실제 여백 칸이라, 걷어내면 push 가 사용자의 열 구성을 좁혀 버린다.
      if (cols.every((c) => c.body.trim() === "")) return "";
      const parts = cols
        .map(
          (c) =>
            `<column${c.ratio ? ` ratio="${c.ratio}"` : ""}>\n${indentContainerBody(c.body)}\n</column>`,
        )
        .join("\n");
      const block = `<columns>\n${indentContainerBody(parts)}\n</columns>`;
      return `${indent ? indentContainerBody(block, indent) : block}\n`;
    });
    if (result === before) break;
  }
  // 소비되지 않은 잔여 컬럼 마커(quote 중첩 등 재조립 불가 위치)는 줄째 걷어낸다 —
  // Notion 으로 마커 리터럴이 새는 것보다 평탄화 degrade 가 낫다.
  result = result.replace(
    new RegExp(
      `^[>\\t ]*(?:%%${MARKER_BRAND_RE}:column-list:(?:start|end)%%|${COLUMN_SEP_SOURCE})[ \\t]*\\n?`,
      "gm",
    ),
    "",
  );
  return result;
}

function unescapePipes(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inTable = false;

  for (const line of lines) {
    // 표 판정은 **컨테이너 접두를 떼고** 한다. 열 0 기준으로만 보면 콜아웃/칼럼 안 표
    // (`> | a | b |`)가 표로 인식되지 않고, 그 순간 셀 안 이스케이프가 풀려 파이프가
    // 열 경계로 되살아나 표가 깨진다(CONTAINER_PREFIX_SOURCE 주석 참조).
    const trimmed = splitContainerPrefix(line).body.trim();
    if (/^\|.*\|$/.test(trimmed) || /^\|[\s-|]+\|$/.test(trimmed)) {
      inTable = true;
      result.push(line);
      continue;
    }
    if (!trimmed.startsWith("|")) inTable = false;
    result.push(inTable ? line : line.replace(/\\\|/g, "|"));
  }

  return result.join("\n");
}

/**
 * 콜아웃 본문이 빈 줄로 끊겨 있으면 `>` 로 이어 붙여 한 덩어리로 되살린다.
 *
 * 단, 미디어 자리표시자 quote 는 **설계상 독립 블록**이라 이어 붙이지 않는다
 * ({@link MEDIA_PLACEHOLDER_HEAD} 주석 참조). 이어 붙이면 복원기가 자리표시자를
 * `![[..]]` 로 바꾼 뒤 이음줄 `>` 만 콜아웃 꼬리에 남고, 그 껍데기가 왕복 1회차엔
 * 있다가 2회차엔 사라져 파일이 영영 수렴하지 않았다(실볼트 34파일 실측).
 */
function ensureCalloutContinuity(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" && i > 0 && i < lines.length - 1) {
      const prev = result[result.length - 1] ?? "";
      const next = lines[i + 1] ?? "";
      const joinable = (s: string): boolean => /^>/.test(s) && !MEDIA_PLACEHOLDER_LINE_RE.test(s);
      if (joinable(prev) && joinable(next) && !/^> \[!/.test(next)) {
        result.push(">");
        continue;
      }
    }
    result.push(line);
  }
  return result.join("\n");
}

/** 줄 하나가 미디어 자리표시자 quote 인지. */
const MEDIA_PLACEHOLDER_LINE_RE = new RegExp(`^${MEDIA_PLACEHOLDER_HEAD}`);
