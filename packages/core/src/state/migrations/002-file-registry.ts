export const FILE_REGISTRY_MIGRATION = `
CREATE TABLE IF NOT EXISTS file_registry (
    id              TEXT PRIMARY KEY,
    local_path      TEXT NOT NULL,
    notion_page_id  TEXT NOT NULL,
    file_upload_id  TEXT NOT NULL,
    file_type       TEXT NOT NULL DEFAULT 'file',
    file_hash       TEXT NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

    CONSTRAINT chk_file_type CHECK (file_type IN ('image', 'pdf', 'video', 'audio', 'file'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_registry_path ON file_registry(local_path);
CREATE INDEX IF NOT EXISTS idx_file_registry_page ON file_registry(notion_page_id);

UPDATE sync_metadata SET value = '2' WHERE key = 'schema_version';
`;
