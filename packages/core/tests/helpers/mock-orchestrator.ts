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
import type { VaultFS } from "../../src/sync/vault-fs.js";

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
    setNotionLastEdited: vi.fn(),
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

export function createMockNotionClient() {
  return {
    createPage: vi.fn().mockResolvedValue({
      id: "page-id-123",
      last_edited_time: "2026-01-01T00:00:00.000Z",
    }),
    getPage: vi.fn().mockResolvedValue({
      id: "page-id-123",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: {
        title: { type: "title", title: [{ plain_text: "Test Page" }] },
      },
    }),
    appendChildren: vi.fn().mockResolvedValue({}),
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
      last_edited_time: "2026-01-01T00:00:00.000Z",
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "Test Page" }] } },
    }),
    uploadFile: vi.fn().mockResolvedValue("file-upload-id"),
    listChildren: vi.fn().mockResolvedValue({ results: [] }),
    getChildPagesRecursive: vi.fn().mockResolvedValue([]),
    getInternalClient: vi.fn().mockReturnValue({
      blocks: {
        children: {
          list: vi.fn().mockResolvedValue({ results: [], next_cursor: null, has_more: false }),
        },
      },
    }),
    extractTitle: vi.fn().mockReturnValue("Test Page"),
    extractProperties: vi.fn().mockReturnValue({}),
    getDatabaseSchema: vi.fn().mockResolvedValue({}),
    getDatabaseSyncability: vi.fn().mockResolvedValue({ title: "Test DB", queryable: true }),
    getDatabaseTitle: vi.fn().mockResolvedValue("Test DB"),
    getDatabaseViewsConfig: vi.fn().mockResolvedValue(null),
    queryAllDatabasePages: vi.fn().mockResolvedValue([]),
    queryDatabase: vi.fn().mockResolvedValue({ results: [], nextCursor: null }),
    movePage: vi.fn().mockResolvedValue({}),
    updatePageMarkdownPartial: vi.fn().mockResolvedValue({}),
    searchRecentPages: vi.fn().mockResolvedValue([]),
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
