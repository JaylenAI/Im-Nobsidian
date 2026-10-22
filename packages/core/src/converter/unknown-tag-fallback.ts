/**
 * N6 — Notion 이 받지 않는 자리 태그를 보낼 수 있는 모양으로 바꾼다 (push, Markdown API).
 *
 * 자리 태그(`<unknown url|id …/>` · `<unknown_mention …/>`)는 «Notion 에 이미 있는 블록 · 멘션을 이 자리에
 * 두라» 는 뜻이다. 그 페이지에 그 블록이 없으면 Notion 은 본문 전체를 거절한다 — 새 페이지를 만들 때는 늘,
 * 본문을 바꿀 때는 그 블록이 다른 페이지의 것이거나 지워졌을 때다(2026-10-21 실측: 「Block … does not exist
 * in the current space」 · 「cannot safely create new `<unknown .../>` blocks」 · 「Unsupported unknown
 * mention」). 볼트 노트를 복사하거나, 받은 노트를 다른 루트로 올리거나, Notion 에서 북마크를 지운 뒤 노트를
 * 고치면 그 노트의 push 가 통째로 실패했다.
 *
 * 없는 블록의 태그는 볼트에 보이는 것으로 바꾼다. 북마크는 볼트 링크의 주소 · 캡션으로 새로 만든다 —
 * `<bookmark url="…">캡션</bookmark>` 은 북마크 블록이 되고, 목록 · 토글 · 콜아웃 안에서는 그 자식이 된다
 * (실측). 원래 주소를 모르는 북마크 · 다른 블록은 보이는 링크로, 멘션은 볼트에 보이는 것이 없으므로 뺀다.
 * 있는 블록의 태그는 그대로 보낸다 — Notion 이 그 블록을 남긴다.
 */
import { MARKER_BRAND_RE } from "../constants/markers.js";
import { mapOutsideCode } from "../utils/md-regions.js";
import { bookmarkBlockId, bookmarkOfVaultLink } from "./bookmark.js";

/** 블록 자리 태그 — 그룹 1 = 속성 이름(url · id), 2 = 그 값. */
const UNKNOWN_BLOCK_TAG_RE = /<unknown (url|id)="([^"]*)"[^>]*\/>/g;
const UNKNOWN_MENTION_TAG_RE = /<unknown_mention\s+url="([^"]*)"[^>]*?\/>/g;

/**
 * 볼트의 자리 블록 — 보이는 링크(있으면)와 보존 마커 한 쌍. 그룹 1 = 링크 이름, 2 = 링크 주소,
 * 3 = 마커가 실은 id(인코딩), 4 = 블록 종류. push 의 `restoreUnknownBlocks` 가 이 쌍을 태그로 바꾼다.
 */
const VAULT_UNKNOWN_PAIR_RE = new RegExp(
  `(?:\\[((?:\\\\.|[^\\\\\\]])*)\\]\\(([^)]*)\\))?%%${MARKER_BRAND_RE}:unknown:id=([^&]+)&type=([^%]+)%%`,
  "g",
);

/**
 * 북마크 캡션에서 `\` 로 escape 할 글자 — Notion 은 캡션을 마크다운으로 읽는다. `_i_` 는 기울임,
 * `\*` · `\[` · `\<` · `\$` 는 그 글자가 됐다(2026-10-21 실측).
 */
const CAPTION_ESCAPED_CHAR_RE = /[\\*_<>`~[\]|${}]/g;

/** 태그를 Notion 의 블록과 맞출 열쇠 — 블록 주소는 블록 ID(페이지 칸 모양과 무관), 나머지는 값 그대로. */
function blockKey(attr: string, value: string): string {
  return (attr === "url" ? bookmarkBlockId(value) : undefined) ?? `${attr}:${value}`;
}

function mentionKey(url: string): string {
  return `mention:${url}`;
}

/** 받은 본문에 있는 자리 태그의 열쇠 — 이 페이지에 실제로 있는 블록 · 멘션이다. */
export function unknownTagKeys(nfm: string): Set<string> {
  const keys = new Set<string>();
  mapOutsideCode(nfm, (segment) => {
    for (const m of segment.matchAll(UNKNOWN_BLOCK_TAG_RE)) keys.add(blockKey(m[1]!, m[2]!));
    for (const m of segment.matchAll(UNKNOWN_MENTION_TAG_RE)) keys.add(mentionKey(m[1]!));
    return segment;
  });
  return keys;
}

/**
 * 볼트 노트의 자리 블록마다 그 블록이 Notion 에 없을 때 보낼 NFM. 열쇠는 {@link unknownTagKeys} 와 같다.
 */
export function unknownTagFallbacks(vaultMarkdown: string): Map<string, string> {
  const fallbacks = new Map<string, string>();
  mapOutsideCode(vaultMarkdown, (segment) => {
    for (const m of segment.matchAll(VAULT_UNKNOWN_PAIR_RE)) {
      const [, label, url, encodedId, type] = m;
      const decoded = decodeURIComponent(encodedId!);
      const key = decoded.startsWith("http")
        ? blockKey("url", decoded)
        : blockKey("id", encodedId!);
      fallbacks.set(key, fallbackOf(label, url, decoded, type!));
    }
    return segment;
  });
  return fallbacks;
}

function fallbackOf(
  label: string | undefined,
  url: string | undefined,
  placeholder: string,
  type: string,
): string {
  if (label === undefined || url === undefined) return "";
  const bookmark = type === "bookmark" ? bookmarkOfVaultLink(label, url, placeholder) : null;
  if (bookmark === null) return `[${label}](${url})`;
  const caption = bookmark.caption.replace(CAPTION_ESCAPED_CHAR_RE, "\\$&");
  return `<bookmark url="${escapeAttr(bookmark.url)}">${caption}</bookmark>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * 보낼 본문의 자리 태그 가운데 `present` 에 없는 것을 {@link unknownTagFallbacks} 의 모양으로 바꾼다.
 * 볼트에 짝이 없는 태그는 뺀다.
 *
 * @param present 그 페이지에 있는 블록 · 멘션의 열쇠 — 새 페이지면 빈 집합
 * @returns 바꾼 본문과 바꾼 태그 수
 */
export function replaceMissingUnknownTags(
  nfm: string,
  present: ReadonlySet<string>,
  fallbacks: ReadonlyMap<string, string>,
): { nfm: string; replaced: number } {
  let replaced = 0;
  const swap = (tag: string, key: string): string => {
    if (present.has(key)) return tag;
    replaced += 1;
    return fallbacks.get(key) ?? "";
  };
  const out = mapOutsideCode(nfm, (segment) =>
    segment
      .replace(UNKNOWN_BLOCK_TAG_RE, (tag, attr: string, value: string) =>
        swap(tag, blockKey(attr, value)),
      )
      .replace(UNKNOWN_MENTION_TAG_RE, (tag, url: string) => swap(tag, mentionKey(url))),
  );
  return { nfm: out, replaced };
}
