import type {
  SyncRecord,
  SyncStatus,
  WikilinkEntry,
  PreserveMarker,
  RemoteObservation,
} from "../types/index.js";
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
  /** 원격을 본 기록을 적는다(N-05). 지문을 적지 않으면 있던 지문을 둔다. */
  setRemoteObservation(id: string, observation: RemoteObservation): void;
  /** 원격 본문 지문만 바꾼다 — 본문을 보냈지만 수정 시각은 올리지 않을 때. */
  setNotionBodyFingerprint(id: string, fingerprint: string | null): void;
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
