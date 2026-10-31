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
  /** 닫는다 — 파일에 남은 쓰기를 마쳐야 하는 구현(플러그인의 sql.js)은 그 일을 Promise 로 돌려준다. */
  close(): void | Promise<void>;

  // sync_state
  getByPath(path: string): SyncRecord | null;
  /**
   * 대소문자를 가리지 않고 같은 경로의 기록들 — 받을 이름이 macOS · Windows 에서 다른 노트의 파일과 겹치는지(P9).
   * SQLite 의 `NOCASE` 라 ASCII 만 접는다. 경로는 NFC 로 적혀 있다(`upgradeNfcPaths`).
   */
  getByPathKey(path: string): SyncRecord[];
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
  /** relation 값의 위키링크 — 대상 DB(`parentIds`)의 행 가운데서만 찾는다(`wikilinkLookupsIn`). */
  resolveWikilinkIn(text: string, parentIds: readonly string[]): WikilinkEntry | null;
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
