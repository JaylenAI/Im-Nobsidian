// eslint-disable-next-line no-control-regex -- 파일 이름에 쓸 수 없는 제어 문자(U+0000–U+001F)를 찾는다
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
// 파일시스템상으로는 유효하지만 Obsidian 위키링크 문법(`[[제목]]`)을 깨는 문자(대괄호).
// basename 에 `[`/`]` 가 남으면 그 basename 으로 만든 `[[..]]` 가 첫 `]]` 에서 조기 종료돼
// 링크가 깨진다(예: 제목 "Attention [2017]" → `[[Attention [2017]]]`). 파일명 SSOT 인 이
// 함수에서 한 번 봉합하면 단일 변환·후처리·relation 경로가 모두 안전해진다(M5). 파일시스템
// 무효 문자(INVALID_CHARS)와는 관심사가 다르므로 상수를 분리한다. 별칭 구분자 `|` 는 이미
// INVALID_CHARS 가 처리한다.
const WIKILINK_UNSAFE_CHARS = /[[\]]/g;
// Obsidian 링크에서 뜻이 있는 글자 — `[[a#b]]` 는 노트 a 의 제목 b, `[[a^b]]` 는 블록 b 를 가리킨다. 파일 이름에
// 남으면 그 노트를 가리키는 `[[…]]` 가 다른 곳을 가리킨다. 원래 제목은 frontmatter `title` 에 남는다.
const LINK_SUBPATH_CHARS = /[#^]/g;
// 끝의 마침표 · 공백 — Windows 는 이름 끝의 마침표와 공백을 지워 다른 이름이 된다.
const TRAILING_DOTS_AND_SPACES = /[.\s]+$/;
const TRAILING_DOTS = /\.+$/;
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * 파일 이름(확장자 · 동명을 가르는 ` (id)` 를 뺀 것)의 UTF-8 바이트 상한.
 *
 * ext4 · APFS 는 이름 하나를 255 바이트까지 받는다. 예전 기준(UTF-16 200자)은 한글이면 600 바이트까지 가서
 * 긴 한글 제목의 페이지는 파일을 만들지 못했다(ENAMETOOLONG). 뒤에 붙는 것 중 가장 긴 ` (32자 id)`(35) 와
 * `.notion.json`(12)을 붙여도 255 안쪽이다. Windows(UTF-16 255자)도 안쪽이다.
 */
export const FILE_NAME_MAX_BYTES = 200;

/** 파일 시스템이 받는 이름 하나의 UTF-8 바이트 상한(ext4 · APFS). */
export const FILE_SYSTEM_NAME_MAX_BYTES = 255;

const utf8 = new TextEncoder();

/** UTF-8 바이트 수. */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/**
 * 바이트 상한 안에서 글자(grapheme) 경계로 자른다 — 이모지 · 조합 글자를 가운데서 자르지 않는다.
 */
export function truncateBytes(name: string, maxBytes: number): string {
  if (utf8.encode(name).length <= maxBytes) return name;
  let out = "";
  let bytes = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    name,
  )) {
    const size = utf8.encode(segment).length;
    if (bytes + size > maxBytes) break;
    out += segment;
    bytes += size;
  }
  return out;
}

function guarded(name: string): string {
  const safe = RESERVED_NAMES.has(name.toUpperCase()) ? `_${name}` : name;
  return safe.length === 0 ? "_untitled" : safe;
}

/**
 * Notion 제목 → 볼트 파일 이름(확장자 없이). NFC 로 — 볼트 경로는 NFC 다(`NodeVaultFS`). macOS 에서 NFD 이름으로 올린
 * 제목도 같은 파일 이름이 된다.
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(INVALID_CHARS, "_")
    .replace(WIKILINK_UNSAFE_CHARS, "_")
    .replace(LINK_SUBPATH_CHARS, "_")
    .trim();
  // 자른 뒤에 끝을 다듬는다 — 자른 자리에 남은 공백 · 마침표도 지운다.
  return guarded(truncateBytes(cleaned, FILE_NAME_MAX_BYTES).replace(TRAILING_DOTS_AND_SPACES, ""));
}

/**
 * 0.12 전의 규칙으로 붙였을 파일 이름 — `#` `^` 를 두고, UTF-16 200자에서 잘랐다. 그때 받은 노트의 이름을
 * 제목을 따르는 이름으로 알아보는 데만 쓴다. 안 그러면 이름이 제목을 따르지 않는 것으로 보여 제목 변경으로
 * 오인한다.
 */
export function legacySanitizeFileName(name: string): string {
  return guarded(
    name
      .replace(INVALID_CHARS, "_")
      .replace(WIKILINK_UNSAFE_CHARS, "_")
      .replace(TRAILING_DOTS, "")
      .trim()
      .slice(0, 200),
  );
}
