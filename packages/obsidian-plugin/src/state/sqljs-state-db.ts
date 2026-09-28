import type { Database as SqlJsDatabase } from "sql.js";
import initSqlJs from "sql.js";
import type {
  IStateDB,
  UpsertSyncRecord,
  FileRegistryEntry,
  RegisterFileInput,
  PendingOperation,
  RecordPendingInput,
} from "@im-nobsidian/core";
import type {
  SyncRecord,
  SyncStatus,
  WikilinkEntry,
  PreserveMarker,
  RemoteObservation,
} from "@im-nobsidian/core";
import { generateId, getLogger } from "@im-nobsidian/core";

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

// core 의 004-remote-observation 과 같다 — 앞선 버전이 적은 레코드는 지금 본 것으로 적는다(ADR-017).
const REMOTE_OBSERVATION_MIGRATION = `
ALTER TABLE sync_state ADD COLUMN notion_last_edited_by TEXT;
ALTER TABLE sync_state ADD COLUMN notion_seen_at TEXT;
ALTER TABLE sync_state ADD COLUMN notion_body_fingerprint TEXT;

UPDATE sync_state SET notion_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE notion_last_edited IS NOT NULL;

UPDATE sync_metadata SET value = '4' WHERE key = 'schema_version';
`;

interface RawSyncRow {
  id: string;
  obsidian_path: string;
  notion_page_id: string | null;
  notion_parent_id: string | null;
  content_hash: string;
  notion_last_edited: string | null;
  notion_last_edited_by: string | null;
  notion_seen_at: string | null;
  notion_body_fingerprint: string | null;
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

interface RawPendingRow {
  id: string;
  sync_state_id: string;
  operation: string;
  direction: string;
  payload: string | null;
  retry_count: number;
  error_message: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

/**
 * 저장된 상태 DB 파일로 DB 를 열지 못했다 — 비었거나 잘렸거나 상태 DB 가 아닌 파일이다. 엔진(wasm)을 띄우지 못한
 * 것 같은 다른 실패와 가른다 — 파일을 치우라는 안내는 이 경우에만 맞다.
 */
export class SavedStateDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedStateDbError";
  }
}

export class SqlJsStateDB implements IStateDB {
  private db: SqlJsDatabase;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushFn: ((data: Uint8Array) => Promise<void>) | null;
  /** 파일 쓰기를 한 줄로 세운다 — 늦게 끝난 옛 사본이 새 사본을 덮지 않게 한다. */
  private writes: Promise<void> = Promise.resolve();

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
    const stateDb = new SqlJsStateDB(db, flushFn);
    try {
      if (existingData) stateDb.checkSavedTables(existingData.length);
      db.run("PRAGMA foreign_keys = ON");
      stateDb.migrate();
    } catch (error) {
      db.close();
      if (!existingData || error instanceof SavedStateDbError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new SavedStateDbError(`저장된 상태 DB 파일을 열지 못함 (${message})`);
    }
    return stateDb;
  }

  /**
   * 저장된 파일에 동기화 기록 표가 있는지 본다 — 한 번이라도 쓴 파일에는 마이그레이션이 만든 표가 있다. SQLite 는
   * 비었거나(0바이트) 앞 한 바이트만 남은 파일을 «빈 DB» 로 연다. 보지 않으면 기록을 잃은 채 처음부터 시작하고,
   * 다음 push 가 모든 노트의 페이지를 또 만든다. 한 페이지 이상 잘린 파일은 SQLite 가 이 조회에서 던진다(malformed).
   */
  private checkSavedTables(bytes: number): void {
    const found = this.db.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_metadata'",
    );
    if (found.length === 0) {
      throw new SavedStateDbError(`저장된 상태 DB 파일에 동기화 기록이 없음 (${bytes}바이트)`);
    }
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
    if (version < 4) {
      for (const line of REMOTE_OBSERVATION_MIGRATION.split(";")) {
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
      // 못 쓴 것은 «바뀜» 으로 남아 다음 쓰기(다음 변경 · 닫기)가 다시 쓴다.
      this.flush().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        getLogger().warn(`[Im-Nobsidian] 상태 DB 를 파일에 쓰지 못함: ${message}`);
      });
    }, 5000);
  }

  /**
   * 바뀐 것이 있으면 DB 를 파일에 쓴다. 쓰기는 한 줄로 서서, 앞 쓰기가 끝난 뒤에 그때의 DB 를 내보낸다.
   *
   * «바뀜» 은 내보낼 때 내린다 — 쓰는 동안 바뀐 것은 다시 «바뀜» 이 되어 다음 쓰기가 담는다. 예전에는 쓰기가
   * 끝난 뒤에 내려, 쓰는 사이에 바뀐 것이 파일에 가지 않았고 설정을 바꾸거나 플러그인을 다시 불러오면
   * 사라졌다. 못 쓰면 «바뀜» 을 되살리고 이유를 던진다.
   */
  flush(): Promise<void> {
    const write = this.writes.then(() => this.writeIfDirty());
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async writeIfDirty(): Promise<void> {
    if (!this.dirty || !this.flushFn) return;
    const data = this.db.export();
    this.dirty = false;
    try {
      await this.flushFn(data);
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  export(): Uint8Array {
    return this.db.export();
  }

  /**
   * 남은 쓰기를 마치고 닫는다 — 닫은 뒤 같은 파일을 다시 여는 쪽(설정을 바꾼 플러그인 · 다시 불러온
   * 플러그인)이 마지막 기록을 읽는다. 예전에는 쓰기를 기다리지 않고 닫았다. 못 쓰면 닫지 않고 이유를
   * 던진다 — 닫으면 그 기록은 어디에도 남지 않는다.
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
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
          notion_last_edited = ?, notion_last_edited_by = ?, notion_seen_at = ?,
          notion_body_fingerprint = ?, local_last_modified = ?,
          sync_direction = ?, file_type = ?, status = ?,
          base_snapshot = ?, local_mtime = ?, local_file_size = ?,
          version = version + 1, updated_at = datetime('now')
        WHERE id = ?`,
        [
          record.notionPageId ?? null,
          record.notionParentId ?? null,
          record.contentHash,
          record.notionLastEdited ?? null,
          record.notionLastEditedBy ?? null,
          record.notionSeenAt ?? null,
          record.notionBodyFingerprint ?? null,
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
         notion_last_edited, notion_last_edited_by, notion_seen_at, notion_body_fingerprint,
         local_last_modified, sync_direction, file_type,
         status, base_snapshot, local_mtime, local_file_size, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        record.obsidianPath,
        record.notionPageId ?? null,
        record.notionParentId ?? null,
        record.contentHash,
        record.notionLastEdited ?? null,
        record.notionLastEditedBy ?? null,
        record.notionSeenAt ?? null,
        record.notionBodyFingerprint ?? null,
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

  setRemoteObservation(id: string, observation: RemoteObservation): void {
    const { lastEdited, lastEditedBy, seenAt, bodyFingerprint } = observation;
    if (bodyFingerprint === undefined) {
      this.run(
        `UPDATE sync_state SET notion_last_edited = ?, notion_last_edited_by = ?,
          notion_seen_at = ?, updated_at = datetime('now') WHERE id = ?`,
        [lastEdited, lastEditedBy, seenAt, id],
      );
    } else {
      this.run(
        `UPDATE sync_state SET notion_last_edited = ?, notion_last_edited_by = ?,
          notion_seen_at = ?, notion_body_fingerprint = ?, updated_at = datetime('now')
        WHERE id = ?`,
        [lastEdited, lastEditedBy, seenAt, bodyFingerprint, id],
      );
    }
  }

  setNotionBodyFingerprint(id: string, fingerprint: string | null): void {
    this.run(
      "UPDATE sync_state SET notion_body_fingerprint = ?, updated_at = datetime('now') WHERE id = ?",
      [fingerprint, id],
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

  // --- pending_operations (I12 크래시 복구 WAL) ---

  recordPendingOperation(input: RecordPendingInput): string {
    const id = generateId();
    this.run(
      `INSERT INTO pending_operations
        (id, sync_state_id, operation, direction, payload, status)
      VALUES (?, ?, ?, ?, ?, 'pending')`,
      [id, input.syncStateId, input.operation, input.direction, input.payload ?? null],
    );
    return id;
  }

  getIncompletePendingOperations(): PendingOperation[] {
    return this.queryAll<RawPendingRow>(
      "SELECT * FROM pending_operations WHERE status IN ('pending', 'processing') ORDER BY created_at ASC",
    ).map((r) => this.mapPendingRow(r));
  }

  getIncompleteOpByState(
    syncStateId: string,
    operation: PendingOperation["operation"],
  ): PendingOperation | null {
    const row = this.queryOne<RawPendingRow>(
      `SELECT * FROM pending_operations
       WHERE sync_state_id = ? AND operation = ? AND status IN ('pending', 'processing')
       ORDER BY created_at ASC LIMIT 1`,
      [syncStateId, operation],
    );
    return row ? this.mapPendingRow(row) : null;
  }

  markPendingCompleted(id: string): void {
    this.run(
      "UPDATE pending_operations SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  markPendingFailed(id: string, errorMessage: string): void {
    this.run(
      "UPDATE pending_operations SET status = 'failed', retry_count = retry_count + 1, error_message = ?, completed_at = datetime('now') WHERE id = ?",
      [errorMessage, id],
    );
  }

  clearCompletedOperations(): void {
    this.run("DELETE FROM pending_operations WHERE status IN ('completed', 'failed')");
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
      notionLastEditedBy: row.notion_last_edited_by,
      notionSeenAt: row.notion_seen_at,
      notionBodyFingerprint: row.notion_body_fingerprint,
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

  private mapPendingRow(row: RawPendingRow): PendingOperation {
    return {
      id: row.id,
      syncStateId: row.sync_state_id,
      operation: row.operation as PendingOperation["operation"],
      direction: row.direction as PendingOperation["direction"],
      payload: row.payload,
      retryCount: row.retry_count,
      errorMessage: row.error_message,
      status: row.status as PendingOperation["status"],
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
