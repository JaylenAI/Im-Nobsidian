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

export interface PushOptions {
  readonly paths?: string[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface PullOptions {
  readonly paths?: string[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface SyncOptions {
  readonly paths?: string[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

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
  readonly conflicts: Conflict[];
  readonly writtenPaths: string[];
  readonly failed: FailedOperation[];
  readonly duration: number;
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
  readonly pendingOperations: number;
  readonly lastSyncAt: string | null;
}

export interface FailedOperation {
  readonly path: string;
  readonly operation: OperationType;
  readonly error: string;
}
