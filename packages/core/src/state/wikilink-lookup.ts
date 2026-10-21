/**
 * 위키링크 글자 → `wikilink_map` 행을 찾는 조회들 — 앞에서부터 처음 맞는 행을 쓴다.
 *
 * CLI 의 better-sqlite3(`StateDB`)와 플러그인의 sql.js(`SqlJsStateDB`)가 같은 차례 · 같은 SQL 을 쓰도록
 * 여기 한 벌만 둔다. 예전에는 두 곳에 손으로 베껴 있었다.
 *
 * - 제목 → 별칭 → 파일 이름 차례. 파일 이름은 `[[노트]]` 와 `[[폴더/노트]]` 둘 다 받는다.
 *   예전 조회(`LIKE '%/노트.md'`)는 슬래시가 앞에 있어야 맞아서 볼트 맨 위 노트와 경로 붙은 링크를 못 찾았다 —
 *   제목이 파일 이름과 다른 노트(파일 이름에 못 쓰는 글자를 바꾼 노트)로 가는 링크가 Notion 에서 글로 남았다.
 * - LIKE 의 `%` · `_` 는 글자로 견준다. 예전에는 `a_b` 가 `a-b.md` 에도 맞았다.
 */
export interface WikilinkLookup {
  readonly sql: string;
  readonly params: (text: string) => string[];
}

const LIKE_ESCAPE = "\\";

/** LIKE 무늬 안에서 `%` · `_` · 이스케이프 글자 자신을 글자로 만든다. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
}

export const WIKILINK_LOOKUPS: readonly WikilinkLookup[] = [
  { sql: "SELECT * FROM wikilink_map WHERE title = ?", params: (text) => [text] },
  {
    sql: `SELECT * FROM wikilink_map WHERE aliases LIKE ? ESCAPE '${LIKE_ESCAPE}'`,
    params: (text) => [`%${escapeLike(JSON.stringify(text))}%`],
  },
  {
    sql: `SELECT * FROM wikilink_map WHERE obsidian_path = ? OR obsidian_path LIKE ? ESCAPE '${LIKE_ESCAPE}'`,
    params: (text) => [`${text}.md`, `%/${escapeLike(text)}.md`],
  },
];
