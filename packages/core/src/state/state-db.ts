import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import type {
  SyncRecord,
  SyncStatus,
  WikilinkEntry,
  PreserveMarker,
  RemoteObservation,
} from "../types/index.js";
import { generateId } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import { STATE_DB_MIGRATIONS } from "./migrations/index.js";
import type { IStateDB } from "./state-db-interface.js";
import { SAVED_STATE_TABLES_QUERY, SavedStateDbError } from "./saved-state-db-error.js";
import { WIKILINK_LOOKUPS, wikilinkLookupsIn } from "./wikilink-lookup.js";
import { StateLock, stateDbLockPath } from "./state-lock.js";

export class StateDB implements IStateDB {
  private readonly db: Database.Database;
  /**
   * 준비한 문장 — SQL 글자마다 한 번만 준비한다. 노트마다 여러 번 부르는 조회(`getByPath` 등)가 부를 때마다 다시
   * 준비하면 5,000 노트 첫 push 에서 준비만 3초였다(P10 실측). 스키마가 바뀌면 SQLite 가 다시 준비한다.
   */
  private readonly statements = new Map<string, Database.Statement>();

  private constructor(
    db: Database.Database,
    private readonly lock: StateLock,
  ) {
    this.db = db;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  private sql(text: string): Database.Statement {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  /**
   * 상태 DB 파일을 연다 — 없으면 새로 만든다. 한 볼트의 상태 DB 는 한 곳만 연다 — 플러그인이나 다른 CLI 가 쓰는
   * 중이면 {@link StateDbLockedError} 를 던진다(ADR-026). 저장된 파일이 비었거나 잘렸으면 빈 DB 로 열지 않고
   * {@link SavedStateDbError} 를 던진다. 예전에는 0 · 1바이트 파일을 빈 DB 로 열고 닫을 때 빈 DB 로 덮었다.
   */
  static open(dbPath: string): StateDB {
    const lock = StateLock.acquire(stateDbLockPath(dbPath), { tool: "cli" });
    try {
      return StateDB.openLocked(dbPath, lock);
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  private static openLocked(dbPath: string, lock: StateLock): StateDB {
    // 파일만 «저장된 상태 DB» 다 — 폴더는 SQLite 가 여는 데서 실패하고 그 까닭을 그대로 던진다. Windows 는 폴더의
    // size 를 0 으로 주어 예전에는 「빈 파일」 로 진단했다.
    const saved = existsSync(dbPath) ? statSync(dbPath) : null;
    const savedBytes = saved?.isFile() ? saved.size : null;
    // 비었으면 열지도 않는다 — SQLite 는 0바이트 파일을 읽을 때 옆 WAL 파일을 지운다.
    if (savedBytes === 0) throw SavedStateDbError.noTables(0);
    const db = new Database(dbPath);
    try {
      // WAL 로 바꾸기 · 마이그레이션이 파일을 쓰기 전에 본다 — 깨진 파일을 빈 DB 로 덮지 않는다.
      if (savedBytes !== null && db.prepare(SAVED_STATE_TABLES_QUERY).get() === undefined) {
        throw SavedStateDbError.noTables(savedBytes);
      }
      const stateDb = new StateDB(db, lock);
      stateDb.migrate();
      if (process.platform === "win32") stateDb.normalizePathSeparators();
      return stateDb;
    } catch (error) {
      db.close();
      if (savedBytes === null || error instanceof SavedStateDbError) throw error;
      throw SavedStateDbError.unreadable(error);
    }
  }

  private migrate(): void {
    const version = this.getSchemaVersion();
    for (const migration of STATE_DB_MIGRATIONS) {
      if (version < migration.version) this.db.exec(migration.sql);
    }
  }

  /**
   * `\` 로 이은 경로를 `/` 로 고쳐 적는다 — Windows 에서만 부른다(이슈 #8). 0.9.1 까지의 CLI 는 Windows 에서
   * 볼트 경로를 `relative()` 그대로(`00 Me\a.md`) 적었다. 이제 목록은 `/` 로 이으므로 그대로 두면 그
   * 노트들이 「볼트에서 지움」 과 「새 노트」 로 보인다.
   *
   * 같은 노트가 이미 `/` 경로로도 추적되고 있으면(pull 이 `/` 로 적은 노트를 `\` 목록이 새 노트로 보고 또
   * 올렸다) `\` 쪽 기록을 버린다 — 그 기록의 Notion 페이지는 그때 생긴 사본이다. 지우지 않고 추적만 놓는다.
   * Linux · macOS 에서는 `\` 가 파일 이름의 글자일 수 있어 부르지 않는다.
   *
   * @returns 고쳐 적은 경로 수와 버린 사본 기록 수
   */
  normalizePathSeparators(): { readonly renamed: number; readonly dropped: number } {
    let renamed = 0;
    let dropped = 0;
    const fix = (path: string) => path.replace(/\\/g, "/");
    this.db.transaction(() => {
      const unique = (table: string, column: string, key: string) => {
        const rows = this.sql(
          `SELECT ${key} AS k, ${column} AS p FROM ${table} WHERE instr(${column}, '\\') > 0`,
        ).all() as Array<{ k: string; p: string }>;
        for (const row of rows) {
          const taken = this.sql(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(fix(row.p));
          if (taken) {
            this.sql(`DELETE FROM ${table} WHERE ${key} = ?`).run(row.k);
            if (table === "sync_state") dropped++;
          } else {
            this.sql(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(fix(row.p), row.k);
            if (table === "sync_state") renamed++;
          }
        }
      };
      unique("sync_state", "obsidian_path", "id");
      unique("wikilink_map", "obsidian_path", "obsidian_path");
      unique("file_registry", "local_path", "id");
      this.sql("UPDATE image_registry SET local_path = replace(local_path, '\\', '/')").run();
      const markers = this.sql(
        "SELECT key FROM sync_metadata WHERE key LIKE 'preserve_markers:%' AND instr(key, '\\') > 0",
      ).all() as Array<{ key: string }>;
      for (const { key } of markers) {
        const taken = this.sql("SELECT 1 FROM sync_metadata WHERE key = ?").get(fix(key));
        if (taken) this.sql("DELETE FROM sync_metadata WHERE key = ?").run(key);
        else this.sql("UPDATE sync_metadata SET key = ? WHERE key = ?").run(fix(key), key);
      }
    })();
    if (renamed + dropped > 0) {
      getLogger().warn(
        `[Im-Nobsidian] Windows 경로 ${renamed}개를 / 로 고쳐 적음` +
          (dropped > 0
            ? ` · 같은 노트를 또 올린 사본 기록 ${dropped}개는 추적을 놓음(Notion 페이지는 남음)`
            : ""),
      );
    }
    return { renamed, dropped };
  }

  private getSchemaVersion(): number {
    try {
      const row = this.sql("SELECT value FROM sync_metadata WHERE key = 'schema_version'").get() as
        { value: string } | undefined;
      return row ? Number(row.value) : 0;
    } catch {
      return 0;
    }
  }

  /** 닫고 잠금을 푼다 — 닫는 사이 다른 곳이 열지 않게 닫은 뒤에 푼다. */
  close(): void {
    try {
      this.db.close();
    } finally {
      this.lock.release();
    }
  }

  // --- sync_state ---

  getByPath(path: string): SyncRecord | null {
    const row = this.sql("SELECT * FROM sync_state WHERE obsidian_path = ?").get(path) as
      RawSyncRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  getByPathKey(path: string): SyncRecord[] {
    const rows = this.sql("SELECT * FROM sync_state WHERE obsidian_path = ? COLLATE NOCASE").all(
      path,
    ) as RawSyncRow[];
    return rows.map((r) => this.mapRow(r));
  }

  getByNotionId(pageId: string): SyncRecord | null {
    const row = this.sql("SELECT * FROM sync_state WHERE notion_page_id = ?").get(pageId) as
      RawSyncRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  getByStatus(status: SyncStatus): SyncRecord[] {
    const rows = this.sql("SELECT * FROM sync_state WHERE status = ?").all(status) as RawSyncRow[];
    return rows.map((r) => this.mapRow(r));
  }

  getAll(): SyncRecord[] {
    const rows = this.sql("SELECT * FROM sync_state").all() as RawSyncRow[];
    return rows.map((r) => this.mapRow(r));
  }

  upsert(record: UpsertSyncRecord): SyncRecord {
    const existing = this.getByPath(record.obsidianPath);

    if (existing) {
      this.sql(
        `UPDATE sync_state SET
            notion_page_id = ?, notion_parent_id = ?, content_hash = ?,
            notion_last_edited = ?, notion_last_edited_by = ?, notion_seen_at = ?,
            notion_body_fingerprint = ?, local_last_modified = ?,
            sync_direction = ?, file_type = ?, status = ?,
            base_snapshot = ?, local_mtime = ?, local_file_size = ?,
            version = version + 1, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(
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
      );
      return this.getByPath(record.obsidianPath)!;
    }

    const id = generateId();
    this.sql(
      `INSERT INTO sync_state
          (id, obsidian_path, notion_page_id, notion_parent_id, content_hash,
           notion_last_edited, notion_last_edited_by, notion_seen_at, notion_body_fingerprint,
           local_last_modified, sync_direction, file_type,
           status, base_snapshot, local_mtime, local_file_size, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
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
    );
    return this.getByPath(record.obsidianPath)!;
  }

  updateStatus(id: string, status: SyncStatus): void {
    this.sql("UPDATE sync_state SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      status,
      id,
    );
  }

  updateHash(id: string, hash: string, snapshot?: Buffer | null): void {
    if (snapshot !== undefined) {
      this.sql(
        "UPDATE sync_state SET content_hash = ?, base_snapshot = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(hash, snapshot, id);
    } else {
      this.sql(
        "UPDATE sync_state SET content_hash = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(hash, id);
    }
  }

  setRemoteObservation(id: string, observation: RemoteObservation): void {
    const { lastEdited, lastEditedBy, seenAt, bodyFingerprint } = observation;
    if (bodyFingerprint === undefined) {
      this.sql(
        `UPDATE sync_state SET notion_last_edited = ?, notion_last_edited_by = ?,
            notion_seen_at = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(lastEdited, lastEditedBy, seenAt, id);
    } else {
      this.sql(
        `UPDATE sync_state SET notion_last_edited = ?, notion_last_edited_by = ?,
            notion_seen_at = ?, notion_body_fingerprint = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(lastEdited, lastEditedBy, seenAt, bodyFingerprint, id);
    }
  }

  setNotionBodyFingerprint(id: string, fingerprint: string | null): void {
    this.sql(
      "UPDATE sync_state SET notion_body_fingerprint = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(fingerprint, id);
  }

  updateStatCache(id: string, mtime: string, fileSize: number): void {
    this.sql(
      "UPDATE sync_state SET local_mtime = ?, local_file_size = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(mtime, fileSize, id);
  }

  setNotionParentId(id: string, parentId: string): void {
    this.sql(
      "UPDATE sync_state SET notion_parent_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(parentId, id);
  }

  updatePath(id: string, newPath: string): void {
    this.sql(
      "UPDATE sync_state SET obsidian_path = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(newPath, id);
  }

  delete(id: string): void {
    this.sql("DELETE FROM sync_state WHERE id = ?").run(id);
  }

  // --- wikilink_map ---

  resolveWikilink(text: string): WikilinkEntry | null {
    for (const lookup of WIKILINK_LOOKUPS) {
      const row = this.sql(lookup.sql).get(...lookup.params(text)) as RawWikilinkRow | undefined;
      if (row) return this.mapWikilinkRow(row);
    }
    return null;
  }

  resolveWikilinkIn(text: string, parentIds: readonly string[]): WikilinkEntry | null {
    if (parentIds.length === 0) return null;
    for (const lookup of wikilinkLookupsIn(parentIds)) {
      const row = this.sql(lookup.sql).get(...lookup.params(text)) as RawWikilinkRow | undefined;
      if (row) return this.mapWikilinkRow(row);
    }
    return null;
  }

  resolvePageId(pageId: string): WikilinkEntry | null {
    const row = this.sql("SELECT * FROM wikilink_map WHERE notion_page_id = ?").get(pageId) as
      RawWikilinkRow | undefined;
    return row ? this.mapWikilinkRow(row) : null;
  }

  upsertWikilink(entry: WikilinkEntry): void {
    this.sql(
      `INSERT OR REPLACE INTO wikilink_map (obsidian_path, notion_page_id, title, aliases, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(entry.obsidianPath, entry.notionPageId, entry.title, JSON.stringify(entry.aliases));
  }

  deleteWikilink(obsidianPath: string): void {
    this.sql("DELETE FROM wikilink_map WHERE obsidian_path = ?").run(obsidianPath);
  }

  // --- sync_metadata ---

  getMeta(key: string): string | null {
    const row = this.sql("SELECT value FROM sync_metadata WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)").run(key, value);
  }

  // --- file_registry ---

  isFileRegistered(localPath: string): boolean {
    const row = this.sql("SELECT 1 FROM file_registry WHERE local_path = ?").get(localPath);
    return !!row;
  }

  getFileRegistry(localPath: string): FileRegistryEntry | null {
    const row = this.sql("SELECT * FROM file_registry WHERE local_path = ?").get(localPath) as
      RawFileRegistryRow | undefined;
    return row ? this.mapFileRegistryRow(row) : null;
  }

  getFilesByPageId(notionPageId: string): FileRegistryEntry[] {
    const rows = this.sql("SELECT * FROM file_registry WHERE notion_page_id = ?").all(
      notionPageId,
    ) as RawFileRegistryRow[];
    return rows.map((r) => this.mapFileRegistryRow(r));
  }

  registerFile(entry: RegisterFileInput): void {
    const id = generateId();
    this.sql(
      `INSERT OR REPLACE INTO file_registry
          (id, local_path, notion_page_id, file_upload_id, file_type, file_hash, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      entry.localPath,
      entry.notionPageId,
      entry.fileUploadId,
      entry.fileType,
      entry.fileHash,
      entry.fileSize,
    );
  }

  deleteFileRegistry(localPath: string): void {
    this.sql("DELETE FROM file_registry WHERE local_path = ?").run(localPath);
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

  // --- pending_operations (I12 크래시 복구 WAL) ---

  recordPendingOperation(input: RecordPendingInput): string {
    const id = generateId();
    this.sql(
      `INSERT INTO pending_operations
          (id, sync_state_id, operation, direction, payload, status)
        VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).run(id, input.syncStateId, input.operation, input.direction, input.payload ?? null);
    return id;
  }

  getIncompletePendingOperations(): PendingOperation[] {
    const rows = this.sql(
      "SELECT * FROM pending_operations WHERE status IN ('pending', 'processing') ORDER BY created_at ASC",
    ).all() as RawPendingRow[];
    return rows.map((r) => this.mapPendingRow(r));
  }

  getIncompleteOpByState(
    syncStateId: string,
    operation: PendingOperation["operation"],
  ): PendingOperation | null {
    const row = this.sql(
      `SELECT * FROM pending_operations
         WHERE sync_state_id = ? AND operation = ? AND status IN ('pending', 'processing')
         ORDER BY created_at ASC LIMIT 1`,
    ).get(syncStateId, operation) as RawPendingRow | undefined;
    return row ? this.mapPendingRow(row) : null;
  }

  markPendingCompleted(id: string): void {
    this.sql(
      "UPDATE pending_operations SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
    ).run(id);
  }

  markPendingFailed(id: string, errorMessage: string): void {
    this.sql(
      "UPDATE pending_operations SET status = 'failed', retry_count = retry_count + 1, error_message = ?, completed_at = datetime('now') WHERE id = ?",
    ).run(errorMessage, id);
  }

  clearCompletedOperations(): void {
    this.sql("DELETE FROM pending_operations WHERE status IN ('completed', 'failed')").run();
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

  // --- preserve markers ---

  storePreserveMarkers(path: string, markers: PreserveMarker[]): void {
    if (markers.length === 0) {
      this.sql("DELETE FROM sync_metadata WHERE key = ?").run(`preserve_markers:${path}`);
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
    return this.db.transaction(fn)();
  }

  // --- private ---

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
      baseSnapshot: row.base_snapshot,
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
}

export interface UpsertSyncRecord {
  readonly obsidianPath: string;
  readonly notionPageId?: string | null;
  readonly notionParentId?: string | null;
  readonly contentHash: string;
  readonly notionLastEdited?: string | null;
  readonly notionLastEditedBy?: string | null;
  readonly notionSeenAt?: string | null;
  readonly notionBodyFingerprint?: string | null;
  readonly localLastModified: string;
  readonly syncDirection: SyncRecord["syncDirection"];
  readonly fileType: SyncRecord["fileType"];
  readonly status: SyncRecord["status"];
  readonly baseSnapshot?: Buffer | null;
  readonly localMtime?: string | null;
  readonly localFileSize?: number | null;
}

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
  base_snapshot: Buffer | null;
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
  updated_at: string;
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

export interface FileRegistryEntry {
  readonly id: string;
  readonly localPath: string;
  readonly notionPageId: string;
  readonly fileUploadId: string;
  readonly fileType: string;
  readonly fileHash: string;
  readonly fileSize: number;
}

export interface RegisterFileInput {
  readonly localPath: string;
  readonly notionPageId: string;
  readonly fileUploadId: string;
  readonly fileType: string;
  readonly fileHash: string;
  readonly fileSize: number;
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

/** I12 크래시 복구 WAL 항목. push/pull 적용 전 기록되고, 적용 완료 시 completed 로 마감된다. */
export interface PendingOperation {
  readonly id: string;
  readonly syncStateId: string;
  readonly operation: "create" | "update" | "delete" | "move";
  readonly direction: "push" | "pull";
  readonly payload: string | null;
  readonly retryCount: number;
  readonly errorMessage: string | null;
  readonly status: "pending" | "processing" | "completed" | "failed";
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface RecordPendingInput {
  readonly syncStateId: string;
  readonly operation: PendingOperation["operation"];
  readonly direction: PendingOperation["direction"];
  readonly payload?: string | null;
}
