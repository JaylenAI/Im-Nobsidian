import {
  MARKER_BRAND_RE,
  compactMarker,
  TOGGLE_START,
  TOGGLE_END,
  WIKILINK_PROTOCOL,
} from "../constants/markers.js";

const NOTION_CALLOUT_RE = /^::: callout\n([\s\S]*?)\n:::/gm;
const NOTION_CALLOUT_TAG_RE = /<callout[^>]*>\n?([\s\S]*?)<\/callout>/g;
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
  result = convertToggles(result);
  result = convertCallouts(result);
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
  result = convertColumnBlocks(result);
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
 * 본문이 열 0 이라 공통 최소값이 0 → 무변경). 따라서 코드블록을 인식해 다르게 처리한다:
 *  - **코드펜스 줄**: 선행 들여쓰기를 모두 제거해 열 0 으로 정렬(펜스 문자·길이는 보존).
 *  - **코드블록 내부**: 의미적 들여쓰기이므로 원문 그대로 보존.
 *  - **그 외(산문)**: 공통 선행 들여쓰기만 제거(중첩 리스트 등 상대 들여쓰기는 보존).
 * 앞뒤 빈 줄은 정리하고, 공백만 있는 줄은 비운다.
 */
function dedentContainerBody(text: string): string {
  const lines = text.split("\n");
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

  // 1패스: 코드블록 경계를 추적해 각 줄을 분류한다.
  type LineKind = "fence" | "code" | "prose";
  const kinds: LineKind[] = [];
  let inCode = false;
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of lines) {
    const m = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!inCode) {
      if (m) {
        inCode = true;
        fenceChar = m[1]![0]!;
        fenceLen = m[1]!.length;
        kinds.push("fence");
      } else {
        kinds.push("prose");
      }
    } else if (m && m[1]![0] === fenceChar && m[1]!.length >= fenceLen && m[2]!.trim() === "") {
      inCode = false;
      kinds.push("fence");
    } else {
      kinds.push("code");
    }
  }

  // 2패스: 산문 줄의 공통 선행 들여쓰기 계산(상대 들여쓰기 보존 — textwrap.dedent 의미론).
  let min = Infinity;
  lines.forEach((l, i) => {
    if (kinds[i] !== "prose" || l.trim() === "") return;
    min = Math.min(min, /^[\t ]*/.exec(l)![0].length);
  });
  if (!Number.isFinite(min)) min = 0;

  // 3패스: fence→열0 정렬, code→원문 보존, prose→공통 들여쓰기 제거.
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

// 가장 안쪽(중첩 없는) <details> 만 매칭한다. body 패턴 `(?:(?!<details>)[\s\S])*?` 가
// 내부에 또 다른 <details> 시작이 없음을 보장하므로, 비탐욕 단일 정규식이 중첩을 잘못
// 짝짓는 문제(바깥 열림 ↔ 안쪽 닫힘)를 피한다. innermost 부터 치환하면 다음 패스에서
// 바깥 토글이 새로운 innermost 가 되어 임의 깊이 중첩이 올바른 순서로 환원된다.
const INNERMOST_TOGGLE_RE =
  /[\t ]*<details>\s*<summary>([\s\S]*?)<\/summary>((?:(?!<details>)[\s\S])*?)<\/details>/;

function convertToggles(content: string): string {
  let result = content;
  let safety = 0;
  while (result.includes("<details>") && safety++ < 1000) {
    const next = result.replace(INNERMOST_TOGGLE_RE, (_match, title: string, rawBody: string) => {
      // 구조적 들여쓰기를 dedent 로 제거한 뒤 `> ` 를 덧붙인다. 평면·중첩·혼합 본문 모두에서
      // 코드펜스가 열 0칸으로 정렬돼 `> \t``` ` cascade 를 차단하고, 바깥 토글이 다음 패스에서
      // 이 줄들에 다시 `> ` 를 입히면 `> > ` 형태의 올바른 Obsidian 중첩 콜아웃이 된다.
      const body = dedentContainerBody(rawBody);
      const calloutBody = body
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n");
      return `> [!toggle]- ${title.trim()}\n${calloutBody}`;
    });
    if (next === result) break;
    result = next;
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

function convertCallouts(content: string): string {
  let result = content.replace(NOTION_CALLOUT_TAG_RE, (_match, body: string) =>
    calloutBodyToObsidian(body),
  );
  result = result.replace(NOTION_CALLOUT_RE, (_match, body: string) => calloutBodyToObsidian(body));
  return result;
}

function convertPageMentions(content: string): string {
  let result = content.replace(NOTION_PAGE_MENTION_RE, (_match, _id: string, text: string) => {
    const cleaned = text.trim();
    return `[[${cleaned}]]`;
  });
  result = result.replace(
    /<mention-page\s+url="https?:\/\/(?:www\.)?notion\.so\/([a-f0-9]{32})"[^>]*\/>/g,
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

function convertColumnBlocks(content: string): string {
  return content.replace(/<columns>\n?([\s\S]*?)<\/columns>/g, (_match, inner: string) => {
    return inner
      .replace(/\t?<column>\n?/g, "")
      .replace(/\t?<\/column>\n?/g, "")
      .trim();
  });
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
