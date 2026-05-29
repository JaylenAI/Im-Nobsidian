import type { Database as SqlJsDatabase } from "sql.js";
import initSqlJs from "sql.js";
import type {
  IStateDB,
  UpsertSyncRecord,
  FileRegistryEntry,
  RegisterFileInput,
} from "@im-nobsidian/core";
import type { SyncRecord, SyncStatus, WikilinkEntry, PreserveMarker } from "@im-nobsidian/core";
import { generateId } from "@im-nobsidian/core";

const INITIAL_MIGRATION = `
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
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
    completed_at    TEXT
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

const FILE_REGISTRY_MIGRATION = `
CREATE TABLE IF NOT EXISTS file_registry (
    id              TEXT PRIMARY KEY,
    local_path      TEXT NOT NULL,
    notion_page_id  TEXT NOT NULL,
    file_upload_id  TEXT NOT NULL,
    file_type       TEXT NOT NULL DEFAULT 'file',
    file_hash       TEXT NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_registry_path ON file_registry(local_path);
CREATE INDEX IF NOT EXISTS idx_file_registry_page ON file_registry(notion_page_id);

UPDATE sync_metadata SET value = '2' WHERE key = 'schema_version';
`;

const STAT_CACHE_MIGRATION = `
ALTER TABLE sync_state ADD COLUMN local_mtime TEXT;
ALTER TABLE sync_state ADD COLUMN local_file_size INTEGER;

UPDATE sync_metadata SET value = '3' WHERE key = 'schema_version';
`;

interface RawSyncRow {
  id: string;
  obsidian_path: string;
  notion_page_id: string | null;
  notion_parent_id: string | null;
  content_hash: string;
  notion_last_edited: string | null;
  local_last_modified: string;
  sync_direction: string;
  file_type: string;
  status: string;
  base_snapshot: Uint8Array | null;
  local_mtime: string | null;
  local_file_size: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface RawWikilinkRow {
  obsidian_path: string;
  notion_page_id: string;
  title: string;
  aliases: string;
}

interface RawFileRegistryRow {
  id: string;
  local_path: string;
  notion_page_id: string;
  file_upload_id: string;
  file_type: string;
  file_hash: string;
  file_size: number;
}

export class SqlJsStateDB implements IStateDB {
  private db: SqlJsDatabase;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushFn: ((data: Uint8Array) => Promise<void>) | null;

  private constructor(db: SqlJsDatabase, flushFn?: (data: Uint8Array) => Promise<void>) {
    this.db = db;
    this.flushFn = flushFn ?? null;
  }

  static async open(
    existingData?: Uint8Array | null,
    flushFn?: (data: Uint8Array) => Promise<void>,
    wasmBinary?: ArrayBuffer,
  ): Promise<SqlJsStateDB> {
    const opts: Record<string, unknown> = {};
    if (wasmBinary) {
      opts.wasmBinary = wasmBinary;
    }
    const SQL = await initSqlJs(opts);

    const db = existingData ? new SQL.Database(existingData) : new SQL.Database();
    db.run("PRAGMA foreign_keys = ON");

    const stateDb = new SqlJsStateDB(db, flushFn);
    stateDb.migrate();
    return stateDb;
  }

  private migrate(): void {
    const version = this.getSchemaVersion();
    if (version < 1) this.db.run(INITIAL_MIGRATION);
    if (version < 2) this.db.run(FILE_REGISTRY_MIGRATION);
    if (version < 3) {
      for (const line of STAT_CACHE_MIGRATION.split(";")) {
        const trimmed = line.trim();
        if (trimmed) this.db.run(trimmed);
      }
    }
  }

  private getSchemaVersion(): number {
    try {
      const result = this.db.exec("SELECT value FROM sync_metadata WHERE key = 'schema_version'");
      if (result.length > 0 && result[0]!.values.length > 0) {
        return Number(result[0]!.values[0]![0]);
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.flushFn || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 5000);
  }

  async flush(): Promise<void> {
    if (!this.dirty || !this.flushFn) return;
    const data = this.db.export();
    await this.flushFn(data);
    this.dirty = false;
  }

  export(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty && this.flushFn) {
      const data = this.db.export();
      void this.flushFn(data);
    }
    this.db.close();
  }

  // --- helpers ---

  private queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    if (!stmt.step()) {
      stmt.free();
      return undefined;
    }
    const obj = stmt.getAsObject() as T;
    stmt.free();
    return obj;
  }

  private queryAll<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as (string | number | Uint8Array | null)[]);
    this.markDirty();
  }

  // --- sync_state ---

  getByPath(path: string): SyncRecord | null {
    const row = this.queryOne<RawSyncRow>("SELECT * FROM sync_state WHERE obsidian_path = ?", [
      path,
    ]);
    return row ? this.mapRow(row) : null;
  }

  getByNotionId(pageId: string): SyncRecord | null {
    const row = this.queryOne<RawSyncRow>("SELECT * FROM sync_state WHERE notion_page_id = ?", [
      pageId,
    ]);
    return row ? this.mapRow(row) : null;
  }

  getByStatus(status: SyncStatus): SyncRecord[] {
    return this.queryAll<RawSyncRow>("SELECT * FROM sync_state WHERE status = ?", [status]).map(
      (r) => this.mapRow(r),
    );
  }

  getAll(): SyncRecord[] {
    return this.queryAll<RawSyncRow>("SELECT * FROM sync_state").map((r) => this.mapRow(r));
  }

  upsert(record: UpsertSyncRecord): SyncRecord {
    const existing = this.getByPath(record.obsidianPath);

    if (existing) {
      this.run(
        `UPDATE sync_state SET
          notion_page_id = ?, notion_parent_id = ?, content_hash = ?,
          notion_last_edited = ?, local_last_modified = ?,
          sync_direction = ?, file_type = ?, status = ?,
          base_snapshot = ?, local_mtime = ?, local_file_size = ?,
          version = version + 1, updated_at = datetime('now')
        WHERE id = ?`,
        [
          record.notionPageId ?? null,
          record.notionParentId ?? null,
          record.contentHash,
          record.notionLastEdited ?? null,
          record.localLastModified,
          record.syncDirection,
          record.fileType,
          record.status,
          record.baseSnapshot ?? null,
          record.localMtime ?? null,
          record.localFileSize ?? null,
          existing.id,
        ],
      );
      return this.getByPath(record.obsidianPath)!;
    }

    const id = generateId();
    this.run(
      `INSERT INTO sync_state
        (id, obsidian_path, notion_page_id, notion_parent_id, content_hash,
         notion_last_edited, local_last_modified, sync_direction, file_type,
         status, base_snapshot, local_mtime, local_file_size, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        record.obsidianPath,
        record.notionPageId ?? null,
        record.notionParentId ?? null,
        record.contentHash,
        record.notionLastEdited ?? null,
        record.localLastModified,
        record.syncDirection,
        record.fileType,
        record.status,
        record.baseSnapshot ?? null,
        record.localMtime ?? null,
        record.localFileSize ?? null,
      ],
    );
    return this.getByPath(record.obsidianPath)!;
  }

  updateStatus(id: string, status: SyncStatus): void {
    this.run("UPDATE sync_state SET status = ?, updated_at = datetime('now') WHERE id = ?", [
      status,
      id,
    ]);
  }

  updateHash(id: string, hash: string, snapshot?: Buffer | Uint8Array | null): void {
    if (snapshot !== undefined) {
      this.run(
        "UPDATE sync_state SET content_hash = ?, base_snapshot = ?, updated_at = datetime('now') WHERE id = ?",
        [hash, snapshot, id],
      );
    } else {
      this.run(
        "UPDATE sync_state SET content_hash = ?, updated_at = datetime('now') WHERE id = ?",
        [hash, id],
      );
    }
  }

  setNotionLastEdited(id: string, lastEdited: string): void {
    this.run(
      "UPDATE sync_state SET notion_last_edited = ?, updated_at = datetime('now') WHERE id = ?",
      [lastEdited, id],
    );
  }

  updateStatCache(id: string, mtime: string, fileSize: number): void {
    this.run(
      "UPDATE sync_state SET local_mtime = ?, local_file_size = ?, updated_at = datetime('now') WHERE id = ?",
      [mtime, fileSize, id],
    );
  }

  setNotionParentId(id: string, parentId: string): void {
    this.run(
      "UPDATE sync_state SET notion_parent_id = ?, updated_at = datetime('now') WHERE id = ?",
      [parentId, id],
    );
  }

  updatePath(id: string, newPath: string): void {
    this.run("UPDATE sync_state SET obsidian_path = ?, updated_at = datetime('now') WHERE id = ?", [
      newPath,
      id,
    ]);
  }

  delete(id: string): void {
    this.run("DELETE FROM sync_state WHERE id = ?", [id]);
  }

  // --- wikilink_map ---

  resolveWikilink(text: string): WikilinkEntry | null {
    const byTitle = this.queryOne<RawWikilinkRow>("SELECT * FROM wikilink_map WHERE title = ?", [
      text,
    ]);
    if (byTitle) return this.mapWikilinkRow(byTitle);

    const byAlias = this.queryOne<RawWikilinkRow>(
      "SELECT * FROM wikilink_map WHERE aliases LIKE ?",
      [`%"${text}"%`],
    );
    if (byAlias) return this.mapWikilinkRow(byAlias);

    const byFilename = this.queryOne<RawWikilinkRow>(
      "SELECT * FROM wikilink_map WHERE obsidian_path LIKE ?",
      [`%/${text}.md`],
    );
    return byFilename ? this.mapWikilinkRow(byFilename) : null;
  }

  resolvePageId(pageId: string): WikilinkEntry | null {
    const row = this.queryOne<RawWikilinkRow>(
      "SELECT * FROM wikilink_map WHERE notion_page_id = ?",
      [pageId],
    );
    return row ? this.mapWikilinkRow(row) : null;
  }

  upsertWikilink(entry: WikilinkEntry): void {
    this.run(
      `INSERT OR REPLACE INTO wikilink_map (obsidian_path, notion_page_id, title, aliases, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))`,
      [entry.obsidianPath, entry.notionPageId, entry.title, JSON.stringify(entry.aliases)],
    );
  }

  deleteWikilink(obsidianPath: string): void {
    this.run("DELETE FROM wikilink_map WHERE obsidian_path = ?", [obsidianPath]);
  }

  // --- sync_metadata ---

  getMeta(key: string): string | null {
    const row = this.queryOne<{ value: string }>("SELECT value FROM sync_metadata WHERE key = ?", [
      key,
    ]);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)", [key, value]);
  }

  // --- file_registry ---

  isFileRegistered(localPath: string): boolean {
    const row = this.queryOne<{ "1": number }>("SELECT 1 FROM file_registry WHERE local_path = ?", [
      localPath,
    ]);
    return !!row;
  }

  getFileRegistry(localPath: string): FileRegistryEntry | null {
    const row = this.queryOne<RawFileRegistryRow>(
      "SELECT * FROM file_registry WHERE local_path = ?",
      [localPath],
    );
    return row ? this.mapFileRegistryRow(row) : null;
  }

  getFilesByPageId(notionPageId: string): FileRegistryEntry[] {
    return this.queryAll<RawFileRegistryRow>(
      "SELECT * FROM file_registry WHERE notion_page_id = ?",
      [notionPageId],
    ).map((r) => this.mapFileRegistryRow(r));
  }

  registerFile(entry: RegisterFileInput): void {
    const id = generateId();
    this.run(
      `INSERT OR REPLACE INTO file_registry
        (id, local_path, notion_page_id, file_upload_id, file_type, file_hash, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.localPath,
        entry.notionPageId,
        entry.fileUploadId,
        entry.fileType,
        entry.fileHash,
        entry.fileSize,
      ],
    );
  }

  deleteFileRegistry(localPath: string): void {
    this.run("DELETE FROM file_registry WHERE local_path = ?", [localPath]);
  }

  // --- preserve markers ---

  storePreserveMarkers(path: string, markers: PreserveMarker[]): void {
    if (markers.length === 0) {
      this.run("DELETE FROM sync_metadata WHERE key = ?", [`preserve_markers:${path}`]);
      return;
    }
    this.setMeta(`preserve_markers:${path}`, JSON.stringify(markers));
  }

  getPreserveMarkers(path: string): PreserveMarker[] {
    const value = this.getMeta(`preserve_markers:${path}`);
    if (!value) return [];
    try {
      return JSON.parse(value) as PreserveMarker[];
    } catch {
      return [];
    }
  }

  // --- transaction ---

  transaction<T>(fn: () => T): T {
    this.db.run("BEGIN");
    try {
      const result = fn();
      this.db.run("COMMIT");
      this.markDirty();
      return result;
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
  }

  // --- private mappers ---

  private mapRow(row: RawSyncRow): SyncRecord {
    return {
      id: row.id,
      obsidianPath: row.obsidian_path,
      notionPageId: row.notion_page_id,
      notionParentId: row.notion_parent_id,
      contentHash: row.content_hash,
      notionLastEdited: row.notion_last_edited,
      localLastModified: row.local_last_modified,
      syncDirection: row.sync_direction as SyncRecord["syncDirection"],
      fileType: row.file_type as SyncRecord["fileType"],
      status: row.status as SyncRecord["status"],
      baseSnapshot: row.base_snapshot ? Buffer.from(row.base_snapshot) : null,
      localMtime: row.local_mtime,
      localFileSize: row.local_file_size,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapWikilinkRow(row: RawWikilinkRow): WikilinkEntry {
    return {
      obsidianPath: row.obsidian_path,
      notionPageId: row.notion_page_id,
      title: row.title,
      aliases: JSON.parse(row.aliases || "[]") as string[],
    };
  }

  private mapFileRegistryRow(row: RawFileRegistryRow): FileRegistryEntry {
    return {
      id: row.id,
      localPath: row.local_path,
      notionPageId: row.notion_page_id,
      fileUploadId: row.file_upload_id,
      fileType: row.file_type,
      fileHash: row.file_hash,
      fileSize: row.file_size,
    };
  }
}
