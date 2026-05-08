// Types
export type {
  Config,
  SyncRecord,
  LocalChange,
  RemoteChange,
  Conflict,
  PushOptions,
  PullOptions,
  SyncOptions,
  PushResult,
  PullResult,
  SyncResult,
  StatusResult,
  FailedOperation,
  SyncDirection,
  FileType,
  SyncStatus,
  OperationType,
  ConflictStrategy,
  ConversionPath,
  Processor,
  ProcessorInput,
  ProcessorOutput,
  ProcessorMetadata,
  ConversionContext,
  ConversionResult,
  PreserveMarker,
  ImageReference,
  WikilinkEntry,
} from "./types/index.js";

export { ConfigSchema, DEFAULT_CONFIG } from "./types/config.js";

// Config
export { ConfigManager } from "./config/index.js";

// State
export { StateDB } from "./state/index.js";
export type { UpsertSyncRecord } from "./state/index.js";

// Notion
export { NotionClient } from "./notion/index.js";
export type { NotionClientOptions } from "./notion/index.js";

// Sync
export { SyncOrchestrator, ChangeDetector, NodeVaultFS, ImageHandler } from "./sync/index.js";
export type { VaultFS, FileInfo, ImageDownloadResult } from "./sync/index.js";

// Converter
export {
  ConversionPipeline,
  BlockConverter,
  FrontmatterExtractor,
  WikilinkResolver,
  CalloutTransformer,
  InlineDBParser,
  MathNormalizer,
  EmbedResolver,
  PreserveMarkerCollector,
  MentionToWikilink,
  CalloutRestorer,
  ColorAnnotator,
  FrontmatterGenerator,
  PreserveMarkerInjector,
} from "./converter/index.js";

// Conflict
export { threeWayMerge, ConflictResolver } from "./conflict/index.js";
export type {
  MergeResult,
  MergeConflictRegion,
  ResolutionChoice,
  ResolutionResult,
} from "./conflict/index.js";

// Structure
export { TreeMapper } from "./structure/index.js";
export type {
  NotionPageNode,
  MappingType,
  MappingResult,
  FileSystemEntry,
  PageCreationPlan,
} from "./structure/index.js";

// Watcher
export { FileWatcher, WatchSyncService } from "./watcher/index.js";
export type { WatchSyncOptions } from "./watcher/index.js";

// Utils
export { computeHash, computeBufferHash } from "./utils/hash.js";
export { generateId, normalizeNotionId, notionIdsEqual } from "./utils/id.js";
export { sanitizeFileName } from "./utils/sanitize.js";
