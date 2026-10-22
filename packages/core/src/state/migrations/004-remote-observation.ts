/**
 * 원격을 본 기록(N-05) — 마지막 편집자 · 본 때 · 본문 지문.
 *
 * 앞선 버전이 적은 레코드는 언제 봤는지 모른다. 지금 본 것으로 적는다 — 비워 두면 첫 pull 이
 * 모든 페이지를 내용으로 다시 확인한다(1,000 쪽이면 전체 pull 과 같은 비용). 그래서 앞선 버전이
 * 놓친 같은 분 편집은 이 적기로 되찾지 않는다(ADR-017).
 */
export const REMOTE_OBSERVATION_MIGRATION = `
ALTER TABLE sync_state ADD COLUMN notion_last_edited_by TEXT;
ALTER TABLE sync_state ADD COLUMN notion_seen_at TEXT;
ALTER TABLE sync_state ADD COLUMN notion_body_fingerprint TEXT;

UPDATE sync_state SET notion_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE notion_last_edited IS NOT NULL;

UPDATE sync_metadata SET value = '4' WHERE key = 'schema_version';
`;
