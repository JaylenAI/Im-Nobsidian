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
 * - 링크 글자는 NFC 로 견준다 — 볼트 경로 · 제목이 NFC 다. macOS 에서 붙여 넣은 NFD 글자도 같은 노트로 간다.
 * - 끝으로 대소문자를 가리지 않고 한 번 더 — Obsidian 은 `[[note]]` 를 `Note.md` 로 잇는다. SQLite 의 `NOCASE` 는
 *   ASCII 만 접는다.
 * - 별칭과 경로 꼬리(`%/노트.md`)는 무늬가 `%` 로 시작해 색인을 못 쓴다 — 어디에도 없는 링크(아직 올리지 않은 노트로 가는
 *   링크)는 그 둘에서 표를 훑는다. 5,000 노트 첫 push 에서 1초 남짓이다(P10 실측) — Notion 요청 시간에 견주면 작다.
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
  { sql: "SELECT * FROM wikilink_map WHERE title = ?", params: (text) => [nfc(text)] },
  {
    sql: `SELECT * FROM wikilink_map WHERE aliases LIKE ? ESCAPE '${LIKE_ESCAPE}'`,
    params: (text) => [`%${escapeLike(JSON.stringify(nfc(text)))}%`],
  },
  {
    sql: `SELECT * FROM wikilink_map WHERE obsidian_path = ? OR obsidian_path LIKE ? ESCAPE '${LIKE_ESCAPE}'`,
    params: (text) => [`${nfc(text)}.md`, `%/${escapeLike(nfc(text))}.md`],
  },
  // 둘을 OR 로 묶으면 SQLite 가 색인을 못 쓰고 표를 다 훑는다(P10) — 따로 묻는다(색인: 마이그레이션 006)
  {
    sql: "SELECT * FROM wikilink_map WHERE title = ? COLLATE NOCASE",
    params: (text) => [nfc(text)],
  },
  {
    sql: "SELECT * FROM wikilink_map WHERE obsidian_path = ? COLLATE NOCASE",
    params: (text) => [`${nfc(text)}.md`],
  },
];

function nfc(text: string): string {
  return text.normalize("NFC");
}

/**
 * relation 값의 위키링크 → 대상 DB(`parentIds` — DB id · data source id)의 행만 보는 조회들.
 *
 * - 대상 DB 밖 페이지는 고르지 않는다. Notion 은 relation 에 다른 DB 의 페이지를 넣으면 오류 없이 빼 버린다
 *   (2026-10-23 실측: 200 응답 · 값만 빠짐) — 제목이 같은 다른 DB 의 행으로 풀리면 relation 이 조용히 사라졌다.
 * - 파일 이름 → 제목 → 별칭 차례. pull 은 relation 값을 파일 이름으로 적는다. 제목을 먼저 보면 제목이 같은
 *   두 행(한쪽 파일 이름에 `(id)` 가 붙은) 가운데 엉뚱한 행을 걸었다.
 */
export function wikilinkLookupsIn(parentIds: readonly string[]): WikilinkLookup[] {
  const ids = parentIds.map((id) => id.replace(/-/g, ""));
  const scoped = (condition: string) =>
    "SELECT w.* FROM wikilink_map w JOIN sync_state s ON s.obsidian_path = w.obsidian_path " +
    `WHERE REPLACE(s.notion_parent_id, '-', '') IN (${ids.map(() => "?").join(", ")}) AND (${condition})`;
  return [
    {
      sql: scoped(`w.obsidian_path = ? OR w.obsidian_path LIKE ? ESCAPE '${LIKE_ESCAPE}'`),
      params: (text) => [...ids, `${nfc(text)}.md`, `%/${escapeLike(nfc(text))}.md`],
    },
    { sql: scoped("w.title = ?"), params: (text) => [...ids, nfc(text)] },
    {
      sql: scoped(`w.aliases LIKE ? ESCAPE '${LIKE_ESCAPE}'`),
      params: (text) => [...ids, `%${escapeLike(JSON.stringify(nfc(text)))}%`],
    },
  ];
}
