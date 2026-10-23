import type { ConversionPipeline } from "./pipeline.js";
import type { ConversionContext } from "../types/convert.js";
import { obsidianToNotionEnhanced } from "./enhanced-md-converter.js";
import { MATH_FENCE_RE, codeLineMask } from "../utils/md-regions.js";
import { restoreChildTags, type ChildTag } from "./child-tags.js";

/**
 * push 가 Notion 에 보낼 꼴 — 경로 · 본문 · 속성 · 미룬 코드 · 올릴 파일을 한 글로. 두 노트의 꼴이 같으면
 * push 한 뒤 Notion 에서 같다(pull 이 로컬 표기를 되살리는 기준, `restoreLocalForm`).
 *
 * 본문은 Markdown API 로 보내는 글에서 코드 · 수식 밖의 빈 줄을 빼고 들여쓰기를 깊이로 바꾼 것이다
 * ({@link canonicalBody}). 블록 경로면 블록으로 바꾸기 전의 글 그대로다 — 그 글에서는 빈 줄이 블록을 가른다.
 *
 * 속성은 키 차례를 보지 않는다 — Notion 속성에는 차례가 없다. 페이지 노트의 frontmatter 는 본문의 속성 코드
 * 블록(`PropertiesTableInjector`)에 차례째 실려 본문이 견준다. 보존 마커 목록은 견주지 않는다 — Notion 이
 * 아니라 로컬 상태 DB 에 적고, 자리(`startIndex`)가 노트마다 다르다.
 *
 * @param children 그 페이지의 자식 페이지 · DB — push 가 하듯 가리키는 줄에 두고, 없으면 본문 끝에 둔다.
 */
export function sentForm(
  pipeline: ConversionPipeline,
  note: string,
  context: ConversionContext,
  children: readonly ChildTag[] = [],
): string {
  const path = pipeline.selectPath(note);
  const result = pipeline.convertToNotion(note, {
    direction: "push",
    path,
    filePath: context.filePath,
    parentMode: context.parentMode,
  });
  const body =
    path === "markdown-api"
      ? canonicalBody(
          sameInNotion(
            restoreChildTags(obsidianToNotionEnhanced(result.content), children).markdown,
          ),
        )
      : result.content;
  return JSON.stringify([
    path,
    body,
    sortKeys(result.properties),
    result.deferredCode,
    result.images,
  ]);
}

/** 동기화 블록 참조의 url — 그룹 1 = 참조를 둔 페이지 조각, 2 = `#원본 블록 id`. */
const SYNCED_REF_URL_RE = /(<synced_block_reference\s+url=")[^"#]*(#[0-9a-fA-F-]{32,36}")/g;
/** Notion 페이지 링크 — 앱 주소 · 워크스페이스 · 제목 조각을 떼면 `notion.so/<id>`. 그룹 1 = id. */
const NOTION_PAGE_URL_RE =
  /https?:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/(?:[^/\s()"<>]+\/)?(?:[^/\s()"<>]*-)?([0-9a-f]{32})(?![0-9a-f])/g;
/**
 * 받을 때 아직 볼트에서 찾지 못한 페이지 링크 — 쓴 뒤 `[라벨](https://www.notion.so/<id>)` 로 바뀐다
 * (`degradeUnresolvedNotionIdWikilinks`). 그룹 1 = id, 2 = 라벨.
 */
const PENDING_NOTION_LINK_RE = /\[\[notion:([0-9a-f]{32})\|([^\][|]+)\]\]/g;
/** 글자와 주소가 같은 도메인 꼴 링크 — `[x.md](http://x.md)`. 그룹 1 = 글자. */
const DOMAIN_AUTOLINK_RE = /\[([^\][()\s]+\.[^\][()\s]+)\]\(https?:\/\/\1\)/g;

/**
 * 보내면 Notion 에서 같은 것이 되는 표기를 하나로 — 다르게 적었어도 Notion 에서 같으면 로컬 표기를 남긴다.
 *
 * - 동기화 블록 참조의 url 은 참조를 둔 페이지마다 다르다. push 는 `#원본 블록 id` 만 쓴다(deferred-synced-ref).
 * - Notion 페이지 링크는 `notion.so/제목-<id>` 로 보내도 `notion.so/<id>` 로 돌아온다(2026-10-22 실데이터 E2E).
 *   블록 링크(`notion.so/<id>#블록`)는 `app.notion.com/p/<id>#블록` 으로 돌아온다.
 *   받을 때는 볼트 밖 페이지면 `[[notion:<id>|라벨]]` 이었다가 쓴 뒤 그 링크가 된다.
 * - Notion 은 글 속 도메인 꼴 글자(`x.md` · `a.com`)에 같은 주소의 링크를 건다 — 그 링크를 보내도 같다.
 */
function sameInNotion(nfm: string): string {
  return nfm
    .replace(SYNCED_REF_URL_RE, "$1$2")
    .replace(PENDING_NOTION_LINK_RE, "[$2](https://www.notion.so/$1)")
    .replace(NOTION_PAGE_URL_RE, "https://www.notion.so/$1")
    .replace(DOMAIN_AUTOLINK_RE, "$1");
}

/** 줄머리 들여쓰기. */
const LEAD_RE = /^[ \t]*/;

/**
 * NFM 에서 Notion 이 읽지 않는 차이를 지운다 — 코드 · 수식 밖에서만. 수식 속 빈 줄은 수식의 글이다.
 *
 * - 빈 줄(공백 · 탭뿐인 줄)을 뺀다. 2026-10-04 실측: 문단 · 제목 · 인용 · 목록 사이와 콜아웃 · 토글 본문의
 *   빈 줄이 있으나 없으나 같은 블록이다. 인용 속 `>` 만 있는 줄은 빈 줄이 아니라 빈 인용 블록이다.
 * - 줄머리 들여쓰기를 깊이만큼의 탭으로 바꾼다. Notion 은 들여쓰기가 앞 블록보다 깊은지만 본다(2026-10-12
 *   실측, `nfm-to-blocks.ts`) — 목록 항목 아래 두 칸 · 네 칸 자식은 같은 자식 블록이다. 예전에는 글자로
 *   견줘, 두 칸으로 쓴 노트를 받으면 자식 줄이 네 칸으로 바뀌었다(임베드 4칸).
 *
 * 코드 · 수식 줄은 깊이 계산에서도 뺀다 — 자식을 갖지 못하는 블록이라 뒤 줄의 깊이를 정하지 않는다. 그
 * 줄의 들여쓰기는 그대로 둔다(펜스의 들여쓰기가 코드의 글을 바꿀 수 있다). 그래서 이 꼴이 다르면 Notion 에서
 * 다를 «수도» 있지만, 같으면 Notion 에서 같다.
 */
function canonicalBody(nfm: string): string {
  const inCode = codeLineMask(nfm);
  let inMath = false;
  /** 앞 줄들 가운데 지금 줄의 조상이 될 수 있는 줄의 들여쓰기 폭 — 탭 · 공백 하나가 한 폭(Notion). */
  const ancestors: number[] = [];
  const out: string[] = [];
  nfm.split("\n").forEach((line, i) => {
    if (inCode[i]) {
      out.push(line);
      return;
    }
    const mathFence = MATH_FENCE_RE.test(line);
    if (mathFence) inMath = !inMath;
    if (inMath || mathFence) {
      out.push(line);
      return;
    }
    if (line.trim() === "") return;
    const width = LEAD_RE.exec(line)![0].length;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1]! >= width) ancestors.pop();
    out.push("\t".repeat(ancestors.length) + line.slice(width));
    ancestors.push(width);
  });
  return out.join("\n");
}

/** 객체의 키를 차례대로 — 안쪽 객체까지. 날짜 · 배열의 차례는 그대로다. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}
