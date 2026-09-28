import { plainFrontmatterValue } from "../utils/frontmatter.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";

/**
 * 노트의 Notion 제목을 정하는 규칙 — 페이지와 DB 행이 같은 규칙을 쓴다.
 *
 * 만들 때 · 고칠 때 · 옮길 때가 같은 규칙이어야 한다. 예전에는 페이지를 파일 이름으로 만들고
 * 고칠 때마다 frontmatter `title` 을 보냈다. 그래서 첫 갱신에서 제목이 뒤집혔고, 파일 이름을
 * 바꿔도 다음 갱신이 옛 `title` 로 제목을 되돌렸다(S-11).
 */

type Frontmatter = Readonly<Record<string, unknown>>;

/** frontmatter 에 적힌 제목. 없거나 비었으면 null. YAML 이 숫자 · 날짜로 읽은 값도 글로 되돌린다. */
export function explicitTitle(frontmatter: Frontmatter): string | null {
  const title = frontmatter.title;
  if (title === null || title === undefined) return null;
  const text = String(plainFrontmatterValue(title));
  return text.trim() ? text : null;
}

/**
 * 노트의 제목 — frontmatter `title` 이 있으면 그것, 없으면 파일 이름.
 *
 * pull 은 파일 이름으로 되살릴 수 없는 제목을 `title` 에 적는다(행은 늘). 파일 이름은 Notion
 * 제목에서 파일명에 못 쓰는 글자를 바꾼 것이라(`A/B` → `A_B`), 파일 이름을 제목으로 되밀면
 * 원래 제목이 깨진다.
 */
export function noteTitle(frontmatter: Frontmatter, path: string): string {
  return explicitTitle(frontmatter) ?? wikilinkTitleFromPath(path);
}

/** pull 이 이 제목으로 붙였을 파일 이름인가 — 자연 이름, 또는 동명 충돌을 가른 페이지 id 접미사. */
function isFileNameOf(title: string, fileName: string): boolean {
  const safe = sanitizeFileName(title);
  if (fileName === safe) return true;
  return fileName.startsWith(safe) && /^ \([0-9a-f]{8,32}\)$/i.test(fileName.slice(safe.length));
}

/** 이 제목이 이 경로의 파일 이름을 따르는가 — pull 이 이 제목으로 그 파일 이름을 붙였을 경우. */
export function followsFileName(title: string, path: string): boolean {
  return isFileNameOf(title, wikilinkTitleFromPath(path));
}

/**
 * Notion 제목이 지난 동기화 때의 제목 그대로인가 — frontmatter `title` 이 있었으면 그것,
 * 없었으면 파일 이름을 따르는 제목이다(pull 이 붙인 id 접미사 포함).
 *
 * @param base 지난 동기화 시점의 frontmatter.
 * @param path 지난 동기화 시점의 경로.
 */
export function titleUnchangedSince(base: Frontmatter, path: string, remoteTitle: string): boolean {
  const title = explicitTitle(base);
  return title !== null ? title === remoteTitle : followsFileName(remoteTitle, path);
}

/**
 * 옮기거나 이름을 바꾼 노트의 새 제목. 바꿀 것이 없으면 null.
 *
 * - frontmatter `title` 을 고쳤으면 그것이 새 제목이다.
 * - 파일 이름을 바꿨으면 새 파일 이름이 새 제목이다 — Notion 제목이 옛 파일 이름을 따르고 있던
 *   경우(파일 이름으로 만들었거나, pull 이 그 제목으로 옛 파일 이름을 붙였다). 사용자가 파일
 *   이름과 따로 정한 제목은 이름을 바꿔도 그대로 둔다.
 * - 폴더만 옮겼으면 제목은 그대로다.
 *
 * frontmatter 가 아니라 Notion 의 지금 제목과 견준다. 행은 pull 이 제목을 frontmatter 에 적는데,
 * 이름을 바꿔 올린 뒤에도 그 값은 다음 pull 전까지 옛 제목이다 — 그것과 견주면 두 번째 이름
 * 변경부터 제목이 따라가지 않는다.
 *
 * @param base 지난 동기화 시점의 frontmatter. 모르면 null — Notion 제목과 다르게 적힌 `title` 을
 *   고친 것으로 본다.
 * @param remoteTitle Notion 페이지의 지금 제목.
 */
export function titleAfterMove(
  base: Frontmatter | null,
  current: Frontmatter,
  from: string,
  to: string,
  remoteTitle: string,
): string | null {
  const written = explicitTitle(current);
  const fromName = wikilinkTitleFromPath(from);
  const toName = wikilinkTitleFromPath(to);
  const titleEdited =
    base === null ? written !== null && written !== remoteTitle : written !== explicitTitle(base);

  let after: string | null;
  if (titleEdited) after = written ?? toName;
  else if (fromName === toName) after = null;
  else after = isFileNameOf(remoteTitle, fromName) ? toName : null;

  return after === null || after === remoteTitle ? null : after;
}

/**
 * 옮긴 노트의 제목이 바뀔 수 있는가. 아니면 Notion 제목을 읽지 않는다 — 폴더째 옮긴 노트마다
 * 페이지를 한 번씩 읽지 않게.
 */
export function titleMayChange(
  base: Frontmatter | null,
  current: Frontmatter,
  from: string,
  to: string,
): boolean {
  if (wikilinkTitleFromPath(from) !== wikilinkTitleFromPath(to)) return true;
  const written = explicitTitle(current);
  return base === null ? written !== null : written !== explicitTitle(base);
}

/** 경로의 파일 이름 — 확장자 `.md` 를 뗀다. */
export function extractTitle(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1] ?? "";
  return filename.replace(/\.md$/, "");
}

/** 페이지 · 행 제목만 바꾸는 속성 — 제목 속성의 id 는 페이지 · 행 모두 `title` 이다. */
export function titleProperty(title: string): Record<string, unknown> {
  return { title: { title: [{ text: { content: title } }] } };
}

/**
 * 노트의 별칭 — frontmatter `aliases`(없으면 `alias`)의 목록, 또는 쉼표로 가른 글. 위키링크
 * 레지스트리에 제목과 함께 적는다.
 */
export function extractAliases(properties: Record<string, unknown>): string[] {
  const raw = properties.aliases ?? properties.alias;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === "string");
  if (typeof raw === "string")
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}
