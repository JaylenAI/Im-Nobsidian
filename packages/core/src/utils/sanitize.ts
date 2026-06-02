// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
// 파일시스템상으로는 유효하지만 Obsidian 위키링크 문법(`[[제목]]`)을 깨는 문자(대괄호).
// basename 에 `[`/`]` 가 남으면 그 basename 으로 만든 `[[..]]` 가 첫 `]]` 에서 조기 종료돼
// 링크가 깨진다(예: 제목 "Attention [2017]" → `[[Attention [2017]]]`). 파일명 SSOT 인 이
// 함수에서 한 번 봉합하면 단일 변환·후처리·relation 경로가 모두 안전해진다(M5). 파일시스템
// 무효 문자(INVALID_CHARS)와는 관심사가 다르므로 상수를 분리한다. 별칭 구분자 `|` 는 이미
// INVALID_CHARS 가 처리한다.
const WIKILINK_UNSAFE_CHARS = /[[\]]/g;
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

export function sanitizeFileName(name: string): string {
  let sanitized = name
    .replace(INVALID_CHARS, "_")
    .replace(WIKILINK_UNSAFE_CHARS, "_")
    .replace(TRAILING_DOTS, "")
    .trim()
    .slice(0, 200);

  if (RESERVED_NAMES.has(sanitized.toUpperCase())) {
    sanitized = `_${sanitized}`;
  }

  if (sanitized.length === 0) {
    sanitized = "_untitled";
  }

  return sanitized;
}
