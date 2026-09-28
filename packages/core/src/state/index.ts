export { StateDB } from "./state-db.js";
export { StateDbUnavailableError } from "./state-db-unavailable.js";
export { SavedStateDbError, SAVED_STATE_TABLES_QUERY } from "./saved-state-db-error.js";
export { StateLock, StateDbLockedError, stateDbLockPath } from "./state-lock.js";
export type { StateDbTool, StateLockClaim, StateLockOwner } from "./state-lock.js";
export {
  PendingWalError,
  assertNoPendingWal,
  pendingWalBytes,
  stateDbWalPath,
} from "./pending-wal.js";
export type { IStateDB } from "./state-db-interface.js";
export type {
  UpsertSyncRecord,
  FileRegistryEntry,
  RegisterFileInput,
  PendingOperation,
  RecordPendingInput,
} from "./state-db.js";
