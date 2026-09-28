/**
 * SyncOrchestrator 단위 테스트용 공유 목(mock) 팩토리.
 *
 * orchestrator.test.ts 와 회귀 잠금 테스트(incremental-deletion-churn.test.ts 등)가
 * 동일한 VaultFS/StateDb/NotionClient 목과 Config 빌더를 공유한다. 테스트마다 목을
 * 재정의하면 시그니처 드리프트 시 일부만 갱신돼 거짓 GREEN 이 생기므로 단일 출처로 둔다.
 */
import { vi } from "vitest";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { RemoteObservation } from "../../src/types/sync.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import {
  EDIT_TIME_RESOLUTION_MS,
  CLOCK_SKEW_MARGIN_MS,
} from "../../src/sync/remote-observation.js";

export function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn().mockResolvedValue("# Test\n\nContent"),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
    listMarkdownFileStats: vi.fn().mockResolvedValue([]),
    getFileStat: vi.fn().mockResolvedValue(null),
    listNonMarkdownFiles: vi.fn().mockResolvedValue([]),
  };
}

/**
 * 원격을 그 수정 시각이 가라앉은 뒤에 본 레코드의 관측 칸(N-05). 원격이 이 시각 그대로면
 * 지난번 그대로다 — push 가 원격을 다시 확인하지 않고 쓴다.
 */
export function settledObservation(lastEdited: string) {
  return {
    notionLastEdited: lastEdited,
    notionLastEditedBy: null,
    notionSeenAt: new Date(
      Date.parse(lastEdited) + EDIT_TIME_RESOLUTION_MS + CLOCK_SKEW_MARGIN_MS,
    ).toISOString(),
    notionBodyFingerprint: null,
  };
}

/** 아직 원격을 본 적 없는 레코드의 관측 칸 — 만들다 끊긴 페이지 · 자리표시. */
export const UNOBSERVED = {
  notionLastEdited: null,
  notionLastEditedBy: null,
  notionSeenAt: null,
  notionBodyFingerprint: null,
} as const;

/**
 * 상태 DB 목의 관측 기록(N-05)을 레코드 목록에 반영한다 — 기록한 뒤 레코드를 다시 읽는 시험이
 * 실제 DB 처럼 보게.
 */
export function mirrorRemoteObservation(
  stateDb: ReturnType<typeof createMockStateDb>,
  records: () => Iterable<Record<string, unknown>>,
): void {
  stateDb.setRemoteObservation.mockImplementation((id: unknown, observation: RemoteObservation) => {
    for (const record of records()) {
      if (record.id !== id) continue;
      Object.assign(record, {
        notionLastEdited: observation.lastEdited,
        notionLastEditedBy: observation.lastEditedBy,
        notionSeenAt: observation.seenAt,
        ...(observation.bodyFingerprint === undefined
          ? {}
          : { notionBodyFingerprint: observation.bodyFingerprint }),
      });
    }
  });
  stateDb.setNotionBodyFingerprint.mockImplementation((id: unknown, fingerprint: string | null) => {
    for (const record of records()) {
      if (record.id === id) record.notionBodyFingerprint = fingerprint;
    }
  });
}

export function createMockStateDb() {
  return {
    getByPath: vi.fn().mockReturnValue(null),
    getByNotionId: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    upsert: vi.fn().mockReturnValue({ id: 1 }),
    upsertWikilink: vi.fn(),
    deleteWikilink: vi.fn(),
    updateHash: vi.fn(),
    updateStatus: vi.fn(),
    setRemoteObservation: vi.fn(),
    setNotionBodyFingerprint: vi.fn(),
    setNotionParentId: vi.fn(),
    updatePath: vi.fn(),
    updateStatCache: vi.fn(),
    delete: vi.fn(),
    getMeta: vi.fn().mockReturnValue(null),
    setMeta: vi.fn(),
    storePreserveMarkers: vi.fn(),
    getPreserveMarkers: vi.fn().mockReturnValue([]),
    resolveWikilink: vi.fn().mockReturnValue(null),
    resolvePageId: vi.fn().mockReturnValue(null),
    transaction: vi.fn().mockImplementation((fn: () => unknown) => fn()),
    // B4: pending_operations WAL + file_registry
    recordPendingOperation: vi.fn().mockReturnValue(100),
    getIncompletePendingOperations: vi.fn().mockReturnValue([]),
    getIncompleteOpByState: vi.fn().mockReturnValue(null),
    markPendingCompleted: vi.fn(),
    markPendingFailed: vi.fn(),
    clearCompletedOperations: vi.fn(),
    registerFile: vi.fn(),
    getFileRegistry: vi.fn().mockReturnValue(null),
    isFileRegistered: vi.fn().mockReturnValue(false),
    close: vi.fn(),
  };
}

/** 목 Notion 클라이언트의 봇 id — 이 통합이 고친 페이지의 `last_edited_by`. */
export const MOCK_BOT_USER_ID = "bot-user-id";

/** 목 Notion 클라이언트가 돌려주는 페이지의 수정 시각. */
export const MOCK_REMOTE_EDITED = "2026-01-01T00:00:00.000Z";

/**
 * `getDatabaseMeta` 가 돌려주는 모양 — 받은 DB 를 행 조회 · 스키마 · 제목이 같이 읽는다. 스키마 · 제목은
 * 시험이 따로 흉내 내므로 여기에는 어느 DB 를 받았는지만 싣는다.
 */
export function mockDatabaseMeta(databaseId: string) {
  return { databaseId, title: "", dataSources: [], properties: {} };
}

export function createMockNotionClient() {
  return {
    createPage: vi.fn().mockResolvedValue({
      id: "page-id-123",
      last_edited_time: MOCK_REMOTE_EDITED,
    }),
    getPage: vi.fn().mockResolvedValue({
      id: "page-id-123",
      last_edited_time: MOCK_REMOTE_EDITED,
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: {
        title: { type: "title", title: [{ plain_text: "Test Page" }] },
      },
    }),
    appendChildren: vi.fn().mockResolvedValue({}),
    appendChildBlocks: vi.fn().mockResolvedValue([]),
    fetchAllChildren: vi.fn().mockResolvedValue([]),
    fetchAllChildrenDeep: vi.fn().mockResolvedValue([]),
    deleteBlock: vi.fn().mockResolvedValue(undefined),
    updatePageProperties: vi.fn().mockResolvedValue(undefined),
    archivePage: vi.fn().mockResolvedValue(undefined),
    getPageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] }),
    replacePageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] }),
    createPageWithMarkdown: vi.fn().mockResolvedValue({
      id: "page-id-123",
      last_edited_time: MOCK_REMOTE_EDITED,
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "Test Page" }] } },
    }),
    restoreLeadingHeading: vi.fn().mockResolvedValue(false),
    uploadFile: vi.fn().mockResolvedValue("file-upload-id"),
    listChildren: vi.fn().mockResolvedValue({ results: [] }),
    getChildPagesRecursive: vi.fn().mockResolvedValue([]),
    searchAllPages: vi.fn().mockResolvedValue([]),
    getPagesUnderRootViaSearch: vi.fn().mockResolvedValue([]),
    getInternalClient: vi.fn().mockReturnValue({
      blocks: {
        children: {
          list: vi.fn().mockResolvedValue({ results: [], next_cursor: null, has_more: false }),
        },
      },
    }),
    extractTitle: vi.fn().mockReturnValue("Test Page"),
    extractProperties: vi.fn().mockReturnValue({}),
    extractCover: vi.fn().mockReturnValue(null),
    extractIcon: vi.fn().mockReturnValue(null),
    setWikilinkResolver: vi.fn(),
    getDatabaseSchema: vi.fn().mockResolvedValue({}),
    getDatabaseSchemaFull: vi.fn().mockResolvedValue({}),
    getDatabaseSyncability: vi.fn().mockResolvedValue({ title: "Test DB", queryable: true }),
    // 기본값 null = linked 해소 실패 → 기존 접근 불가 경로 유지(F22 이전 동작과 동일)
    resolveLinkedDatabase: vi.fn().mockResolvedValue(null),
    getChildDatabaseIds: vi.fn().mockResolvedValue([]),
    getDatabaseTitle: vi.fn().mockResolvedValue("Test DB"),
    getDatabaseMeta: vi.fn(async (databaseId: string) => mockDatabaseMeta(databaseId)),
    getDatabaseViewsConfig: vi.fn().mockResolvedValue(null),
    queryAllDatabasePages: vi.fn().mockResolvedValue([]),
    queryDatabase: vi.fn().mockResolvedValue({ results: [], nextCursor: null }),
    movePage: vi.fn().mockResolvedValue({}),
    updatePageMarkdownPartial: vi.fn().mockResolvedValue({}),
    searchRecentPages: vi.fn().mockResolvedValue([]),
    searchRecentDataSources: vi.fn().mockResolvedValue([]),
    getBotUserId: vi.fn().mockResolvedValue(MOCK_BOT_USER_ID),
  };
}

export function createConfig(overrides?: Partial<Config>): Config {
  return {
    ...DEFAULT_CONFIG,
    notion: {
      token: "ntn_test_token",
      rootPageId: "root-page-id",
    },
    ...overrides,
  };
}
