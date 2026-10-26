import { z } from "zod";
import { isTimeZone } from "../utils/zoned-time.js";
import { BLOCK_CHILDREN_MAX } from "../constants/notion-limits.js";
import { DEFAULT_DOWNLOAD_TIMEOUT_MS } from "../utils/download-fetch.js";
import { DEFAULT_ITEM_TIMEOUT_MS } from "../utils/deadline.js";
import { NOTIFICATION_MODES, type NotificationMode } from "../notion/sdk-client.js";

/** Notion 내부 통합 토큰의 머리 — 설정 검증과 CLI 의 입력 검사가 함께 읽는다. */
export const NOTION_TOKEN_PREFIX = "ntn_";

/** DB 의 제목 속성 이름 기본값 — Notion 이 새 DB 에 붙이는 이름. */
export const DEFAULT_TITLE_PROPERTY = "Name";

const DatabaseSyncSchema = z.object({
  databaseId: z.string(),
  localFolder: z.string(),
  propertyMapping: z.record(z.string()).optional(),
  pullFilter: z.unknown().optional(),
  titleProperty: z.string().default(DEFAULT_TITLE_PROPERTY),
});

export type DatabaseSyncConfig = z.infer<typeof DatabaseSyncSchema>;

/**
 * 설정 기본값 한 벌 — 아래 스키마의 `.default()` 와 {@link DEFAULT_CONFIG} 가 함께 읽는다.
 * 예전에는 두 곳에 손으로 맞춰 적혀 있었다. 타입은 파일 끝의 `DEFAULT_CONFIG: Config` 가 검사한다.
 */
const DEFAULTS = {
  version: 1 as const,
  notion: {
    token: "",
    rootPageId: "",
    parentMode: "page" as const,
    databases: [] as DatabaseSyncConfig[],
  },
  sync: {
    direction: "both" as const,
    conflictStrategy: "manual" as const,
    autoSync: false,
    autoSyncInterval: 300,
    fullReconcileInterval: 3600,
    deleteSync: false,
    renameOnTitleChange: false,
    syncFiles: true,
    createDatabases: true,
    notifications: "silent" as NotificationMode,
  },
  paths: {
    include: ["**/*"],
    exclude: [] as string[],
    attachments: "attachments",
  },
  conversion: {
    preferMarkdownApi: true,
    preserveMarkers: true,
    frontmatterMapping: true,
    imageDownload: "immediate" as const,
  },
  advanced: {
    concurrency: 3,
    timeoutMs: 30000,
    pageSize: BLOCK_CHILDREN_MAX,
    batchSize: BLOCK_CHILDREN_MAX,
    rateLimitIntervalMs: 350,
    maxRetries: 5,
    retryBaseDelayMs: 1000,
    retryBackoffFactor: 2,
    retryWaitMs: 2000,
    mediaConcurrency: 3,
    mediaMaxRetries: 3,
    mediaRetryBaseMs: 1000,
    fileConcurrency: 2,
    maxFileSizeBytes: 100 * 1024 * 1024,
    mediaDownloadTimeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
    itemTimeoutMs: DEFAULT_ITEM_TIMEOUT_MS,
    markdownCompletionMaxBlocks: 3000,
  },
};
const D = DEFAULTS;

export const ConfigSchema = z.object({
  version: z.literal(1),
  notion: z.object({
    token: z.string().startsWith(NOTION_TOKEN_PREFIX),
    rootPageId: z.string(),
    workspaceId: z.string().optional(),
    parentMode: z.enum(["page", "database"]).default(D.notion.parentMode),
    databaseId: z.string().optional(),
    databases: z.array(DatabaseSyncSchema).default(() => []),
  }),
  sync: z.object({
    direction: z.enum(["push", "pull", "both"]).default(D.sync.direction),
    conflictStrategy: z
      .enum(["local-first", "remote-first", "manual", "duplicate"])
      .default(D.sync.conflictStrategy),
    autoSync: z.boolean().default(D.sync.autoSync),
    autoSyncInterval: z.number().min(30).max(3600).default(D.sync.autoSyncInterval),
    // 전체 대조 주기(초) — 그 사이의 pull 은 바뀐 페이지 · 행 · DB 만 받는다. 원격 삭제는 전체 대조가
    // 반영한다. 0 이면 pull 마다 전체 대조(ADR-027). 최대 7일.
    fullReconcileInterval: z
      .number()
      .int()
      .min(0)
      .max(604800)
      .default(D.sync.fullReconcileInterval),
    deleteSync: z.boolean().default(D.sync.deleteSync),
    // Notion 에서 바꾼 제목으로 노트 이름을 바꾼다 — 끄면 이름은 두고 새 제목을 frontmatter `title` 에 적는다.
    renameOnTitleChange: z.boolean().default(D.sync.renameOnTitleChange),
    syncFiles: z.boolean().default(D.sync.syncFiles),
    // 사이드카가 있는 새 DB 폴더를 push 가 Notion DB 로 만든다(ADR-036). 끄면 폴더 · 페이지로 올린다.
    createDatabases: z.boolean().default(D.sync.createDatabases),
    // 동기화가 만들고 고친 페이지가 알림을 보내나. silent 면 페이지 수정 · @멘션 · 사람 속성 알림을 보내지
    // 않는다 — 볼트를 새 워크스페이스로 올리면 사람 속성이 있는 행마다 그 사람에게 알림이 갔다.
    notifications: z.enum(NOTIFICATION_MODES).default(D.sync.notifications),
  }),
  paths: z.object({
    include: z.array(z.string()).default(() => [...D.paths.include]),
    exclude: z.array(z.string()).default(() => [...D.paths.exclude]),
    attachments: z.string().default(D.paths.attachments),
  }),
  conversion: z.object({
    preferMarkdownApi: z.boolean().default(D.conversion.preferMarkdownApi),
    preserveMarkers: z.boolean().default(D.conversion.preserveMarkers),
    frontmatterMapping: z.boolean().default(D.conversion.frontmatterMapping),
    imageDownload: z.enum(["immediate", "lazy", "skip"]).default(D.conversion.imageDownload),
    // 행 속성의 날짜시각을 적고 보낼 시간대(IANA 이름, 예: "Asia/Seoul"). 없으면 이 컴퓨터의 시간대.
    // Obsidian 날짜시각 속성에는 시간대가 없다 — pull 은 이 시간대의 시각으로 적고 push 는 이 시간대의
    // 오프셋을 붙여 보낸다(F-08).
    timeZone: z
      .string()
      .refine(isTimeZone, {
        message: "알 수 없는 시간대 이름 — IANA 이름(예: Asia/Seoul)을 쓰세요",
      })
      .optional(),
  }),
  advanced: z.object({
    // Notion API 클라이언트 동시성/타임아웃
    concurrency: z.number().min(1).max(10).default(D.advanced.concurrency),
    timeoutMs: z.number().min(5000).max(60000).default(D.advanced.timeoutMs),
    // 페이지네이션/블록 배치 (Notion API children append 상한 = 100)
    pageSize: z.number().min(1).max(BLOCK_CHILDREN_MAX).default(D.advanced.pageSize),
    batchSize: z.number().min(1).max(BLOCK_CHILDREN_MAX).default(D.advanced.batchSize),
    // Rate limit 게이트 (요청 간 최소 간격, ms)
    rateLimitIntervalMs: z.number().min(0).max(5000).default(D.advanced.rateLimitIntervalMs),
    // API 재시도 (지수 백오프: retryBaseDelayMs * retryBackoffFactor^attempt)
    maxRetries: z.number().min(0).max(10).default(D.advanced.maxRetries),
    retryBaseDelayMs: z.number().min(100).max(10000).default(D.advanced.retryBaseDelayMs),
    retryBackoffFactor: z.number().min(1).max(10).default(D.advanced.retryBackoffFactor),
    // 오케스트레이터 단계 간 재시도 대기 (ms)
    retryWaitMs: z.number().min(0).max(30000).default(D.advanced.retryWaitMs),
    // 미디어(이미지/파일) 다운로드 동시성/재시도
    mediaConcurrency: z.number().min(1).max(10).default(D.advanced.mediaConcurrency),
    mediaMaxRetries: z.number().min(0).max(10).default(D.advanced.mediaMaxRetries),
    mediaRetryBaseMs: z.number().min(100).max(10000).default(D.advanced.mediaRetryBaseMs),
    // 비마크다운 파일(첨부) 업로드/다운로드 동시성
    fileConcurrency: z.number().min(1).max(10).default(D.advanced.fileConcurrency),
    // 다운로드 파일 크기 상한 (bytes, 기본 100MB)
    maxFileSizeBytes: z.number().min(1024).default(D.advanced.maxFileSizeBytes),
    // 미디어·첨부 다운로드 1회 시도의 시간 상한 (ms, 기본 300초). 0 = 상한 없음(권장하지 않음)
    mediaDownloadTimeoutMs: z
      .number()
      .min(0)
      .max(1_800_000)
      .default(D.advanced.mediaDownloadTimeoutMs),
    // 페이지 1건 처리의 시간 상한 (ms, 기본 30분). 한 건이 동기화 전체를 멈춰 세우지 못하게 한다. 0 = 상한 없음
    itemTimeoutMs: z.number().min(0).max(7_200_000).default(D.advanced.itemTimeoutMs),
    // Markdown API 가 잘라 보낸 블록(S-06)을 다시 받는 수의 상한. 기본값은 기본 요청 간격으로 다 받아도
    // 기본 itemTimeoutMs 안에서 끝나게 잡았다. 넘으면 페이지는 블록 API 로 받는다
    markdownCompletionMaxBlocks: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .default(D.advanced.markdownCompletionMaxBlocks),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = DEFAULTS;
