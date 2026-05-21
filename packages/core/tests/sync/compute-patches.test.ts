import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn().mockResolvedValue(""),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("")),
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

function createMockStateDb() {
  return {
    getByPath: vi.fn().mockReturnValue(null),
    getByNotionId: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    upsert: vi.fn(),
    upsertWikilink: vi.fn(),
    updateHash: vi.fn(),
    updateStatus: vi.fn(),
    setNotionLastEdited: vi.fn(),
    updateStatCache: vi.fn(),
    setNotionParentId: vi.fn(),
    delete: vi.fn(),
    getMeta: vi.fn().mockReturnValue(null),
    setMeta: vi.fn(),
    storePreserveMarkers: vi.fn(),
    getPreserveMarkers: vi.fn().mockReturnValue([]),
    resolveWikilink: vi.fn().mockReturnValue(null),
    resolvePageId: vi.fn().mockReturnValue(null),
    transaction: vi.fn().mockImplementation((fn: () => unknown) => fn()),
    close: vi.fn(),
  };
}

function createMockNotionClient() {
  return {
    createPage: vi.fn().mockResolvedValue({ id: "p1", last_edited_time: "2026-01-01T00:00:00Z" }),
    getPage: vi.fn().mockResolvedValue({
      id: "p1",
      last_edited_time: "2026-01-01T00:00:00Z",
      parent: { type: "page_id", page_id: "root" },
      properties: { title: { type: "title", title: [{ plain_text: "T" }] } },
    }),
    appendChildren: vi.fn().mockResolvedValue({}),
    fetchAllChildren: vi.fn().mockResolvedValue([]),
    deleteBlock: vi.fn().mockResolvedValue(undefined),
    updatePageProperties: vi.fn().mockResolvedValue(undefined),
    archivePage: vi.fn().mockResolvedValue(undefined),
    getPageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] }),
    replacePageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] }),
    updatePageMarkdownPartial: vi
      .fn()
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] }),
    createPageWithMarkdown: vi.fn().mockResolvedValue({
      id: "p1",
      last_edited_time: "2026-01-01T00:00:00Z",
    }),
    uploadFile: vi.fn().mockResolvedValue("upload-id"),
    listChildren: vi.fn().mockResolvedValue({ results: [] }),
    getChildPagesRecursive: vi.fn().mockResolvedValue([]),
    getInternalClient: vi.fn().mockReturnValue({
      blocks: {
        children: {
          list: vi.fn().mockResolvedValue({ results: [], next_cursor: null, has_more: false }),
        },
      },
    }),
    extractTitle: vi.fn().mockReturnValue("Test"),
    extractProperties: vi.fn().mockReturnValue({}),
    getDatabaseSchema: vi.fn().mockResolvedValue({}),
    queryAllDatabasePages: vi.fn().mockResolvedValue([]),
    queryDatabase: vi.fn().mockResolvedValue({ results: [], nextCursor: null }),
    movePage: vi.fn().mockResolvedValue({}),
  };
}

describe("pushUpdatePage (full replace)", () => {
  let orchestrator: SyncOrchestrator;
  let mockVaultFs: ReturnType<typeof createMockVaultFs>;
  let mockStateDb: ReturnType<typeof createMockStateDb>;
  let mockNotionClient: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    mockVaultFs = createMockVaultFs();
    mockStateDb = createMockStateDb();
    mockNotionClient = createMockNotionClient();

    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, token: "ntn_test", rootPageId: "root" },
    };

    orchestrator = new SyncOrchestrator(
      config,
      mockStateDb as any,
      mockNotionClient as any,
      mockVaultFs,
    );
  });

  it("baseSnapshot 있어도 항상 replacePageMarkdown 호출", async () => {
    const oldContent = "# Title\n\nOld paragraph";
    const newContent = "# Title\n\nNew paragraph";

    mockVaultFs.readFile = vi.fn().mockResolvedValue(newContent);
    (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: "test.md", mtime: "2026-02-01T00:00:00Z", size: 100 },
    ]);
    mockStateDb.getByPath.mockReturnValue({
      id: "rec-1",
      obsidianPath: "test.md",
      notionPageId: "page-1",
      contentHash: "old-hash",
      notionLastEdited: "2026-01-01T00:00:00Z",
      localMtime: "2026-01-01T00:00:00Z",
      localFileSize: 80,
      baseSnapshot: Buffer.from(oldContent, "utf-8"),
      status: "synced",
      syncDirection: "both",
      fileType: "file",
    });
    mockStateDb.getAll.mockReturnValue([
      {
        id: "rec-1",
        obsidianPath: "test.md",
        notionPageId: "page-1",
        contentHash: "old-hash",
      },
    ]);

    await orchestrator.push();

    expect(mockNotionClient.replacePageMarkdown).toHaveBeenCalled();
    expect(mockNotionClient.updatePageMarkdownPartial).not.toHaveBeenCalled();
  });

  it("baseSnapshot 없어도 replacePageMarkdown 호출", async () => {
    const newContent = "# Title\n\nNew content";

    mockVaultFs.readFile = vi.fn().mockResolvedValue(newContent);
    (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: "test.md", mtime: "2026-02-01T00:00:00Z", size: 100 },
    ]);
    mockStateDb.getByPath.mockReturnValue({
      id: "rec-1",
      obsidianPath: "test.md",
      notionPageId: "page-1",
      contentHash: "old-hash",
      notionLastEdited: "2026-01-01T00:00:00Z",
      localMtime: "2026-01-01T00:00:00Z",
      localFileSize: 80,
      baseSnapshot: null,
      status: "synced",
      syncDirection: "both",
      fileType: "file",
    });
    mockStateDb.getAll.mockReturnValue([
      {
        id: "rec-1",
        obsidianPath: "test.md",
        notionPageId: "page-1",
        contentHash: "old-hash",
      },
    ]);

    await orchestrator.push();

    expect(mockNotionClient.replacePageMarkdown).toHaveBeenCalled();
    expect(mockNotionClient.updatePageMarkdownPartial).not.toHaveBeenCalled();
  });

  it("변경이 없으면 (같은 해시) 업데이트 스킵", async () => {
    const content = "# Title\n\nSame content";
    const { computeHash } = await import("../../src/utils/hash.js");
    const hash = computeHash(content);

    mockVaultFs.readFile = vi.fn().mockResolvedValue(content);
    (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: "test.md", mtime: "2026-02-01T00:00:00Z", size: 100 },
    ]);
    mockStateDb.getByPath.mockReturnValue({
      id: "rec-1",
      obsidianPath: "test.md",
      notionPageId: "page-1",
      contentHash: hash,
      notionLastEdited: "2026-01-01T00:00:00Z",
      localMtime: "2026-01-01T00:00:00Z",
      localFileSize: 80,
      baseSnapshot: Buffer.from(content, "utf-8"),
      status: "synced",
      syncDirection: "both",
      fileType: "file",
    });
    mockStateDb.getAll.mockReturnValue([]);

    const result = await orchestrator.push();

    expect(result.updated).toBe(0);
    expect(mockNotionClient.updatePageMarkdownPartial).not.toHaveBeenCalled();
    expect(mockNotionClient.replacePageMarkdown).not.toHaveBeenCalled();
  });
});
