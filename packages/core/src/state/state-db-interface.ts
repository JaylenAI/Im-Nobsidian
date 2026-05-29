import type { SyncRecord, SyncStatus, WikilinkEntry, PreserveMarker } from "../types/index.js";
import type { UpsertSyncRecord, FileRegistryEntry, RegisterFileInput } from "./state-db.js";

export interface IStateDB {
  close(): void;

  // sync_state
  getByPath(path: string): SyncRecord | null;
  getByNotionId(pageId: string): SyncRecord | null;
  getByStatus(status: SyncStatus): SyncRecord[];
  getAll(): SyncRecord[];
  upsert(record: UpsertSyncRecord): SyncRecord;
  updateStatus(id: string, status: SyncStatus): void;
  updateHash(id: string, hash: string, snapshot?: Buffer | Uint8Array | null): void;
  setNotionLastEdited(id: string, lastEdited: string): void;
  updateStatCache(id: string, mtime: string, fileSize: number): void;
  setNotionParentId(id: string, parentId: string): void;
  /** 레코드의 로컬 경로를 갱신한다 (파일 rename/move 추적용). */
  updatePath(id: string, newPath: string): void;
  delete(id: string): void;

  // wikilink_map
  resolveWikilink(text: string): WikilinkEntry | null;
  resolvePageId(pageId: string): WikilinkEntry | null;
  upsertWikilink(entry: WikilinkEntry): void;

  // sync_metadata
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // file_registry
  isFileRegistered(localPath: string): boolean;
  getFileRegistry(localPath: string): FileRegistryEntry | null;
  getFilesByPageId(notionPageId: string): FileRegistryEntry[];
  registerFile(entry: RegisterFileInput): void;
  deleteFileRegistry(localPath: string): void;

  // preserve markers
  storePreserveMarkers(path: string, markers: PreserveMarker[]): void;
  getPreserveMarkers(path: string): PreserveMarker[];

  // transaction
  transaction<T>(fn: () => T): T;
}
