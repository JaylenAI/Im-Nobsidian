export type SyncDirection = "push" | "pull" | "both";
export type FileType = "file" | "folder-note" | "folder-only" | "db-row";
export type SyncStatus = "synced" | "pending" | "conflict" | "error";
export type OperationType = "create" | "update" | "delete" | "move";
export type ConflictStrategy = "local-first" | "remote-first" | "manual" | "duplicate";

export interface SyncRecord {
  readonly id: string;
  readonly obsidianPath: string;
  readonly notionPageId: string | null;
  readonly notionParentId: string | null;
  readonly contentHash: string;
  readonly notionLastEdited: string | null;
  readonly localLastModified: string;
  readonly syncDirection: SyncDirection;
  readonly fileType: FileType;
  readonly status: SyncStatus;
  readonly baseSnapshot: Buffer | null;
  readonly localMtime: string | null;
  readonly localFileSize: number | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalChange {
  readonly path: string;
  readonly type: "created" | "modified" | "deleted" | "moved";
  readonly currentHash: string;
  readonly previousHash: string | null;
  readonly movedFrom?: string;
}

export interface RemoteChange {
  readonly pageId: string;
  readonly type: "created" | "modified" | "deleted" | "moved";
  readonly lastEdited: string;
  readonly previousEdited: string | null;
  readonly movedFromParent?: string;
}

export interface Conflict {
  readonly syncRecord: SyncRecord;
  readonly localChange: LocalChange;
  readonly remoteChange: RemoteChange;
  readonly baseContent: string | null;
  readonly localContent: string;
  readonly remoteContent: string;
}

export interface ProgressItem {
  readonly path: string;
  readonly operation: "create" | "update" | "delete";
}

export type ProgressCallback = (current: number, total: number, item: ProgressItem) => void;

/** push/pull/sync 가 공통으로 받는 동기화 옵션. */
export interface BaseSyncOptions {
  readonly paths?: string[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly onProgress?: ProgressCallback;
  readonly signal?: AbortSignal;
}

export interface PushOptions extends BaseSyncOptions {
  readonly excludePaths?: string[];
}

export type PullOptions = BaseSyncOptions;

export type SyncOptions = BaseSyncOptions;

export interface PushResult {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly failed: FailedOperation[];
  readonly duration: number;
}

export interface PullResult {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  /**
   * 로컬에서 사라졌다가 리모트 원본으로 되살린 파일 수.
   * updated 와 분리해 보고한다 — "수정 N건" 에 섞이면 사용자는 자기 볼트에서
   * 파일이 없어졌다가 복구됐다는 사실 자체를 알 수 없다.
   */
  readonly restored: number;
  readonly conflicts: Conflict[];
  readonly writtenPaths: string[];
  readonly failed: FailedOperation[];
  readonly duration: number;
  readonly imageCount: number;
  readonly fileCount: number;
  readonly linkCount: number;
}

export interface SyncResult {
  readonly push: PushResult;
  readonly pull: PullResult;
  readonly conflicts: Conflict[];
  readonly duration: number;
}

export interface StatusResult {
  readonly localChanges: LocalChange[];
  readonly remoteChanges: RemoteChange[];
  readonly conflicts: Conflict[];
  readonly conflictRecords: SyncRecord[];
  readonly pendingOperations: number;
  readonly lastSyncAt: string | null;
}

export interface FailedOperation {
  readonly path: string;
  readonly operation: OperationType;
  readonly error: string;
}
