/**
 * 대소문자를 가리지 않는 경로 색인 — `getByPathKey`. 받으며 고르는 이름이 대소문자만 다른 다른 노트의 이름이면
 * macOS · Windows 에서 그 파일을 덮는다(P9). 노트마다 묻는다 — 색인이 없으면 5,000 노트 볼트가 노트마다 표를 다 훑는다.
 */
export const PATH_NOCASE_MIGRATION = `
CREATE INDEX IF NOT EXISTS idx_sync_state_path_nocase ON sync_state(obsidian_path COLLATE NOCASE);

UPDATE sync_metadata SET value = '5' WHERE key = 'schema_version';
`;
