export const INITIAL_MIGRATION = `
CREATE TABLE IF NOT EXISTS sync_state (
    id              TEXT PRIMARY KEY,
    obsidian_path   TEXT NOT NULL,
    notion_page_id  TEXT,
    notion_parent_id TEXT,
    content_hash    TEXT NOT NULL,
    notion_last_edited TEXT,
    local_last_modified TEXT NOT NULL,
    sync_direction  TEXT NOT NULL DEFAULT 'both',
    file_type       TEXT NOT NULL DEFAULT 'file',
    status          TEXT NOT NULL DEFAULT 'pending',
    base_snapshot   BLOB,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

    CONSTRAINT chk_sync_direction CHECK (sync_direction IN ('push', 'pull', 'both')),
    CONSTRAINT chk_file_type CHECK (file_type IN ('file', 'folder-note', 'folder-only', 'db-row')),
    CONSTRAINT chk_status CHECK (status IN ('synced', 'pending', 'conflict', 'error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_state_path ON sync_state(obsidian_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_state_notion ON sync_state(notion_page_id) WHERE notion_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sync_state_status ON sync_state(status);
CREATE INDEX IF NOT EXISTS idx_sync_state_parent ON sync_state(notion_parent_id);

CREATE TABLE IF NOT EXISTS wikilink_map (
    obsidian_path   TEXT PRIMARY KEY,
    notion_page_id  TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    aliases         TEXT DEFAULT '[]',
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wikilink_title ON wikilink_map(title);
CREATE INDEX IF NOT EXISTS idx_wikilink_notion ON wikilink_map(notion_page_id);

CREATE TABLE IF NOT EXISTS pending_operations (
    id              TEXT PRIMARY KEY,
    sync_state_id   TEXT NOT NULL REFERENCES sync_state(id) ON DELETE CASCADE,
    operation       TEXT NOT NULL,
    direction       TEXT NOT NULL,
    payload         TEXT,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT,

    CONSTRAINT chk_operation CHECK (operation IN ('create', 'update', 'delete', 'move')),
    CONSTRAINT chk_direction CHECK (direction IN ('push', 'pull')),
    CONSTRAINT chk_op_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_operations(status, created_at);

CREATE TABLE IF NOT EXISTS image_registry (
    id              TEXT PRIMARY KEY,
    sync_state_id   TEXT NOT NULL REFERENCES sync_state(id) ON DELETE CASCADE,
    notion_file_url TEXT NOT NULL,
    local_path      TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    file_size       INTEGER NOT NULL,
    mime_type       TEXT NOT NULL,
    expires_at      TEXT,
    downloaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_image_hash ON image_registry(content_hash);
CREATE INDEX IF NOT EXISTS idx_image_sync ON image_registry(sync_state_id);

CREATE TABLE IF NOT EXISTS sync_metadata (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);

INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('schema_version', '1');
`;
