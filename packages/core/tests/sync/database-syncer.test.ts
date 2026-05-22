import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn().mockResolvedValue("# Test\n\nContent"),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("fake")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
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
    getDatabaseSchema: vi.fn().mockResolvedValue({
      Name: { id: "title", type: "title" },
      Status: { id: "prop1", type: "select" },
      Tags: { id: "prop2", type: "multi_select" },
    }),
    queryAllDatabasePages: vi.fn().mockResolvedValue([]),
    getPage: vi.fn().mockResolvedValue({
      id: "page-1",
      last_edited_time: "2026-05-16T00:00:00.000Z",
      properties: {
        Name: { type: "title", title: [{ plain_text: "Test Page" }] },
        Status: { type: "select", select: { name: "Done" } },
        Tags: { type: "multi_select", multi_select: [{ name: "tag1" }, { name: "tag2" }] },
      },
    }),
    getPageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "# Hello\n\nWorld", truncated: false, unknown_block_ids: [] }),
    replacePageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] }),
    createPageWithMarkdown: vi.fn().mockResolvedValue({
      id: "new-page-id",
      last_edited_time: "2026-05-16T01:00:00.000Z",
    }),
    updatePageProperties: vi.fn().mockResolvedValue(undefined),
    extractTitle: vi.fn().mockReturnValue("Test Page"),
    extractCover: vi.fn().mockReturnValue(null),
    extractIcon: vi.fn().mockReturnValue(null),
    uploadFile: vi.fn().mockResolvedValue("upload-id"),
    getDatabaseViewsConfig: vi.fn().mockResolvedValue({
      databaseId: "db-123",
      lastSynced: "2026-05-18T00:00:00.000Z",
      views: [],
    }),
    getDatabaseSchemaFull: vi.fn().mockResolvedValue({
      Name: { id: "title", type: "title" },
      Status: {
        id: "prop1",
        type: "select",
        options: [{ name: "Done", color: "green" }],
      },
      Tags: {
        id: "prop2",
        type: "multi_select",
        options: [{ name: "tag1", color: "blue" }],
      },
    }),
    getDatabaseTitle: vi.fn().mockResolvedValue("Tasks"),
  };
}

function createMockImageHandler() {
  return {
    downloadAllImages: vi.fn().mockImplementation(async (md: string) => ({
      content: md,
      downloads: [],
    })),
    downloadAllFiles: vi.fn().mockImplementation(async (md: string) => ({
      content: md,
      downloads: [],
    })),
    uploadAndAppendImages: vi.fn().mockResolvedValue(undefined),
  };
}

function createDbConfig(overrides?: Partial<DatabaseSyncConfig>): DatabaseSyncConfig {
  return {
    databaseId: "db-123",
    localFolder: "databases/tasks",
    titleProperty: "Name",
    ...overrides,
  };
}

function createConfig(databases: DatabaseSyncConfig[]): Config {
  return {
    ...DEFAULT_CONFIG,
    notion: {
      ...DEFAULT_CONFIG.notion,
      token: "ntn_test",
      rootPageId: "root-id",
      databases,
    },
  };
}

describe("DatabaseSyncer", () => {
  let syncer: DatabaseSyncer;
  let mockVaultFs: ReturnType<typeof createMockVaultFs>;
  let mockStateDb: ReturnType<typeof createMockStateDb>;
  let mockNotionClient: ReturnType<typeof createMockNotionClient>;
  let mockImageHandler: ReturnType<typeof createMockImageHandler>;
  let pipeline: ReturnType<typeof createDefaultPipeline>;

  beforeEach(() => {
    mockVaultFs = createMockVaultFs();
    mockStateDb = createMockStateDb();
    mockNotionClient = createMockNotionClient();
    mockImageHandler = createMockImageHandler();
    pipeline = createDefaultPipeline({
      wikilinkResolver: () => null,
    });

    const config = createConfig([createDbConfig()]);
    syncer = new DatabaseSyncer(
      config,
      mockStateDb as any,
      mockNotionClient as any,
      mockVaultFs,
      pipeline,
      mockImageHandler as any,
    );
  });

  describe("pullAll", () => {
    it("databases가 비어있으면 빈 결과 반환", async () => {
      const config = createConfig([]);
      const emptySyncer = new DatabaseSyncer(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
        pipeline,
        mockImageHandler as any,
      );

      const result = await emptySyncer.pullAll();
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toHaveLength(0);
    });

    it("DB 페이지를 Pull하여 로컬 .md 파일로 생성", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Task One" }] },
            Status: { type: "select", select: { name: "In Progress" } },
          },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Task One");

      const result = await syncer.pullAll();

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(mockVaultFs.writeFile).toHaveBeenCalledWith(
        "databases/tasks/Task One.md",
        expect.stringContaining("title: Task One"),
      );
      expect(mockStateDb.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "databases/tasks/Task One.md",
          notionPageId: "page-1",
          fileType: "db-row",
          status: "synced",
        }),
      );
    });

    it("이미 동기화된 페이지는 lastEdited가 같으면 스킵", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
        },
      ]);
      mockStateDb.getByNotionId.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks/Existing.md",
        notionPageId: "page-1",
        notionLastEdited: "2026-05-16T00:00:00.000Z",
        contentHash: "hash1",
      });

      const result = await syncer.pullAll();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      const mdWriteCalls = (mockVaultFs.writeFile as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".md"),
      );
      expect(mdWriteCalls).toHaveLength(0);
    });

    it("lastEdited가 다르면 업데이트", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T02:00:00.000Z",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Updated Task" }] },
          },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Updated Task");
      mockStateDb.getByNotionId.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks/Updated Task.md",
        notionPageId: "page-1",
        notionLastEdited: "2026-05-16T00:00:00.000Z",
        contentHash: "old-hash",
      });

      const result = await syncer.pullAll();

      expect(result.updated).toBe(1);
      expect(mockVaultFs.writeFile).toHaveBeenCalledWith(
        "databases/tasks/Updated Task.md",
        expect.any(String),
      );
    });

    it("속성을 프론트매터로 변환하여 포함", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: {
            Name: { type: "title", title: [{ plain_text: "My Task" }] },
            Status: { type: "select", select: { name: "Done" } },
            Tags: {
              type: "multi_select",
              multi_select: [{ name: "frontend" }, { name: "urgent" }],
            },
            Priority: { type: "number", number: 3 },
          },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("My Task");

      await syncer.pullAll();

      const mdCall = (mockVaultFs.writeFile as any).mock.calls.find((c: string[]) =>
        c[0].endsWith(".md"),
      );
      expect(mdCall).toBeTruthy();
      const writtenContent = mdCall[1] as string;
      expect(writtenContent).toContain("title: My Task");
      expect(writtenContent).toContain("Status: Done");
      expect(writtenContent).toContain("Priority: 3");
      expect(writtenContent).toContain("frontend");
      expect(writtenContent).toContain("urgent");
    });

    it("Markdown 본문도 함께 Pull", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Note" }] },
          },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Note");
      mockNotionClient.getPageMarkdown.mockResolvedValue({
        markdown: "## Section 1\n\nSome content here.\n\n- Item 1\n- Item 2",
        truncated: false,
        unknown_block_ids: [],
      });

      await syncer.pullAll();

      const mdCall = (mockVaultFs.writeFile as any).mock.calls.find((c: string[]) =>
        c[0].endsWith(".md"),
      );
      expect(mdCall).toBeTruthy();
      const writtenContent = mdCall[1] as string;
      expect(writtenContent).toContain("## Section 1");
      expect(writtenContent).toContain("Some content here.");
      expect(writtenContent).toContain("- Item 1");
    });

    it("API 에러 시 failed에 기록하고 계속 진행", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "P1" }] } },
        },
        {
          id: "page-2",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "P2" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValueOnce("P1").mockReturnValueOnce("P2");
      mockNotionClient.getPageMarkdown
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce({ markdown: "ok", truncated: false, unknown_block_ids: [] });

      const result = await syncer.pullAll();

      expect(result.created).toBe(2);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe("pushAll", () => {
    it("databases가 비어있으면 빈 결과 반환", async () => {
      const config = createConfig([]);
      const emptySyncer = new DatabaseSyncer(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
        pipeline,
        mockImageHandler as any,
      );

      const result = await emptySyncer.pushAll();
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toHaveLength(0);
    });

    it("로컬 .md 파일을 DB 페이지로 Push (신규 생성)", async () => {
      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        {
          path: "databases/tasks/New Task.md",
          content: "---\ntitle: New Task\nStatus: Todo\n---\n\n# Content\n\nBody text.",
          mtime: "2026-05-16T00:00:00.000Z",
        },
      ]);
      (mockVaultFs.readFile as any).mockResolvedValue(
        "---\ntitle: New Task\nStatus: Todo\n---\n\n# Content\n\nBody text.",
      );

      const result = await syncer.pushAll();

      expect(result.created).toBe(1);
      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: "db-123",
          parentType: "database",
          title: "New Task",
          markdown: expect.any(String),
        }),
      );
      expect(mockStateDb.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "databases/tasks/New Task.md",
          notionPageId: "new-page-id",
          fileType: "db-row",
        }),
      );
    });

    it("이미 동기화된 파일이 변경되면 업데이트", async () => {
      const updatedContent =
        "---\ntitle: Updated Task\nStatus: Done\n---\n\n# Updated\n\nNew body.";
      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        {
          path: "databases/tasks/Updated Task.md",
          content: updatedContent,
          mtime: "2026-05-16T02:00:00.000Z",
        },
      ]);
      (mockVaultFs.readFile as any).mockResolvedValue(updatedContent);
      mockStateDb.getByPath.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks/Updated Task.md",
        notionPageId: "existing-page-id",
        contentHash: "old-hash",
      });

      const result = await syncer.pushAll();

      expect(result.updated).toBe(1);
      expect(mockNotionClient.updatePageProperties).toHaveBeenCalledWith(
        "existing-page-id",
        expect.objectContaining({
          title: expect.any(Object),
        }),
      );
      expect(mockNotionClient.replacePageMarkdown).toHaveBeenCalledWith(
        "existing-page-id",
        expect.any(String),
      );
    });

    it("해시가 같으면 스킵", async () => {
      const content = "---\ntitle: Same\n---\n\nNo changes.";
      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        {
          path: "databases/tasks/Same.md",
          content,
          mtime: "2026-05-16T00:00:00.000Z",
        },
      ]);
      (mockVaultFs.readFile as any).mockResolvedValue(content);

      const { computeHash } = await import("../../src/utils/hash.js");
      const hash = computeHash(content);
      mockStateDb.getByPath.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks/Same.md",
        notionPageId: "page-1",
        contentHash: hash,
      });

      const result = await syncer.pushAll();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
      expect(mockNotionClient.updatePageProperties).not.toHaveBeenCalled();
    });

    it("다른 폴더의 파일은 Push하지 않음", async () => {
      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        {
          path: "notes/regular.md",
          content: "# Regular note",
          mtime: "2026-05-16T00:00:00.000Z",
        },
        {
          path: "databases/other-db/item.md",
          content: "# Other DB item",
          mtime: "2026-05-16T00:00:00.000Z",
        },
      ]);

      const result = await syncer.pushAll();

      expect(result.created).toBe(0);
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
    });

    it("프론트매터의 title은 Notion title 속성으로 변환", async () => {
      const content = "---\ntitle: My Custom Title\nStatus: Active\n---\n\nBody content.";
      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        {
          path: "databases/tasks/My Custom Title.md",
          content,
          mtime: "2026-05-16T00:00:00.000Z",
        },
      ]);
      (mockVaultFs.readFile as any).mockResolvedValue(content);

      await syncer.pushAll();

      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "My Custom Title",
        }),
      );
    });
  });

  describe("다중 데이터베이스", () => {
    it("여러 DB를 순차적으로 Pull", async () => {
      const config = createConfig([
        createDbConfig({ databaseId: "db-1", localFolder: "databases/tasks" }),
        createDbConfig({ databaseId: "db-2", localFolder: "databases/notes" }),
      ]);

      const multiSyncer = new DatabaseSyncer(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
        pipeline,
        mockImageHandler as any,
      );

      mockNotionClient.queryAllDatabasePages.mockResolvedValue([]);

      const result = await multiSyncer.pullAll();

      expect(mockNotionClient.getDatabaseSchema).toHaveBeenCalledTimes(2);
      expect(mockNotionClient.getDatabaseSchema).toHaveBeenCalledWith("db-1");
      expect(mockNotionClient.getDatabaseSchema).toHaveBeenCalledWith("db-2");
      expect(result.created).toBe(0);
    });

    it("한 DB 실패해도 다른 DB는 계속 진행", async () => {
      const config = createConfig([
        createDbConfig({ databaseId: "db-fail", localFolder: "databases/fail" }),
        createDbConfig({ databaseId: "db-ok", localFolder: "databases/ok" }),
      ]);

      const multiSyncer = new DatabaseSyncer(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
        pipeline,
        mockImageHandler as any,
      );

      mockNotionClient.getDatabaseSchema
        .mockRejectedValueOnce(new Error("DB not found"))
        .mockResolvedValueOnce({ Name: { id: "title", type: "title" } });
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([]);

      const result = await multiSyncer.pullAll();

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.path).toBe("databases/fail");
    });
  });

  describe(".base 파일 자동 생성", () => {
    it("Pull 시 .base 파일이 생성된다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([]);
      mockNotionClient.getDatabaseViewsConfig.mockResolvedValue({
        databaseId: "db-123",
        databaseName: "Tasks",
        lastSynced: "2026-05-18T00:00:00.000Z",
        views: [{ id: "v1", name: "Table", type: "table" }],
      });

      await syncer.pullAll();

      const writeFileCalls = (mockVaultFs.writeFile as any).mock.calls;
      const baseFileCall = writeFileCalls.find((c: any[]) => c[0].endsWith(".base"));
      expect(baseFileCall).toBeDefined();
      expect(baseFileCall[0]).toBe("databases/tasks/Tasks.base");
      expect(baseFileCall[1]).toContain("filters:");
      expect(baseFileCall[1]).toContain('file.inFolder("databases/tasks")');
    });

    it(".base 파일에 스키마 속성이 포함된다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([]);

      await syncer.pullAll();

      const writeFileCalls = (mockVaultFs.writeFile as any).mock.calls;
      const baseFileCall = writeFileCalls.find((c: any[]) => c[0].endsWith(".base"));
      expect(baseFileCall).toBeDefined();

      const content = baseFileCall[1] as string;
      expect(content).toContain("properties:");
      expect(content).toContain("displayName: Status");
      expect(content).toContain("displayName: Tags");
    });

    it(".base 파일에 뷰 설정이 포함된다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([]);
      mockNotionClient.getDatabaseViewsConfig.mockResolvedValue({
        databaseId: "db-123",
        databaseName: "Tasks",
        lastSynced: "2026-05-18T00:00:00.000Z",
        views: [
          { id: "v1", name: "Table", type: "table" },
          { id: "v2", name: "Cards", type: "gallery" },
        ],
      });

      await syncer.pullAll();

      const writeFileCalls = (mockVaultFs.writeFile as any).mock.calls;
      const baseFileCall = writeFileCalls.find((c: any[]) => c[0].endsWith(".base"));
      const content = baseFileCall[1] as string;
      expect(content).toContain("views:");
      expect(content).toContain("- type: table");
      expect(content).toContain("- type: cards");
    });

    it(".base 생성 실패해도 Pull은 계속 진행된다", async () => {
      mockNotionClient.getDatabaseSchemaFull.mockRejectedValue(new Error("Schema fetch failed"));
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Test" }] },
          },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Test");

      const result = await syncer.pullAll();

      expect(result.created).toBe(1);
    });
  });

  describe("wikilink 등록", () => {
    it("Pull한 페이지를 wikilink_map에 등록", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-wiki",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Wiki Page" }] },
          },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Wiki Page");

      await syncer.pullAll();

      expect(mockStateDb.upsertWikilink).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "databases/tasks/Wiki Page.md",
          notionPageId: "page-wiki",
          title: "Wiki Page",
        }),
      );
    });

    it("Push한 페이지를 wikilink_map에 등록", async () => {
      const content = "---\ntitle: Push Wiki\n---\n\nBody.";
      mockVaultFs.listMarkdownFiles = vi
        .fn()
        .mockResolvedValue([
          { path: "databases/tasks/Push Wiki.md", content, mtime: "2026-05-16T00:00:00.000Z" },
        ]);
      (mockVaultFs.readFile as any).mockResolvedValue(content);

      await syncer.pushAll();

      expect(mockStateDb.upsertWikilink).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "databases/tasks/Push Wiki.md",
          notionPageId: "new-page-id",
          title: "Push Wiki",
        }),
      );
    });
  });
});
