import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn().mockResolvedValue("# Test\n\nContent"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
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
    delete: vi.fn(),
    getMeta: vi.fn().mockReturnValue(null),
    setMeta: vi.fn(),
    close: vi.fn(),
  };
}

function createMockNotionClient() {
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
    deleteBlock: vi.fn().mockResolvedValue(undefined),
    updatePageProperties: vi.fn().mockResolvedValue(undefined),
    archivePage: vi.fn().mockResolvedValue(undefined),
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
  };
}

function createConfig(overrides?: Partial<Config>): Config {
  return {
    ...DEFAULT_CONFIG,
    notion: {
      token: "ntn_test_token",
      rootPageId: "root-page-id",
    },
    ...overrides,
  };
}

describe("SyncOrchestrator", () => {
  let orchestrator: SyncOrchestrator;
  let mockVaultFs: ReturnType<typeof createMockVaultFs>;
  let mockStateDb: ReturnType<typeof createMockStateDb>;
  let mockNotionClient: ReturnType<typeof createMockNotionClient>;
  let config: Config;

  beforeEach(() => {
    mockVaultFs = createMockVaultFs();
    mockStateDb = createMockStateDb();
    mockNotionClient = createMockNotionClient();
    config = createConfig();

    orchestrator = new SyncOrchestrator(
      config,
      mockStateDb as any,
      mockNotionClient as any,
      mockVaultFs,
    );
  });

  describe("push", () => {
    it("변경 없으면 빈 결과 반환", async () => {
      const result = await orchestrator.push();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.failed).toHaveLength(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("새 파일 생성 시 Notion에 페이지 생성", async () => {
      mockVaultFs.listMarkdownFiles = vi
        .fn()
        .mockResolvedValue([
          { path: "new-note.md", content: "# Hello\n\nWorld", mtime: new Date().toISOString() },
        ]);

      const result = await orchestrator.push();

      expect(result.created).toBe(1);
      expect(mockNotionClient.createPage).toHaveBeenCalled();
      expect(mockStateDb.upsert).toHaveBeenCalled();
      expect(mockStateDb.setMeta).toHaveBeenCalledWith("last_push_at", expect.any(String));
    });

    it("수정된 파일 Notion에 업데이트", async () => {
      mockStateDb.getByPath.mockReturnValue({
        id: 1,
        obsidianPath: "existing.md",
        notionPageId: "page-123",
        contentHash: "old-hash",
      });

      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        {
          path: "existing.md",
          content: "# Updated\n\nNew content",
          mtime: new Date().toISOString(),
        },
      ]);

      const result = await orchestrator.push();

      expect(result.updated).toBe(1);
      expect(mockNotionClient.fetchAllChildren).toHaveBeenCalledWith("page-123");
    });

    it("삭제된 파일 Notion에서 아카이브", async () => {
      const deletedRecord = {
        id: 1,
        obsidianPath: "deleted.md",
        notionPageId: "page-del",
        contentHash: "some-hash",
        status: "synced",
      };

      mockStateDb.getByPath.mockImplementation((path: string) =>
        path === "deleted.md" ? deletedRecord : null,
      );
      mockStateDb.getByStatus.mockReturnValue([deletedRecord]);

      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([]);

      config = createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: true } });
      orchestrator = new SyncOrchestrator(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
      );

      const result = await orchestrator.push();

      expect(result.deleted).toBe(1);
      expect(mockNotionClient.archivePage).toHaveBeenCalledWith("page-del");
    });

    it("dryRun 모드에서는 실제 작업 안 함", async () => {
      mockVaultFs.listMarkdownFiles = vi
        .fn()
        .mockResolvedValue([
          { path: "new.md", content: "# Test", mtime: new Date().toISOString() },
        ]);

      const result = await orchestrator.push({ dryRun: true });

      expect(result.created).toBe(0);
      expect(mockNotionClient.createPage).not.toHaveBeenCalled();
    });

    it("paths 필터링 동작", async () => {
      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        { path: "notes/a.md", content: "# A", mtime: new Date().toISOString() },
        { path: "other/b.md", content: "# B", mtime: new Date().toISOString() },
      ]);

      const result = await orchestrator.push({ paths: ["notes/"] });

      expect(result.created).toBe(1);
    });

    it("API 오류 시 failed에 기록", async () => {
      mockVaultFs.listMarkdownFiles = vi
        .fn()
        .mockResolvedValue([{ path: "bad.md", content: "# Bad", mtime: new Date().toISOString() }]);
      mockNotionClient.createPage.mockRejectedValue(new Error("API limit"));

      const result = await orchestrator.push();

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.error).toBe("API limit");
    });
  });

  describe("pull", () => {
    it("원격 변경 없으면 빈 결과", async () => {
      const result = await orchestrator.pull();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.conflicts).toHaveLength(0);
    });

    it("새 원격 페이지 로컬에 생성", async () => {
      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        { id: "new-page", last_edited_time: "2026-01-01T00:00:00.000Z" },
      ]);
      mockNotionClient.getPage.mockResolvedValue({
        id: "new-page",
        last_edited_time: "2026-01-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: "root-page-id" },
        properties: {
          title: { type: "title", title: [{ plain_text: "New Page" }] },
        },
      });
      mockNotionClient.listChildren.mockResolvedValue({ results: [] });

      const result = await orchestrator.pull();

      expect(result.created).toBe(1);
      expect(mockVaultFs.writeFile).toHaveBeenCalled();
      expect(mockStateDb.upsert).toHaveBeenCalled();
    });

    it("수정된 원격 페이지 로컬에 업데이트 (로컬 미변경)", async () => {
      const existingRecord = {
        id: 1,
        obsidianPath: "existing.md",
        notionPageId: "mod-page",
        contentHash: "34a780ad578b997db55b260beb60b501f3e04d30ba1a51fcf43cd8dd1241780d",
        notionLastEdited: "2025-01-01T00:00:00.000Z",
        notionParentId: "root-page-id",
        syncDirection: "both",
        fileType: "file",
        baseSnapshot: Buffer.from("old content"),
      };

      mockStateDb.getByNotionId.mockImplementation((id: string) =>
        id === "mod-page" ? existingRecord : null,
      );
      mockStateDb.getAll.mockReturnValue([existingRecord]);

      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        { id: "mod-page", last_edited_time: "2026-06-01T00:00:00.000Z" },
      ]);
      mockNotionClient.getPage.mockResolvedValue({
        id: "mod-page",
        last_edited_time: "2026-06-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: "root-page-id" },
        properties: {
          title: { type: "title", title: [{ plain_text: "Existing" }] },
        },
      });

      mockVaultFs.readFile = vi.fn().mockResolvedValue("old content");

      const result = await orchestrator.pull();

      expect(result.updated).toBe(1);
      expect(mockVaultFs.writeFile).toHaveBeenCalled();
    });

    it("로컬+원격 동시 수정 시 충돌 감지", async () => {
      const existingRecord = {
        id: 1,
        obsidianPath: "conflict.md",
        notionPageId: "conflict-page",
        contentHash: "base-hash",
        notionLastEdited: "2025-01-01T00:00:00.000Z",
        notionParentId: "root-page-id",
        syncDirection: "both",
        fileType: "file",
        baseSnapshot: Buffer.from("base content"),
      };

      mockStateDb.getByNotionId.mockImplementation((id: string) =>
        id === "conflict-page" ? existingRecord : null,
      );
      mockStateDb.getAll.mockReturnValue([existingRecord]);

      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        { id: "conflict-page", last_edited_time: "2026-06-01T00:00:00.000Z" },
      ]);
      mockNotionClient.getPage.mockResolvedValue({
        id: "conflict-page",
        last_edited_time: "2026-06-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: "root-page-id" },
        properties: {
          title: { type: "title", title: [{ plain_text: "Conflict" }] },
        },
      });

      mockVaultFs.readFile = vi.fn().mockResolvedValue("locally modified content");

      const result = await orchestrator.pull();

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.localContent).toBe("locally modified content");
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith(1, "conflict");
    });

    it("dryRun 모드", async () => {
      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        { id: "new-page", last_edited_time: "2026-01-01T00:00:00.000Z" },
      ]);

      const result = await orchestrator.pull({ dryRun: true });

      expect(result.created).toBe(0);
      expect(mockVaultFs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe("sync", () => {
    it("pull + push 순서로 실행", async () => {
      const result = await orchestrator.sync();

      expect(result.pull).toBeDefined();
      expect(result.push).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("status", () => {
    it("현재 상태 반환", async () => {
      const result = await orchestrator.status();

      expect(result.localChanges).toBeDefined();
      expect(result.remoteChanges).toBeDefined();
      expect(result.conflicts).toBeDefined();
    });
  });
});
