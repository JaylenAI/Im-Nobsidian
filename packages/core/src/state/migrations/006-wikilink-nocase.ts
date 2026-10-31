/**
 * 대소문자를 가리지 않는 위키링크 색인 — `WIKILINK_LOOKUPS`(wikilink-lookup.ts)의 마지막 조회(`COLLATE NOCASE`). push 는 아직 Notion 에
 * 없는 노트로 가는 링크마다 조회를 끝까지 돈다 — 색인이 없으면 링크마다 표를 다 훑어 볼트가 클수록 제곱으로 느려진다(P10).
 */
export const WIKILINK_NOCASE_MIGRATION = `
CREATE INDEX IF NOT EXISTS idx_wikilink_title_nocase ON wikilink_map(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_wikilink_path_nocase ON wikilink_map(obsidian_path COLLATE NOCASE);

UPDATE sync_metadata SET value = '6' WHERE key = 'schema_version';
`;
