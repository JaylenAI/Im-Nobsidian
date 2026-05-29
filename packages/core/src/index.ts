// Types
export type {
  Config,
  SyncRecord,
  LocalChange,
  RemoteChange,
  Conflict,
  BaseSyncOptions,
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
  ProgressCallback,
  ProgressItem,
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
export type { DatabaseSyncConfig } from "./types/config.js";
export type {
  ViewType,
  ViewConfig,
  ViewPropertyConfig,
  CoverConfig,
  GroupByConfig,
  DatabaseViewsConfig,
  PageCover,
  PageIcon,
} from "./types/view.js";

// Config
export { ConfigManager } from "./config/index.js";

// State
export { StateDB } from "./state/index.js";
export type { IStateDB } from "./state/index.js";
export type { UpsertSyncRecord, FileRegistryEntry, RegisterFileInput } from "./state/index.js";

// Notion
export { NotionClient, NotionBlockBuilder, PropertyMapper } from "./notion/index.js";
export type {
  NotionClientOptions,
  NotionBlock,
  NotionRichText,
  RichTextItem as NotionRichTextItem,
  RichTextSegment,
} from "./notion/index.js";

// Sync
export {
  SyncOrchestrator,
  ChangeDetector,
  NodeVaultFS,
  ImageHandler,
  FileHandler,
  DatabaseSyncer,
} from "./sync/index.js";
export type {
  VaultFS,
  FileInfo,
  FileStatInfo,
  NonMdFileInfo,
  ImageDownloadResult,
  PathFilterConfig,
  FileUploadResult,
  FileDownloadResult,
  DatabaseSyncResult,
} from "./sync/index.js";

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
  LocalImageRestorer,
  UnsupportedBlockStripper,
  PropertiesTableInjector,
  PropertiesTableRestorer,
  HtmlAnnotationStripper,
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

// View
export {
  ViewDataProvider,
  EntryEditor,
  BaseFileGenerator,
  sortEntries,
  groupEntries,
  extractCalendarEntries,
  filterByMonth,
  getVisibleProperties,
  filterEntries,
  getNotionColor,
  getNotionBgColor,
  generateColorCSS,
} from "./view/index.js";
export type {
  DBEntry,
  PropertyValue,
  GroupedEntries,
  CalendarEntry,
  NotionColor,
  ViewRenderData,
  PropertySchema,
  PropertyOption,
  FilterCondition,
  BasePropertySchema,
  BaseFileOptions,
} from "./view/index.js";

// Utils
export { computeHash, computeBufferHash } from "./utils/hash.js";
export { generateId, normalizeNotionId, notionIdsEqual } from "./utils/id.js";
export { sanitizeFileName } from "./utils/sanitize.js";
export { setLogger, getLogger } from "./utils/logger.js";
export type { Logger } from "./utils/logger.js";

// Factory
export { createDefaultPipeline } from "./converter/pipeline-factory.js";

// Constants — 경로 단일 진실원(SSOT).
export {
  INTERNAL_DIR,
  CONFIG_FILE,
  STATE_DB_FILE,
  DB_VIEWS_FILE,
  IGNORE_FILE,
  GITIGNORE_ENTRY,
  DB_VIEWS_PATH,
  STATE_DB_PATH,
  INTERNAL_DIR_GLOB,
  isInternalPath,
} from "./constants/paths.js";

// 마커 포맷 세부는 core 내부 전용이지만, 브랜드 토큰만은 플러그인 미리보기 렌더링 등
// 패키지 외부 소비자도 마커를 식별해야 하므로 단일 진실원으로 공개한다.
export { MARKER_BRAND } from "./constants/markers.js";
