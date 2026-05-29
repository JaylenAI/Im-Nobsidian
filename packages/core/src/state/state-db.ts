import Database from "better-sqlite3";
import type { SyncRecord, SyncStatus, WikilinkEntry, PreserveMarker } from "../types/index.js";
import { generateId } from "../utils/id.js";
import { INITIAL_MIGRATION } from "./migrations/001-initial.js";
import { FILE_REGISTRY_MIGRATION } from "./migrations/002-file-registry.js";
import { STAT_CACHE_MIGRATION } from "./migrations/003-stat-cache.js";
import type { IStateDB } from "./state-db-interface.js";

export class StateDB implements IStateDB {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  static open(dbPath: string): StateDB {
    const db = new Database(dbPath);
    const stateDb = new StateDB(db);
    stateDb.migrate();
    return stateDb;
  }

  private migrate(): void {
    const version = this.getSchemaVersion();
    if (version < 1) {
      this.db.exec(INITIAL_MIGRATION);
    }
    if (version < 2) {
      this.db.exec(FILE_REGISTRY_MIGRATION);
    }
    if (version < 3) {
      this.db.exec(STAT_CACHE_MIGRATION);
    }
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM sync_metadata WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return row ? Number(row.value) : 0;
    } catch {
      return 0;
    }
  }

  close(): void {
    this.db.close();
  }

  // --- sync_state ---

  getByPath(path: string): SyncRecord | null {
    const row = this.db.prepare("SELECT * FROM sync_state WHERE obsidian_path = ?").get(path) as
      | RawSyncRow
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  getByNotionId(pageId: string): SyncRecord | null {
    const row = this.db.prepare("SELECT * FROM sync_state WHERE notion_page_id = ?").get(pageId) as
      | RawSyncRow
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  getByStatus(status: SyncStatus): SyncRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sync_state WHERE status = ?")
      .all(status) as RawSyncRow[];
    return rows.map((r) => this.mapRow(r));
  }

  getAll(): SyncRecord[] {
    const rows = this.db.prepare("SELECT * FROM sync_state").all() as RawSyncRow[];
    return rows.map((r) => this.mapRow(r));
  }

  upsert(record: UpsertSyncRecord): SyncRecord {
    const existing = this.getByPath(record.obsidianPath);

    if (existing) {
      this.db
        .prepare(
          `UPDATE sync_state SET
            notion_page_id = ?, notion_parent_id = ?, content_hash = ?,
            notion_last_edited = ?, local_last_modified = ?,
            sync_direction = ?, file_type = ?, status = ?,
            base_snapshot = ?, local_mtime = ?, local_file_size = ?,
            version = version + 1, updated_at = datetime('now')
          WHERE id = ?`,
        )
        .run(
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
        );
      return this.getByPath(record.obsidianPath)!;
    }

    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO sync_state
          (id, obsidian_path, notion_page_id, notion_parent_id, content_hash,
           notion_last_edited, local_last_modified, sync_direction, file_type,
           status, base_snapshot, local_mtime, local_file_size, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
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
      );
    return this.getByPath(record.obsidianPath)!;
  }

  updateStatus(id: string, status: SyncStatus): void {
    this.db
      .prepare("UPDATE sync_state SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }

  updateHash(id: string, hash: string, snapshot?: Buffer | null): void {
    if (snapshot !== undefined) {
      this.db
        .prepare(
          "UPDATE sync_state SET content_hash = ?, base_snapshot = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(hash, snapshot, id);
    } else {
      this.db
        .prepare(
          "UPDATE sync_state SET content_hash = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(hash, id);
    }
  }

  setNotionLastEdited(id: string, lastEdited: string): void {
    this.db
      .prepare(
        "UPDATE sync_state SET notion_last_edited = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(lastEdited, id);
  }

  updateStatCache(id: string, mtime: string, fileSize: number): void {
    this.db
      .prepare(
        "UPDATE sync_state SET local_mtime = ?, local_file_size = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(mtime, fileSize, id);
  }

  setNotionParentId(id: string, parentId: string): void {
    this.db
      .prepare(
        "UPDATE sync_state SET notion_parent_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(parentId, id);
  }

  updatePath(id: string, newPath: string): void {
    this.db
      .prepare("UPDATE sync_state SET obsidian_path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newPath, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM sync_state WHERE id = ?").run(id);
  }

  // --- wikilink_map ---

  resolveWikilink(text: string): WikilinkEntry | null {
    const byTitle = this.db.prepare("SELECT * FROM wikilink_map WHERE title = ?").get(text) as
      | RawWikilinkRow
      | undefined;

    if (byTitle) return this.mapWikilinkRow(byTitle);

    const byAlias = this.db
      .prepare("SELECT * FROM wikilink_map WHERE aliases LIKE ?")
      .get(`%"${text}"%`) as RawWikilinkRow | undefined;

    if (byAlias) return this.mapWikilinkRow(byAlias);

    const byFilename = this.db
      .prepare("SELECT * FROM wikilink_map WHERE obsidian_path LIKE ?")
      .get(`%/${text}.md`) as RawWikilinkRow | undefined;

    return byFilename ? this.mapWikilinkRow(byFilename) : null;
  }

  resolvePageId(pageId: string): WikilinkEntry | null {
    const row = this.db
      .prepare("SELECT * FROM wikilink_map WHERE notion_page_id = ?")
      .get(pageId) as RawWikilinkRow | undefined;
    return row ? this.mapWikilinkRow(row) : null;
  }

  upsertWikilink(entry: WikilinkEntry): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO wikilink_map (obsidian_path, notion_page_id, title, aliases, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run(entry.obsidianPath, entry.notionPageId, entry.title, JSON.stringify(entry.aliases));
  }

  deleteWikilink(obsidianPath: string): void {
    this.db.prepare("DELETE FROM wikilink_map WHERE obsidian_path = ?").run(obsidianPath);
  }

  // --- sync_metadata ---

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM sync_metadata WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  // --- file_registry ---

  isFileRegistered(localPath: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM file_registry WHERE local_path = ?").get(localPath);
    return !!row;
  }

  getFileRegistry(localPath: string): FileRegistryEntry | null {
    const row = this.db
      .prepare("SELECT * FROM file_registry WHERE local_path = ?")
      .get(localPath) as RawFileRegistryRow | undefined;
    return row ? this.mapFileRegistryRow(row) : null;
  }

  getFilesByPageId(notionPageId: string): FileRegistryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM file_registry WHERE notion_page_id = ?")
      .all(notionPageId) as RawFileRegistryRow[];
    return rows.map((r) => this.mapFileRegistryRow(r));
  }

  registerFile(entry: RegisterFileInput): void {
    const id = generateId();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO file_registry
          (id, local_path, notion_page_id, file_upload_id, file_type, file_hash, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    this.db.prepare("DELETE FROM file_registry WHERE local_path = ?").run(localPath);
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

  // --- preserve markers ---

  storePreserveMarkers(path: string, markers: PreserveMarker[]): void {
    if (markers.length === 0) {
      this.db.prepare("DELETE FROM sync_metadata WHERE key = ?").run(`preserve_markers:${path}`);
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
