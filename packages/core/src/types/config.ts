import { z } from "zod";
import { isTimeZone } from "../utils/zoned-time.js";

const DatabaseSyncSchema = z.object({
  databaseId: z.string(),
  localFolder: z.string(),
  propertyMapping: z.record(z.string()).optional(),
  pullFilter: z.unknown().optional(),
  titleProperty: z.string().default("Name"),
});

export type DatabaseSyncConfig = z.infer<typeof DatabaseSyncSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1),
  notion: z.object({
    token: z.string().startsWith("ntn_"),
    rootPageId: z.string(),
    workspaceId: z.string().optional(),
    parentMode: z.enum(["page", "database"]).default("page"),
    databaseId: z.string().optional(),
    databases: z.array(DatabaseSyncSchema).default([]),
  }),
  sync: z.object({
    direction: z.enum(["push", "pull", "both"]).default("both"),
    conflictStrategy: z
      .enum(["local-first", "remote-first", "manual", "duplicate"])
      .default("manual"),
    autoSync: z.boolean().default(false),
    autoSyncInterval: z.number().min(30).max(3600).default(300),
    // 전체 대조 주기(초) — 그 사이의 pull 은 바뀐 페이지 · 행 · DB 만 받는다. 원격 삭제는 전체 대조가
    // 반영한다. 0 이면 pull 마다 전체 대조(ADR-027). 최대 7일.
    fullReconcileInterval: z.number().int().min(0).max(604800).default(3600),
    deleteSync: z.boolean().default(false),
    syncFiles: z.boolean().default(true),
  }),
  paths: z.object({
    include: z.array(z.string()).default(["**/*"]),
    exclude: z.array(z.string()).default([]),
    attachments: z.string().default("attachments"),
  }),
  conversion: z.object({
    preferMarkdownApi: z.boolean().default(true),
    preserveMarkers: z.boolean().default(true),
    frontmatterMapping: z.boolean().default(true),
    imageDownload: z.enum(["immediate", "lazy", "skip"]).default("immediate"),
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
    concurrency: z.number().min(1).max(10).default(3),
    timeoutMs: z.number().min(5000).max(60000).default(30000),
    // 페이지네이션/블록 배치 (Notion API children append 상한 = 100)
    pageSize: z.number().min(1).max(100).default(100),
    batchSize: z.number().min(1).max(100).default(100),
    // Rate limit 게이트 (요청 간 최소 간격, ms)
    rateLimitIntervalMs: z.number().min(0).max(5000).default(350),
    // API 재시도 (지수 백오프: retryBaseDelayMs * retryBackoffFactor^attempt)
    maxRetries: z.number().min(0).max(10).default(5),
    retryBaseDelayMs: z.number().min(100).max(10000).default(1000),
    retryBackoffFactor: z.number().min(1).max(10).default(2),
    // 오케스트레이터 단계 간 재시도 대기 (ms)
    retryWaitMs: z.number().min(0).max(30000).default(2000),
    // 미디어(이미지/파일) 다운로드 동시성/재시도
    mediaConcurrency: z.number().min(1).max(10).default(3),
    mediaMaxRetries: z.number().min(0).max(10).default(3),
    mediaRetryBaseMs: z.number().min(100).max(10000).default(1000),
    // 비마크다운 파일(첨부) 업로드/다운로드 동시성
    fileConcurrency: z.number().min(1).max(10).default(2),
    // 다운로드 파일 크기 상한 (bytes, 기본 100MB)
    maxFileSizeBytes: z
      .number()
      .min(1024)
      .default(100 * 1024 * 1024),
    // 미디어·첨부 다운로드 1회 시도의 시간 상한 (ms, 기본 300초). 0 = 상한 없음(권장하지 않음)
    mediaDownloadTimeoutMs: z.number().min(0).max(1_800_000).default(300_000),
    // 페이지 1건 처리의 시간 상한 (ms, 기본 30분). 한 건이 동기화 전체를 멈춰 세우지 못하게 한다. 0 = 상한 없음
    itemTimeoutMs: z.number().min(0).max(7_200_000).default(1_800_000),
    // Markdown API 가 잘라 보낸 블록(S-06)을 다시 받는 수의 상한. 기본 요청 간격(350ms)으로
    // 3,000개 ≈ 17분 — itemTimeoutMs(30분) 안에서 끝난다. 넘으면 페이지는 블록 API 로 받는다
    markdownCompletionMaxBlocks: z.number().int().min(0).max(100_000).default(3000),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  version: 1,
  notion: {
    token: "",
    rootPageId: "",
    parentMode: "page",
    databases: [],
  },
  sync: {
    direction: "both",
    conflictStrategy: "manual",
    autoSync: false,
    autoSyncInterval: 300,
    fullReconcileInterval: 3600,
    deleteSync: false,
    syncFiles: true,
  },
  paths: {
    include: ["**/*"],
    exclude: [],
    attachments: "attachments",
  },
  conversion: {
    preferMarkdownApi: true,
    preserveMarkers: true,
    frontmatterMapping: true,
    imageDownload: "immediate",
  },
  advanced: {
    concurrency: 3,
    timeoutMs: 30000,
    pageSize: 100,
    batchSize: 100,
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
    mediaDownloadTimeoutMs: 300_000,
    itemTimeoutMs: 1_800_000,
    markdownCompletionMaxBlocks: 3000,
  },
};
