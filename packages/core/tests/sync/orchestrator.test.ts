import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";

function createMockVaultFs(): VaultFS {
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
    queryAllDatabasePages: vi.fn().mockResolvedValue([]),
    queryDatabase: vi.fn().mockResolvedValue({ results: [], nextCursor: null }),
    movePage: vi.fn().mockResolvedValue({}),
    updatePageMarkdownPartial: vi.fn().mockResolvedValue({}),
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
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "new-note.md", mtime: now, size: 100 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Hello\n\nWorld");

      const result = await orchestrator.push();

      expect(result.created).toBe(1);
      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalled();
      expect(mockStateDb.upsert).toHaveBeenCalled();
      expect(mockStateDb.setMeta).toHaveBeenCalledWith("last_push_at", expect.any(String));
    });

    it("수정된 파일 Notion에 업데이트", async () => {
      const now = new Date().toISOString();
      mockStateDb.getByPath.mockReturnValue({
        id: 1,
        obsidianPath: "existing.md",
        notionPageId: "page-123",
        contentHash: "old-hash",
        localMtime: "2020-01-01T00:00:00.000Z",
        localFileSize: 50,
      });

      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "existing.md", mtime: now, size: 100 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        "# Updated\n\nNew content",
      );

      const result = await orchestrator.push();

      expect(result.updated).toBe(1);
      expect(mockNotionClient.replacePageMarkdown).toHaveBeenCalledWith(
        "page-123",
        expect.any(String),
      );
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
      mockStateDb.getByStatus.mockImplementation((status: string) =>
        status === "synced" ? [deletedRecord] : [],
      );

      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([]);

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

    it("dryRun 모드에서는 실제 작업 안 하고 예정 수량 반환", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "new.md", mtime: now, size: 50 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Test");

      const result = await orchestrator.push({ dryRun: true });

      expect(result.created).toBe(1);
      expect(mockNotionClient.createPage).not.toHaveBeenCalled();
    });

    it("paths 필터링 동작", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "notes/a.md", mtime: now, size: 30 },
        { path: "other/b.md", mtime: now, size: 30 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) =>
        p === "notes/a.md" ? "# A" : "# B",
      );

      const result = await orchestrator.push({ paths: ["notes/"] });

      expect(result.created).toBe(1);
    });

    it("API 오류 시 failed에 기록", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "bad.md", mtime: now, size: 40 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Bad");
      mockNotionClient.createPageWithMarkdown.mockRejectedValue(new Error("API limit"));
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

    it("dryRun 모드에서 예정 수량 반환", async () => {
      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        { id: "new-page", last_edited_time: "2026-01-01T00:00:00.000Z" },
      ]);

      const result = await orchestrator.pull({ dryRun: true });

      expect(result.created).toBe(1);
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

    it("sync 결과에 pull conflicts 전달", async () => {
      const result = await orchestrator.sync();

      expect(result.conflicts).toEqual([]);
      expect(result.pull.conflicts).toEqual([]);
    });
  });

  describe("status", () => {
    it("현재 상태 반환", async () => {
      const result = await orchestrator.status();

      expect(result.localChanges).toEqual([]);
      expect(result.remoteChanges).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.conflictRecords).toEqual([]);
      expect(result.pendingOperations).toBe(0);
      expect(result.lastSyncAt).toBeNull();
    });

    it("충돌 레코드가 있으면 conflicts 배열에 반영", async () => {
      const conflictRecord = {
        id: "rec-1",
        obsidianPath: "conflict-note.md",
        notionPageId: "page-conflict",
        notionParentId: "parent-1",
        contentHash: "hash-old",
        notionLastEdited: "2026-01-01T00:00:00.000Z",
        localLastModified: "2026-01-01T00:00:00.000Z",
        syncDirection: "both" as const,
        fileType: "file" as const,
        status: "conflict" as const,
        baseSnapshot: Buffer.from("base content"),
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      mockStateDb.getByStatus.mockReturnValue([conflictRecord]);

      const result = await orchestrator.status();

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.syncRecord).toBe(conflictRecord);
      expect(result.conflicts[0]!.baseContent).toBe("base content");
      expect(result.conflicts[0]!.localContent).toBe("# Test\n\nContent");
      expect(result.conflictRecords).toHaveLength(1);
      expect(result.pendingOperations).toBe(1);
    });

    it("lastSyncAt 값이 있으면 반환", async () => {
      mockStateDb.getMeta.mockImplementation((key: string) =>
        key === "last_sync_at" ? "2026-05-10T12:00:00.000Z" : null,
      );

      const result = await orchestrator.status();

      expect(result.lastSyncAt).toBe("2026-05-10T12:00:00.000Z");
    });

    it("로컬 변경사항 감지", async () => {
      mockVaultFs.listMarkdownFiles = vi
        .fn()
        .mockResolvedValue([
          { path: "new-note.md", content: "# New", mtime: new Date().toISOString() },
        ]);

      const result = await orchestrator.status();

      expect(result.localChanges).toHaveLength(1);
      expect(result.localChanges[0]!.path).toBe("new-note.md");
      expect(result.localChanges[0]!.type).toBe("created");
    });
  });

  describe("push - 폴더 계층", () => {
    it("하위 폴더 파일 push 시 폴더 페이지 생성", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "projects/deep/note.md", mtime: now, size: 80 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Deep Note");

      mockNotionClient.listChildren.mockResolvedValue({ results: [] });

      const result = await orchestrator.push();

      expect(result.created).toBe(1);
      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalled();
    });

    it("다중 파일 동시 push", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "a.md", mtime: now, size: 30 },
        { path: "b.md", mtime: now, size: 30 },
        { path: "c.md", mtime: now, size: 30 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
        const map: Record<string, string> = { "a.md": "# A", "b.md": "# B", "c.md": "# C" };
        return map[p] ?? "";
      });

      const result = await orchestrator.push();

      expect(result.created).toBe(3);
      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalledTimes(3);
    });
  });

  describe("sync.direction 설정", () => {
    it("direction=pull이면 push가 실행되지 않음", async () => {
      const pullOnlyConfig = {
        ...DEFAULT_CONFIG,
        notion: { ...DEFAULT_CONFIG.notion, token: "ntn_test", rootPageId: "root-id" },
        sync: { ...DEFAULT_CONFIG.sync, direction: "pull" as const },
      };

      const pullOnlyOrchestrator = new SyncOrchestrator(
        pullOnlyConfig,
        mockStateDb as never,
        mockNotionClient as never,
        mockVaultFs,
      );

      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "new.md", mtime: now, size: 30 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# New");

      const result = await pullOnlyOrchestrator.push();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
    });

    it("direction=push이면 pull이 실행되지 않음", async () => {
      const pushOnlyConfig = {
        ...DEFAULT_CONFIG,
        notion: { ...DEFAULT_CONFIG.notion, token: "ntn_test", rootPageId: "root-id" },
        sync: { ...DEFAULT_CONFIG.sync, direction: "push" as const },
      };

      const pushOnlyOrchestrator = new SyncOrchestrator(
        pushOnlyConfig,
        mockStateDb as never,
        mockNotionClient as never,
        mockVaultFs,
      );

      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        { id: "new-page", last_edited_time: "2026-01-01T00:00:00.000Z" },
      ]);

      const result = await pushOnlyOrchestrator.pull();

      expect(result.created).toBe(0);
      expect(mockVaultFs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe("force 옵션", () => {
    it("force=true이면 충돌 파일도 push", async () => {
      mockStateDb.getByStatus.mockReturnValue([
        { obsidianPath: "conflict.md", notionPageId: "page-c", id: "rec-c", status: "conflict" },
      ]);

      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "conflict.md", mtime: now, size: 60 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Conflict");

      const result = await orchestrator.push({ force: true });

      expect(result.created).toBe(1);
    });
  });

  describe("dryRun 실제 수량", () => {
    it("push dryRun — created/updated/deleted 수량 반환", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "new1.md", mtime: now, size: 40 },
        { path: "new2.md", mtime: now, size: 40 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) =>
        p === "new1.md" ? "# New1" : "# New2",
      );

      const result = await orchestrator.push({ dryRun: true });

      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
    });
  });

  describe("in_progress 클린업", () => {
    it("push 시작 시 이전 중단된 플래그 정리", async () => {
      mockStateDb.getMeta.mockImplementation((key: string) => {
        if (key === "push_in_progress") return "true";
        return null;
      });

      await orchestrator.push();

      expect(mockStateDb.setMeta).toHaveBeenCalledWith("push_in_progress", "");
    });
  });
});
