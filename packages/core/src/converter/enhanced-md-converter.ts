import {
  MARKER_BRAND_RE,
  compactMarker,
  TOGGLE_START,
  TOGGLE_END,
  COLUMN_LIST_START,
  COLUMN_SEP,
  COLUMN_LIST_END,
  WIKILINK_PROTOCOL,
  syncedStartMarker,
  SYNCED_END,
  calloutStyleMarker,
  toggleColorMarker,
  blockColorMarker,
  MEDIA_PLACEHOLDER_HEAD,
} from "../constants/markers.js";
import { decodeMarkerTarget, MARKER_URL_CAPTURE, MARKER_LABEL_CAPTURE } from "./marker-url.js";
import { mapOutsideCodeFences } from "../utils/md-regions.js";

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

  result = convertSyncedBlockRef(result);
  result = normalizeCodeBlockToggles(result);
  result = convertContainers(result);
  result = convertFencedCallouts(result);
  result = convertPageMentions(result);
  result = convertPageLinks(result);
  result = convertUserMentions(result);
  result = convertDateMentions(result);
  result = convertMediaTags(result);
  result = convertTabBlocks(result);
  result = preserveUnknownBlocks(result);
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
  result = restoreColorSpans(result);
  result = restoreBlockColorMarkers(result);
  result = restoreUnderlineSpans(result);
  result = convertMentionPageIdToUrl(result);
  result = restoreWikilinkPreserveLinks(result);
  result = restoreSyncedBlocks(result);
  // 컬럼 재조립은 마지막 — 영역 내부 내용이 위 모든 변환을 먼저 통과해야 하고,
  // 잔여 디자인 마커 안전망(strip)도 여기서 함께 처리된다.
  result = reassembleColumns(result);

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
    const target = decodeMarkerTarget(enc);
    return target === label ? `[[${target}]]` : `[[${target}|${label}]]`;
  });
}

/**
 * 코드펜스 본문에 나타나는 가장 긴 백틱 런보다 1 이상 긴 펜스를 만든다(최소 3).
 *
 * CommonMark fenced-code 규칙: 본문에 펜스와 같은 길이의 백틱 런이 있으면 그 지점에서
 * 코드블록이 조기 종료된다. 토글/콜아웃 본문에 마크다운 예제(펜스 포함)가 들어가는 경우
 * 3-백틱 고정 펜스는 깨지므로, 본문을 스캔해 안전한 펜스 길이를 동적으로 결정한다.
 */
function fenceFor(body: string): string {
  let longest = 0;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * 컨테이너 본문 한 줄의 성격. 들여쓰기를 **붙일 때도 뗄 때도** 같은 기준으로 갈라야
 * push/pull 이 서로의 역함수가 된다({@link indentContainerBody} 주석 참조).
 */
type ContainerLineKind = "fence" | "code" | "prose";

/**
 * 컨테이너(토글/콜아웃) 본문을 blockquote(`> `)로 감싸기 전에 적용하는 dedent.
 *
 * Notion Markdown API 는 `<details>`/callout 의 직계 자식을 중첩 깊이만큼 탭으로
 * 들여쓴다. 특히 **코드블록은 펜스 줄만 탭으로 들여쓰고 내부 코드 텍스트는 열 0 에
 * 그대로 둔다(비대칭 들여쓰기)** — 실제 Notion 출력에서 확인된 구조다:
 *
 * ```
 * <details>
 * <summary>제목</summary>
 * \t```javascript      ← 펜스만 탭 들여쓰기
 * 코드 본문 (열 0)      ← 내부 텍스트는 들여쓰기 없음
 * \t```
 * </details>
 * ```
 *
 * 이 들여쓰기를 둔 채 `> ` 를 붙이면 펜스가 `> \t``` ` 가 되어 CommonMark 펜스 규칙
 * (들여쓰기 ≤3칸, 탭=4칸)을 위반한다. 그러면 코드블록이 열리거나 닫히지 않아 렌더링이
 * 깨지고, 닫는 펜스가 무시되면 이후 본문 전체를 코드로 삼키는 cascade 가 된다(결함①).
 *
 * 공통 선행 들여쓰기만 제거하는 단순 dedent 는 이 비대칭 구조를 고치지 못한다(코드
 * 본문이 열 0 이라 공통 최소값이 0 → 무변경). **테이블도 동일한 비대칭**을 보인다:
 * `<table>` 태그만 깊게 들여쓰고 내부 `<tr>/<td>` 행은 열 0 에 둔다. 이 열 0 행이 공통
 * 최소값을 0 으로 끌어내려, 같은 본문의 형제 줄(리스트·문단)까지 구조적 탭을 못 벗는
 * prefix/탭 폭주가 된다(결함②). 따라서 코드블록·테이블 블록을 인식해 다르게 처리한다:
 *  - **경계 줄(코드펜스 / <table>·</table>)**: 선행 들여쓰기를 모두 제거해 열 0 으로 정렬.
 *  - **블록 내부(코드 본문 / 테이블 행)**: 의미·열정렬을 위해 원문 그대로 보존.
 *  - **그 외(산문)**: 공통 선행 들여쓰기만 제거(중첩 리스트 등 상대 들여쓰기는 보존).
 *    공통 최소값은 **산문 줄만**으로 계산하므로 열 0 의 코드·테이블 행에 오염되지 않는다.
 * 앞뒤 빈 줄은 정리하고, 공백만 있는 줄은 비운다.
 */
function dedentContainerBody(text: string): string {
  const lines = text.split("\n");
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

  const kinds = classifyContainerLines(lines);

  // 2패스: 산문 줄의 공통 선행 들여쓰기 계산(상대 들여쓰기 보존 — textwrap.dedent 의미론).
  let min = Infinity;
  lines.forEach((l, i) => {
    if (kinds[i] !== "prose" || l.trim() === "") return;
    min = Math.min(min, /^[\t ]*/.exec(l)![0].length);
  });
  if (!Number.isFinite(min)) min = 0;

  // 3패스: 경계(fence)→열0 정렬, 내부(code)→원문 보존, 산문(prose)→공통 들여쓰기 제거.
  return lines
    .map((l, i) => {
      if (l.trim() === "") return "";
      if (kinds[i] === "code") return l;
      if (kinds[i] === "fence") return l.replace(/^[\t ]+/, "");
      return l.slice(min);
    })
    .join("\n");
}

/**
 * {@link dedentContainerBody} 의 **역함수** — 컨테이너 본문에 구조적 들여쓰기 한 단계를 입힌다.
 *
 * 핵심은 dedent 가 원문 그대로 보존하는 줄(코드블록 내부·테이블 행)에는 **탭을 붙이지
 * 않는 것**이다. 붙이면 pull 이 그 탭을 제 것으로 알고 벗기지 않아, 왕복마다 코드 본문에
 * 탭이 한 겹씩 쌓인다(콜아웃 안 코드펜스가 `> \t\t\tprint(…)` 로 무한히 자라는 래칫 —
 * 실볼트·프로브 3파일 실측). Notion Markdown API 자체도 코드/테이블 내부는 열 0 에 두는
 * 비대칭 구조를 쓰므로, 붙이지 않는 쪽이 정준형과도 일치한다.
 */
function indentContainerBody(text: string, indent = "\t"): string {
  const lines = text.split("\n");
  const kinds = classifyContainerLines(lines);
  return lines
    .map((line, i) => (line === "" || kinds[i] === "code" ? line : indent + line))
    .join("\n");
}

/**
 * 코드블록·테이블 경계를 추적해 각 줄을 분류한다 —
 * {@link dedentContainerBody}(pull)와 {@link indentContainerBody}(push)의 공통 기준.
 */
function classifyContainerLines(lines: readonly string[]): ContainerLineKind[] {
  const kinds: ContainerLineKind[] = [];
  let inCode = false;
  let fenceChar = "";
  let fenceLen = 0;
  let inTable = false;
  for (const line of lines) {
    const fence = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (inCode) {
      if (
        fence &&
        fence[1]![0] === fenceChar &&
        fence[1]!.length >= fenceLen &&
        fence[2]!.trim() === ""
      ) {
        inCode = false;
        kinds.push("fence");
      } else {
        kinds.push("code");
      }
    } else if (inTable) {
      const closes = /<\/table>/.test(line);
      kinds.push(closes ? "fence" : "code");
      if (closes) inTable = false;
    } else if (fence) {
      inCode = true;
      fenceChar = fence[1]![0]!;
      fenceLen = fence[1]!.length;
      kinds.push("fence");
    } else if (/^[\t ]*<table[^>]*>/.test(line)) {
      // <table> 태그만 깊게 들여쓰고 내부 행은 열 0 인 비대칭 구조. 한 줄에서 닫히지
      // 않으면 테이블 모드로 진입해 행을 보존, 닫는 </table> 도 경계로 열 0 정렬한다.
      if (!/<\/table>/.test(line)) inTable = true;
      kinds.push("fence");
    } else {
      kinds.push("prose");
    }
  }
  return kinds;
}

function normalizeCodeBlockToggles(content: string): string {
  // 여는/닫는 펜스의 들여쓰기를 가변(`[\t ]*`)으로 일반화하고, 펜스 길이(`{3,}`)를
  // 백레퍼런스로 대칭 매칭한다. 중첩 토글(두 탭 들여쓰기)·긴 펜스 케이스도 변환된다.
  return content.replace(
    /^[\t ]*- (.+)\n[\t ]*(`{3,})(\w*)\n([\s\S]*?)\n[\t ]*\2[\t ]*$/gm,
    (_match, title: string, _open: string, lang: string, rawBody: string) => {
      const body = dedentContainerBody(rawBody);
      const fence = fenceFor(body);
      return `<details>\n<summary>${title.trim()}</summary>\n${fence}${lang}\n${body}\n${fence}\n</details>`;
    },
  );
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
  `([\\t ]*)<callout([^>]*)>\\n?(${NO_CONTAINER_BODY})<\\/callout>`,
  "g",
);
const INNERMOST_COLUMNS_RE = new RegExp(
  `([\\t ]*)<columns[^>]*>\\n?(${NO_CONTAINER_BODY})<\\/columns>`,
  "g",
);
// `(?!s)` — `<column` 이 `<columns` 를 삼키지 않게 구분(속성 허용은 width_ratio 대비)
const COLUMN_WRAP_RE = /[\t ]*<column(?!s)[^>]*>\n?([\s\S]*?)[\t ]*<\/column>\n?/g;

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
  const calloutBody = body
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${head}\n${calloutBody}`;
}

// <columns>/<column> → 평탄화하되 경계를 컬럼 마커로 남긴다(ADR-008). 마커 어휘는
// legacy block 경로(block-converter)와 동일 — push 가 <columns> 정준형으로 재조립한다.
// 각 칼럼 본문은 dedent 로 구조적 탭까지 벗긴다(결함②: 탭 하나만 벗기던 기존 동작 교체).
function flattenColumns(body: string): string {
  const cols: string[] = [];
  const re = new RegExp(COLUMN_WRAP_RE.source, COLUMN_WRAP_RE.flags);
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(body)) !== null) {
    matched = true;
    const col = dedentContainerBody(m[1]!);
    if (col.trim() !== "") cols.push(col);
  }
  // <column> 래퍼가 전혀 없을 때만 폴백 dedent. 래퍼가 있으나 모두 빈 칼럼이면 cols=[] →
  // "" 반환(태그 제거됨). 폴백을 cols.length===0 으로 걸면 빈 칼럼의 <column> 태그가 샌다.
  if (!matched) return dedentContainerBody(body);
  if (cols.length === 0) return "";
  return [COLUMN_LIST_START, ...cols.map((c) => `${COLUMN_SEP}\n${c}`), COLUMN_LIST_END].join("\n");
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
  // 컨테이너 안에 중첩됐던 컬럼 마커는 quote prefix 를 얻어 push 재조립이 불가능하다 —
  // 마커 줄을 걷어내 기존 평탄화로 degrade 한다(Notion 으로 마커 리터럴 누수 방지).
  return stripQuotedColumnMarkers(result);
}

// quote 프리픽스는 `>`+공백 1개 단위로만 소비되므로, 이중 중첩(콜아웃 안 콜아웃)에서
// 남는 구조적 탭(`> > \t%%..%%`)까지 흡수하도록 마커 앞 여백을 별도로 허용한다(실측: 루틴).
const QUOTED_COLUMN_EDGE_RE = new RegExp(
  `^(?:>[ \\t]?)+[ \\t]*%%${MARKER_BRAND_RE}:column-list:(?:start|end)%%[ \\t]*\\n?`,
  "gm",
);
const QUOTED_COLUMN_SEP_RE = new RegExp(
  `^((?:>[ \\t]?)+)[ \\t]*%%${MARKER_BRAND_RE}:column%%[ \\t]*$`,
  "gm",
);
const QUOTED_COLUMN_INLINE_RE = new RegExp(
  `[ \\t]*%%${MARKER_BRAND_RE}:column(?:-list:(?:start|end))?%%`,
  "g",
);

function stripQuotedColumnMarkers(content: string): string {
  return (
    content
      .replace(QUOTED_COLUMN_EDGE_RE, "")
      .replace(QUOTED_COLUMN_SEP_RE, (_m, prefix: string) => prefix.trimEnd())
      // 콜아웃이 컬럼을 품으면 innermost 평탄화 순서상 start 마커가 본문 첫 줄이 되어
      // 콜아웃 제목으로 흡수된다(실측: 인사이드 아웃) — 줄 앵커 규칙을 벗어나므로
      // quote 줄 '안'의 인라인 발생분도 걷어 동일한 평탄화 degrade 로 수렴시킨다.
      .replace(/^(?:>[ \t]?).*%%.*$/gm, (line) =>
        line.replace(QUOTED_COLUMN_INLINE_RE, "").trimEnd(),
      )
  );
}

function calloutBodyToObsidian(body: string, style?: { icon?: string; color?: string }): string {
  // 콜아웃 본문도 토글과 동일한 코드펜스 cascade 위험이 있으므로 같은 dedent 를 적용한다.
  const lines = dedentContainerBody(body)
    .split("\n")
    .filter((l, i, arr) => !(i === 0 && l === "") && !(i === arr.length - 1 && l === ""));
  const firstLine = lines[0] ?? "";

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
  const rest = lines.slice(1).join("\n").trim();

  // icon/color 는 마커로 제목 줄에 실어 push 가 정준형 속성으로 재조립한다(ADR-008).
  // 단, 아이콘이 type 기본 이모지와 같고 색이 없으면 push 가 type 에서 동일 아이콘을
  // 재생성하므로 마커를 생략한다 — 흔한 기본 콜아웃에서 볼트 노이즈를 없앤다.
  // 마커의 icon 부재는 "아이콘 없는 콜아웃"을 뜻하므로, 마커를 낼 때는 실제 속성만 싣는다.
  const needsMarker =
    Boolean(style?.color) || (icon !== undefined && calloutTypeToEmoji(type) !== icon);
  const styleTail = needsMarker ? ` ${calloutStyleMarker({ icon, color: style?.color })}` : "";
  const calloutTitle = title ? `> [!${type}] ${title}${styleTail}` : `> [!${type}]${styleTail}`;
  const calloutBody = rest
    ? "\n" +
      rest
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n")
    : "";

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
    // URL 을 가진 임베드/북마크는 읽기뷰에서 보이지 않는 주석 마커만 남기면
    // 사용자가 "왜 빈 줄이지?" 하고 혼란스럽다. 클릭 가능한 링크를 앞에 붙이되,
    // round-trip 권위는 뒤따르는 마커(인코딩된 원본 URL)가 갖는다. 링크와 마커는
    // 공백 없이 즉시 인접시켜, 역변환 시 한 쌍으로 같이 제거 → Notion drift 방지.
    const label =
      blockType === "embed"
        ? "🔗 Embed"
        : blockType === "bookmark"
          ? "🔖 Bookmark"
          : `🔗 ${blockType}`;
    return `[${label}](${url})${marker}`;
  });
  return result;
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
    kind: "ref" | "orig",
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

  let result = content.replace(
    /([\t ]*)<synced_block_reference([^>]*)>[\s\S]*?<\/synced_block_reference>/g,
    (match, indent: string, attrs: string) =>
      rebuild(
        match,
        indent,
        attrs,
        "ref",
        /<synced_block_reference[^>]*>\n?/,
        /<\/synced_block_reference>/,
      ),
  );
  result = result.replace(
    /([\t ]*)<synced_block([^>]*)>[\s\S]*?<\/synced_block>/g,
    (match, indent: string, attrs: string) =>
      rebuild(match, indent, attrs, "orig", /<synced_block[^>]*>\n?/, /<\/synced_block>/),
  );
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
  const calloutToggleRe = /^> \[!toggle\]-[ \t]*(.*)((?:\n>.*)*)/gm;

  let result = content;
  let prev = "";
  let safety = 0;
  while (result !== prev && safety++ < 100) {
    prev = result;
    result = result.replace(calloutToggleRe, (_match, title: string, body: string) => {
      // 색상 토글 마커 → <details color> 속성으로 재조립(ADR-008)
      const colorMatch = TOGGLE_COLOR_MARKER_RE.exec(title);
      const cleanTitle = colorMatch ? title.replace(TOGGLE_COLOR_MARKER_RE, "") : title;
      const attrs = colorMatch ? ` color="${colorMatch[1]}"` : "";
      const bodyText = body
        .split("\n")
        .map((line) => line.replace(/^>\s?/, ""))
        .join("\n")
        .trim();
      return `<details${attrs}>\n<summary>${cleanTitle.trim()}</summary>\n\n${bodyText}\n\n</details>`;
    });
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
  result = result.replace(/^(<\/details>)(?!\n|$)/gm, "$1\n");
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
    const headerMatch = /^> \[!(\w+)\]([-+])?[ \t]*(.*)$/.exec(lines[i]!);
    const type = headerMatch?.[1]?.toLowerCase();
    // toggle/tab 헤드는 전용 변환기(convertTogglesToHtml/restoreTabBlocks) 소관 —
    // 콜아웃으로 오변환하지 않는다.
    if (headerMatch && type !== "toggle" && type !== "tab") {
      let title = headerMatch[3]!;
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
      // 빈 연속줄 `>` 도 본문의 일부다(콜아웃 내 단락 구분) — `> ` 만 받으면 끊긴다.
      while (i < lines.length && (lines[i] === ">" || lines[i]!.startsWith("> "))) {
        bodyLines.push(lines[i] === ">" ? "" : lines[i]!.slice(2));
        i++;
      }
      // 내부에 남은 토글/콜아웃 헤드(원문 깊이 2+)는 quote 한 겹이 벗겨져 이제 깊이 1 —
      // 전용 변환기를 재귀 적용해 태그 중첩으로 만든다.
      const innerConverted = convertObsidianCallouts(convertTogglesToHtml(bodyLines.join("\n")));

      const attrs = `${style.icon ? ` icon="${style.icon}"` : ""}${style.color ? ` color="${style.color}"` : ""}`;
      result.push(`<callout${attrs}>`);
      const cleanTitle = title.trim();
      if (cleanTitle) result.push(`\t${cleanTitle}`);
      if (innerConverted.trim() !== "") {
        result.push(...indentContainerBody(innerConverted).split("\n"));
      }
      result.push("</callout>");
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
const NOTION_EMPTY_BLOCK_RE = /^(?:>[\t ]*)*[\t ]*<empty-block\/>\n?/gm;

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
const CALLOUT_HEAD_RE = /^((?:> )*)> \[!\w+\][-+]?/;

function separateAdjacentCallouts(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const head = CALLOUT_HEAD_RE.exec(line);
    if (head && out.length > 0) {
      const parentPrefix = head[1]!;
      const prev = out[out.length - 1]!;
      if (prev.startsWith(`${parentPrefix}>`)) {
        out.push(parentPrefix.trimEnd());
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function removeEmptyBlocks(content: string): string {
  return content.replace(NOTION_EMPTY_BLOCK_RE, "\n");
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

const NOTION_TABLE_RE = /<table[^>]*>([\s\S]*?)<\/table>/g;
const TABLE_ROW_RE = /<tr>([\s\S]*?)<\/tr>/g;
const TABLE_CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;

function isAlignmentRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

function convertNotionTables(content: string): string {
  return content.replace(NOTION_TABLE_RE, (_match, tableBody: string) => {
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;
    const rowRe = new RegExp(TABLE_ROW_RE.source, TABLE_ROW_RE.flags);

    while ((rowMatch = rowRe.exec(tableBody)) !== null) {
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      const cellRe = new RegExp(TABLE_CELL_RE.source, TABLE_CELL_RE.flags);
      while ((cellMatch = cellRe.exec(rowMatch[1]!)) !== null) {
        cells.push(cellMatch[1]!.trim());
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

    return lines.join("\n");
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

// 앞에 즉시 인접(공백 없음)한 가시 링크 `[label](url)` 가 있으면 마커와 함께 소비한다.
// 이는 forward 에서 URL 임베드/북마크를 "[🔗 Embed](url)%%...%%" 로 렌더한 쌍을 통째로
// <unknown.../> 로 복원하기 위함이다. 공백 없는 인접만 매칭하므로 사용자 일반 링크는 영향 없음.
const OBSIDIAN_UNKNOWN_RE = new RegExp(
  `(?:\\[[^\\]]*\\]\\([^)]*\\))?%%${MARKER_BRAND_RE}:unknown:id=([^&]+)&type=([^%]+)%%`,
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
const COLUMN_REGION_RE = new RegExp(
  `^${escapeRegex(COLUMN_LIST_START)}[ \\t]*\\n([\\s\\S]*?)\\n?^${escapeRegex(COLUMN_LIST_END)}[ \\t]*$\\n?`,
  "gm",
);

function reassembleColumns(content: string): string {
  const sepRe = new RegExp(`^${escapeRegex(COLUMN_SEP)}[ \\t]*$`, "m");
  let result = content.replace(COLUMN_REGION_RE, (_m, inner: string) => {
    const cols = inner
      .split(new RegExp(sepRe.source, "gm"))
      .map((c) => c.replace(/^\n/, "").replace(/\n$/, ""))
      .filter((c) => c.trim() !== "");
    if (cols.length === 0) return "";
    const parts = cols.map((c) => `<column>\n${indentContainerBody(c)}\n</column>`).join("\n");
    return `<columns>\n${indentContainerBody(parts)}\n</columns>\n`;
  });
  // 소비되지 않은 잔여 컬럼 마커(quote 중첩 등 재조립 불가 위치)는 줄째 걷어낸다 —
  // Notion 으로 마커 리터럴이 새는 것보다 평탄화 degrade 가 낫다.
  result = result.replace(
    new RegExp(
      `^[>\\t ]*%%${MARKER_BRAND_RE}:(?:column-list:start|column-list:end|column)%%[ \\t]*\\n?`,
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
    if (/^\|.*\|$/.test(line.trim()) || /^\|[\s-|]+\|$/.test(line.trim())) {
      inTable = true;
      result.push(line);
    } else {
      if (inTable && line.trim() === "") {
        inTable = false;
      } else if (!/^\|/.test(line.trim())) {
        inTable = false;
      }
      result.push(inTable ? line : line.replace(/\\\|/g, "|"));
    }
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
