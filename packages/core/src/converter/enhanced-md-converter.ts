import {
  MARKER_BRAND_RE,
  compactMarker,
  TOGGLE_START,
  TOGGLE_END,
  WIKILINK_PROTOCOL,
} from "../constants/markers.js";

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
  result = cleanInlineColorAttrs(result);
  result = removeEmptyBlocks(result);
  result = unescapePipes(result);
  result = unescapeNotionChars(result);
  result = unescapeWikilinkBrackets(result);
  result = ensureCalloutContinuity(result);

  return result;
}

// Notion markdown API 는 평문 위키링크 `[[..]]` 를 `\[\[..\]\]` 로 escape 저장한다.
// (resolved 위키링크는 mention 이 되어 이 경로를 타지 않고, unresolved 만 평문으로 보존됨)
// pull 시 escape 를 해제해 Obsidian 위키링크 기능과 push↔pull 수렴을 보장한다.
function unescapeWikilinkBrackets(content: string): string {
  return content.replace(/\\\[\\\[([\s\S]*?)\\\]\\\]/g, "[[$1]]");
}

export function obsidianToNotionEnhanced(obsidian: string): string {
  let result = obsidian;

  result = convertTogglesToHtml(result);
  result = restoreTabBlocks(result);
  result = convertObsidianCallouts(result);
  result = restoreMediaTags(result);
  result = restoreUnknownBlocks(result);
  result = restoreColorSpans(result);
  result = restoreUnderlineSpans(result);
  result = convertMentionPageIdToUrl(result);
  result = restoreWikilinkPreserveLinks(result);

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
  `\\[([^\\]]+)\\]\\(${WIKILINK_PROTOCOL}([^)]+)\\)`,
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
    let target = enc;
    try {
      target = decodeURIComponent(enc);
    } catch {
      // 잘못 인코딩된 경우 원문 유지
    }
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

  // 1패스: 코드블록·테이블 경계를 추적해 각 줄을 분류한다.
  type LineKind = "fence" | "code" | "prose";
  const kinds: LineKind[] = [];
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
const NO_CONTAINER_BODY = "(?:(?!<details>|<callout|<columns>)[\\s\\S])*?";

// <summary> 제목: 첫 </summary> 에서 반드시 멈추고 중첩 컨테이너 시작 태그를 넘지 않는다.
// 단순 `[\s\S]*?` 는 본문이 닫는 태그에 도달 못 할 때 첫 </summary> 너머로 백트랙해
// 바깥 토글을 안쪽 </summary>/</details> 와 잘못 짝짓는다(중첩 토글 mis-pair, 결함②).
const SUMMARY_TITLE = "((?:(?!<\\/summary>|<details>|<summary>)[\\s\\S])*?)";

const INNERMOST_DETAILS_RE = new RegExp(
  `([\\t ]*)<details>\\s*<summary>${SUMMARY_TITLE}<\\/summary>(${NO_CONTAINER_BODY})<\\/details>`,
  "g",
);
const INNERMOST_CALLOUT_RE = new RegExp(
  `([\\t ]*)<callout[^>]*>\\n?(${NO_CONTAINER_BODY})<\\/callout>`,
  "g",
);
const INNERMOST_COLUMNS_RE = new RegExp(
  `([\\t ]*)<columns>\\n?(${NO_CONTAINER_BODY})<\\/columns>`,
  "g",
);
const COLUMN_WRAP_RE = /[\t ]*<column>\n?([\s\S]*?)[\t ]*<\/column>\n?/g;

// 캡처한 선행 들여쓰기를 변환 결과의 비어있지-않은 모든 줄에 다시 입힌다.
function reindentLines(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split("\n")
    .map((line) => (line === "" ? line : indent + line))
    .join("\n");
}

// <details> → > [!toggle]- (본문은 dedent 후 `> ` prefix). dedent 가 코드펜스를 열 0 으로
// 정렬해 `> \t``` ` cascade 를 차단하고(결함①), 부모 패스에서 다시 `> ` 가 입혀지면
// `> > ` 형태의 올바른 Obsidian 중첩이 된다.
function toggleToCallout(title: string, rawBody: string): string {
  const body = dedentContainerBody(rawBody);
  const calloutBody = body
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `> [!toggle]- ${title.trim()}\n${calloutBody}`;
}

// <columns>/<column> → 평탄화. Obsidian 엔 칼럼 문법이 없어 각 칼럼 본문을 dedent 로
// 구조적 탭까지 벗긴 뒤 빈 줄로 구분해 이어붙인다(결함②: 탭 하나만 벗기던 기존 동작 교체).
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
  return cols.join("\n\n");
}

function convertContainers(content: string): string {
  let result = content;
  let safety = 0;
  while (
    safety++ < 2000 &&
    (result.includes("<details>") || result.includes("<callout") || result.includes("<columns>"))
  ) {
    const before = result;
    result = result.replace(
      INNERMOST_DETAILS_RE,
      (_m, indent: string, title: string, body: string) =>
        reindentLines(toggleToCallout(title, body), indent),
    );
    result = result.replace(INNERMOST_CALLOUT_RE, (_m, indent: string, body: string) =>
      reindentLines(calloutBodyToObsidian(body), indent),
    );
    result = result.replace(INNERMOST_COLUMNS_RE, (_m, indent: string, body: string) =>
      reindentLines(flattenColumns(body), indent),
    );
    if (result === before) break;
  }
  return result;
}

function calloutBodyToObsidian(body: string): string {
  // 콜아웃 본문도 토글과 동일한 코드펜스 cascade 위험이 있으므로 같은 dedent 를 적용한다.
  const lines = dedentContainerBody(body)
    .split("\n")
    .filter((l, i, arr) => !(i === 0 && l === "") && !(i === arr.length - 1 && l === ""));
  const firstLine = lines[0] ?? "";

  const emojiMatch = /^([\p{Emoji}️‍]+)\s*(.*)/u.exec(firstLine);
  const type = emojiMatch ? emojiToCalloutType(emojiMatch[1]!) : "note";
  const title = emojiMatch ? emojiMatch[2]! : firstLine;
  const rest = lines.slice(1).join("\n").trim();

  const calloutTitle = title ? `> [!${type}] ${title}` : `> [!${type}]`;
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
  // (`[^>]*?` 는 `>` 를 넘지 않는 lazy 매치, alternation 으로 self-closing/라벨형을 한 번에 처리)
  result = result.replace(
    /<mention-page\s+url="https?:\/\/(?:www\.)?notion\.so\/([a-f0-9]{32})"[^>]*?(?:\/>|>[\s\S]*?<\/mention-page>)/g,
    (_match, id: string) => `[[notion:${id}]]`,
  );
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

function convertSyncedBlockRef(content: string): string {
  let result = content.replace(
    /<synced_block_reference[^>]*>[\s\S]*?<\/synced_block_reference>/g,
    (match) => {
      const inner = match
        .replace(/<synced_block_reference[^>]*>\n?/, "")
        .replace(/<\/synced_block_reference>/, "")
        .split("\n")
        .map((l) => l.replace(/^\t/, ""))
        .join("\n")
        .trim();
      return inner;
    },
  );
  result = result.replace(
    /<synced_block[^>]*>\n?([\s\S]*?)<\/synced_block>/g,
    (_match, inner: string) => inner.trim(),
  );
  return result;
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

function convertTogglesToHtml(content: string): string {
  const calloutToggleRe = /^> \[!toggle\]-\s*(.+)\n((?:>.*\n?)*)/gm;

  let result = content;
  let prev = "";
  let safety = 0;
  while (result !== prev && safety++ < 100) {
    prev = result;
    result = result.replace(calloutToggleRe, (_match, title: string, body: string) => {
      const bodyText = body
        .split("\n")
        .map((line) => line.replace(/^>\s?/, ""))
        .join("\n")
        .trim();
      return `<details>\n<summary>${title.trim()}</summary>\n\n${bodyText}\n\n</details>`;
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

function convertObsidianCallouts(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerMatch = /^> \[!(\w+)\]([-+])?\s*(.*)/.exec(lines[i]!);
    if (headerMatch) {
      const type = headerMatch[1]!;
      const title = headerMatch[3]!;
      const emoji = calloutTypeToEmoji(type) ?? "💡";
      const calloutTitle = title ? `${emoji} ${title}` : emoji;

      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        bodyLines.push(lines[i]!.slice(2));
        i++;
      }

      result.push("::: callout");
      result.push(calloutTitle);
      if (bodyLines.length > 0) {
        result.push(...bodyLines);
      }
      result.push(":::");
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

function convertDatabaseBlocks(content: string): string {
  return content.replace(
    /<database[^>]*>([\s\S]*?)<\/database>/g,
    (_match, title: string) => `**${title.trim()}** *(Notion DB)*`,
  );
}

function cleanInlineColorAttrs(content: string): string {
  return content.replace(/\s*\{color="[^"]*"\}/g, "");
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

  result = result.replace(OBSIDIAN_MEDIA_AUDIO_RE, (_match, caption: string, src: string) => {
    return `<audio src="${src}">${caption}</audio>`;
  });

  result = result.replace(OBSIDIAN_MEDIA_VIDEO_RE, (_match, caption: string, src: string) => {
    return `<video src="${src}">${caption}</video>`;
  });

  result = result.replace(OBSIDIAN_MEDIA_PDF_RE, (_match, caption: string, src: string) => {
    return `<pdf src="${src}">${caption}</pdf>`;
  });

  result = result.replace(OBSIDIAN_MEDIA_FILE_RE, (_match, caption: string, src: string) => {
    return `<file src="${src}">${caption}</file>`;
  });

  return result;
}

const OBSIDIAN_TAB_RE = /^> \[!tab\]\s*(.+)\n((?:> .*\n?)*)/gm;

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

function ensureCalloutContinuity(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" && i > 0 && i < lines.length - 1) {
      const prev = result[result.length - 1] ?? "";
      const next = lines[i + 1] ?? "";
      if (/^>/.test(prev) && /^>/.test(next) && !/^> \[!/.test(next)) {
        result.push(">");
        continue;
      }
    }
    result.push(line);
  }
  return result.join("\n");
}
