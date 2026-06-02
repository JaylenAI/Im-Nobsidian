import type { SyncRecord, SyncStatus, WikilinkEntry, PreserveMarker } from "../types/index.js";
import type {
  UpsertSyncRecord,
  FileRegistryEntry,
  RegisterFileInput,
  PendingOperation,
  RecordPendingInput,
} from "./state-db.js";

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
  /** 레코드 삭제 시 해당 경로의 wikilink 항목을 제거한다 (stale 링크 방지). */
  deleteWikilink(obsidianPath: string): void;

  // sync_metadata
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // file_registry
  isFileRegistered(localPath: string): boolean;
  getFileRegistry(localPath: string): FileRegistryEntry | null;
  getFilesByPageId(notionPageId: string): FileRegistryEntry[];
  registerFile(entry: RegisterFileInput): void;
  deleteFileRegistry(localPath: string): void;

  // pending_operations (I12 크래시 복구 WAL)
  recordPendingOperation(input: RecordPendingInput): string;
  getIncompletePendingOperations(): PendingOperation[];
  getIncompleteOpByState(
    syncStateId: string,
    operation: PendingOperation["operation"],
  ): PendingOperation | null;
  markPendingCompleted(id: string): void;
  markPendingFailed(id: string, errorMessage: string): void;
  clearCompletedOperations(): void;

  // preserve markers
  storePreserveMarkers(path: string, markers: PreserveMarker[]): void;
  getPreserveMarkers(path: string): PreserveMarker[];

  // transaction
  transaction<T>(fn: () => T): T;
}
