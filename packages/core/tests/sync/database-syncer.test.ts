import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { computeHash } from "../../src/utils/hash.js";

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
    deleteWikilink: vi.fn(),
    updateHash: vi.fn(),
    updateStatus: vi.fn(),
    setNotionLastEdited: vi.fn(),
    updatePath: vi.fn(),
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
    // 실제 구현은 notion-hosted 가 아니거나 실패 시 null (P3-A)
    localizeNotionFileUrl: vi.fn().mockResolvedValue(null),
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

  describe("baseFileInfo — 실제 .base 경로 기록 (F22 SSOT)", () => {
    it("pull 후 dbId(nohyph)→실제 .base 경로/제목이 기록된다 — 파일명은 sanitizeFileName(제목)", async () => {
      // 제목 "0. 인박스": 폴더 새니타이저는 "0-인박스"(점 제거·공백→하이픈)로 바꾸지만
      // .base 파일명은 sanitizeFileName 이라 "0. 인박스.base" — 두 규칙이 달라 폴더명으로
      // 추측한 임베드는 깨진다(E2E 실측 91/158건). 실경로 기록이 유일한 안전한 출처다.
      mockNotionClient.getDatabaseTitle.mockResolvedValue("0. 인박스");
      const config = createDbConfig({ localFolder: "para/0-인박스" });

      await syncer.pullDatabase(config);

      expect(syncer.baseFileInfo.get("db123")).toEqual({
        basePath: "para/0-인박스/0. 인박스.base",
        title: "0. 인박스",
      });
      expect(mockVaultFs.writeFile).toHaveBeenCalledWith(
        "para/0-인박스/0. 인박스.base",
        expect.any(String),
      );
    });
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

    it("lastEdited가 다르고 로컬 미수정이면 업데이트(덮어쓰기)", async () => {
      // 로컬 파일이 마지막 동기화 이후 변경되지 않은 경우(해시 일치) → 안전하게 덮어쓰기
      (mockVaultFs.readFile as any).mockResolvedValue("LOCAL UNCHANGED");
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
        contentHash: computeHash("LOCAL UNCHANGED"),
      });

      const result = await syncer.pullAll();

      expect(result.updated).toBe(1);
      expect(result.conflicts).toHaveLength(0);
      expect(mockVaultFs.writeFile).toHaveBeenCalledWith(
        "databases/tasks/Updated Task.md",
        expect.any(String),
      );
    });

    it("로컬·리모트 동시 수정이면 충돌로 보존 (manual 전략, 데이터 손실 방지)", async () => {
      // 로컬이 마지막 동기화 이후 수정됨(해시 불일치) + 리모트도 변경 → 충돌
      (mockVaultFs.readFile as any).mockResolvedValue("LOCALLY EDITED — 사용자 변경분");
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
        contentHash: "stored-hash-at-last-sync",
        baseSnapshot: Buffer.from("BASE SNAPSHOT", "utf-8"),
      });

      const result = await syncer.pullAll();

      // 업데이트 카운트 0, 충돌 1건, 로컬 .md 덮어쓰기 없음
      expect(result.updated).toBe(0);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.localContent).toBe("LOCALLY EDITED — 사용자 변경분");
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith("rec-1", "conflict");
      const mdWrites = (mockVaultFs.writeFile as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".md"),
      );
      expect(mdWrites).toHaveLength(0);
    });

    it("local-first 전략이면 로컬 수정 시 리모트 변경 스킵", async () => {
      const localFirstConfig = createConfig([createDbConfig()]);
      (localFirstConfig.sync as any).conflictStrategy = "local-first";
      const localSyncer = new DatabaseSyncer(
        localFirstConfig,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
        pipeline,
        mockImageHandler as any,
      );

      (mockVaultFs.readFile as any).mockResolvedValue("LOCALLY EDITED");
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
        contentHash: "stored-hash-at-last-sync",
      });

      const result = await localSyncer.pullAll();

      expect(result.updated).toBe(0);
      expect(result.conflicts).toHaveLength(0);
      const mdWrites = (mockVaultFs.writeFile as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".md"),
      );
      expect(mdWrites).toHaveLength(0);
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

  describe("writtenPaths (M3 — 후처리 대상 실측)", () => {
    it("생성된 행의 실제 경로를 writtenPaths 로 돌려준다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Task One" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Task One");

      const result = await syncer.pullAll();

      expect(result.created).toBe(1);
      // 슬라이스 추정이 아니라 디스크에 실제 기록된 경로 그대로
      expect(result.writtenPaths).toEqual(["databases/tasks/Task One.md"]);
    });

    it("스킵된 행은 writtenPaths 에 포함되지 않는다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        { id: "page-1", last_edited_time: "2026-05-16T00:00:00.000Z" },
      ]);
      mockStateDb.getByNotionId.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks/Existing.md",
        notionPageId: "page-1",
        notionLastEdited: "2026-05-16T00:00:00.000Z",
        contentHash: "hash1",
      });

      const result = await syncer.pullAll();

      expect(result.updated).toBe(0);
      expect(result.writtenPaths).toEqual([]);
    });

    it("업데이트된 행의 경로를 writtenPaths 로 돌려준다", async () => {
      (mockVaultFs.readFile as any).mockResolvedValue("LOCAL UNCHANGED");
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T02:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Updated Task" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Updated Task");
      mockStateDb.getByNotionId.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks/Updated Task.md",
        notionPageId: "page-1",
        notionLastEdited: "2026-05-16T00:00:00.000Z",
        contentHash: computeHash("LOCAL UNCHANGED"),
      });

      const result = await syncer.pullAll();

      expect(result.updated).toBe(1);
      expect(result.writtenPaths).toEqual(["databases/tasks/Updated Task.md"]);
    });

    it("writtenPaths 길이는 항상 created+updated 와 일치한다(불변식)", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "p1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "A" }] } },
        },
        {
          id: "p2",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "B" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValueOnce("A").mockReturnValueOnce("B");

      const result = await syncer.pullAll();

      expect(result.writtenPaths).toHaveLength(result.created + result.updated);
    });
  });

  describe("cover-URL 위키링크 가드", () => {
    function coverContent(): string {
      const calls = (mockVaultFs.writeFile as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".md"),
      );
      return calls.map((c: any[]) => String(c[1])).join("\n");
    }

    it("notion-hosted 커버는 로컬라이즈해 위키링크로 감싼다 (서명 URL 잔존 금지)", async () => {
      // 회귀: 기존 구현은 downloadAllImages 결과를 `![cover](..)` 마크다운으로 재매치
      // 했지만 성공 시 실제 결과는 `![[..]]` 위키링크 — 항상 미스매치 → 다운로드까지
      // 해놓고 frontmatter 에는 만료 서명 URL 이 남았다(실측: LIFE/WORK).
      mockNotionClient.extractCover.mockReturnValue({
        url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/cover.png?X-Amz-Signature=x",
      });
      (mockImageHandler.localizeNotionFileUrl as any).mockResolvedValue(
        "attachments/Task One-cover.png",
      );
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Task One" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Task One");

      await syncer.pullAll();

      const content = coverContent();
      expect(content).toContain("[[attachments/Task One-cover.png]]");
      expect(content).not.toContain("X-Amz");
      expect(mockImageHandler.localizeNotionFileUrl).toHaveBeenCalledWith(
        "https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/cover.png?X-Amz-Signature=x",
        "Task One-cover",
      );
    });

    it("외부 커버(unsplash 등)는 평문 URL 로 두고 `[[..]]` 로 감싸지 않는다", async () => {
      // 회귀: 원격 https URL 을 `[[https://..]]` 로 감싸면 존재하지 않는 파일을 가리키는
      // 깨진 위키링크가 된다(cover-URL). localizeNotionFileUrl 은 외부 URL 에 null 반환.
      mockNotionClient.extractCover.mockReturnValue({ url: "https://notion.so/remote-cover.png" });
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Task One" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Task One");

      await syncer.pullAll();

      const content = coverContent();
      expect(content).not.toContain("[[https://");
      expect(content).toContain("https://notion.so/remote-cover.png");
    });
  });

  describe("F24 — 동명 DB 폴더 분리 후 행 재배치", () => {
    it("레코드 경로가 현 DB 폴더 밖이면 원격 무변경이어도 현 폴더로 재배치한다", async () => {
      // 옛 공유 폴더의 id 접미사 파일 → 새 폴더의 자연 이름으로 이동 + 레코드/위키링크 이전
      (mockVaultFs.readFile as any).mockResolvedValue("LOCAL UNCHANGED");
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Task One" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Task One");
      mockStateDb.getByNotionId.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks-shared/Task One (0db13b18).md",
        notionPageId: "page-1",
        notionLastEdited: "2026-05-16T00:00:00.000Z",
        contentHash: computeHash("LOCAL UNCHANGED"),
      });

      const result = await syncer.pullAll();

      expect(result.updated).toBe(1);
      expect(mockVaultFs.writeFile).toHaveBeenCalledWith(
        "databases/tasks/Task One.md",
        expect.any(String),
      );
      expect(mockStateDb.updatePath).toHaveBeenCalledWith("rec-1", "databases/tasks/Task One.md");
      expect(mockStateDb.deleteWikilink).toHaveBeenCalledWith(
        "databases/tasks-shared/Task One (0db13b18).md",
      );
      expect(mockVaultFs.deleteFile).toHaveBeenCalledWith(
        "databases/tasks-shared/Task One (0db13b18).md",
      );
      expect(mockStateDb.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "databases/tasks/Task One.md",
          notionPageId: "page-1",
        }),
      );
    });

    it("재배치 대상이라도 로컬이 수정됐으면(local-first) 원위치를 보존한다", async () => {
      (mockVaultFs.readFile as any).mockResolvedValue("LOCALLY EDITED");
      const config: Config = {
        ...createConfig([createDbConfig()]),
        sync: { ...DEFAULT_CONFIG.sync, conflictStrategy: "local-first" },
      };
      const localFirstSyncer = new DatabaseSyncer(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
        pipeline,
        mockImageHandler as any,
      );
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Task One" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Task One");
      mockStateDb.getByNotionId.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks-shared/Task One (0db13b18).md",
        notionPageId: "page-1",
        notionLastEdited: "2026-05-16T00:00:00.000Z",
        contentHash: "different-hash",
      });

      const result = await localFirstSyncer.pullAll();

      expect(result.updated).toBe(0);
      const mdWrites = (mockVaultFs.writeFile as any).mock.calls.filter((c: any[]) =>
        String(c[0]).endsWith(".md"),
      );
      expect(mdWrites).toHaveLength(0);
      expect(mockVaultFs.deleteFile).not.toHaveBeenCalled();
      expect(mockStateDb.updatePath).not.toHaveBeenCalled();
    });

    it("직속 경로 레코드는 재배치 없이 기존 fast-path 로 스킵된다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        { id: "page-1", last_edited_time: "2026-05-16T00:00:00.000Z" },
      ]);
      mockStateDb.getByNotionId.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks/Existing.md",
        notionPageId: "page-1",
        notionLastEdited: "2026-05-16T00:00:00.000Z",
        contentHash: "hash1",
      });

      const result = await syncer.pullAll();

      expect(result.updated).toBe(0);
      expect(mockStateDb.updatePath).not.toHaveBeenCalled();
      const mdWrites = (mockVaultFs.writeFile as any).mock.calls.filter((c: any[]) =>
        String(c[0]).endsWith(".md"),
      );
      expect(mdWrites).toHaveLength(0);
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
      // 업데이트 시에도 제목/별칭 변경 반영을 위해 wikilink 를 갱신한다
      expect(mockStateDb.upsertWikilink).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "databases/tasks/Updated Task.md",
          notionPageId: "existing-page-id",
          title: "Updated Task",
        }),
      );
    });

    it("본문 push 실패 시 synced 미표시·해시 미전진 (거짓 synced 방지)", async () => {
      const updatedContent = "---\ntitle: Updated Task\n---\n\n# Updated\n\nNew body.";
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
      // Markdown 본문 push 가 실패하는 상황 시뮬레이션
      mockNotionClient.replacePageMarkdown.mockRejectedValueOnce(new Error("Markdown API 500"));

      const result = await syncer.pushAll();

      // 업데이트 카운트 0, 실패 1건(operation=update)
      expect(result.updated).toBe(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.operation).toBe("update");
      // 해시를 전진시키지 않고 synced 로 표시하지 않으며 error 로 표시
      expect(mockStateDb.updateHash).not.toHaveBeenCalled();
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith("rec-1", "error");
      expect(mockStateDb.updateStatus).not.toHaveBeenCalledWith("rec-1", "synced");
    });

    it("로컬 rename 시 중복 페이지 생성 대신 기존 페이지 재매핑", async () => {
      const content = "---\ntitle: Renamed Task\n---\n\nUnchanged body.";
      const hash = computeHash(content);
      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        {
          path: "databases/tasks/Renamed Task.md",
          content,
          mtime: "2026-05-16T02:00:00.000Z",
        },
      ]);
      (mockVaultFs.readFile as any).mockResolvedValue(content);
      // 새 경로엔 추적 레코드 없음(rename 직후)
      mockStateDb.getByPath.mockReturnValue(null);
      // 고아 레코드: 같은 DB·같은 내용 해시·사라진 이전 경로
      mockStateDb.getAll.mockReturnValue([
        {
          id: "rec-old",
          obsidianPath: "databases/tasks/Old Name.md",
          notionPageId: "existing-page-id",
          notionParentId: "db-123",
          contentHash: hash,
          fileType: "db-row",
        },
      ]);

      const result = await syncer.pushAll();

      // 신규 페이지 생성하지 않고 업데이트(이동)로 집계
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      // 레코드 경로 재매핑 + wikilink 새 경로 갱신(pageId 유지)
      expect(mockStateDb.updatePath).toHaveBeenCalledWith(
        "rec-old",
        "databases/tasks/Renamed Task.md",
      );
      expect(mockStateDb.upsertWikilink).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "databases/tasks/Renamed Task.md",
          notionPageId: "existing-page-id",
        }),
      );
    });

    it("내용이 다르면 rename 으로 보지 않고 신규 생성", async () => {
      const content = "---\ntitle: Brand New\n---\n\nCompletely different.";
      mockVaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        {
          path: "databases/tasks/Brand New.md",
          content,
          mtime: "2026-05-16T02:00:00.000Z",
        },
      ]);
      (mockVaultFs.readFile as any).mockResolvedValue(content);
      mockStateDb.getByPath.mockReturnValue(null);
      // 고아는 있으나 해시가 다름 → rename 아님
      mockStateDb.getAll.mockReturnValue([
        {
          id: "rec-old",
          obsidianPath: "databases/tasks/Old Name.md",
          notionPageId: "existing-page-id",
          notionParentId: "db-123",
          contentHash: "different-hash",
          fileType: "db-row",
        },
      ]);

      const result = await syncer.pushAll();

      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalledTimes(1);
      expect(result.created).toBe(1);
      expect(mockStateDb.updatePath).not.toHaveBeenCalled();
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

    it("사이드카가 디스크와 동일 바이트면 재기록하지 않는다 (degrade 로그 중복 제거)", async () => {
      // 같은 DB 가 한 번의 pull 에서 임베드 재작성 때마다 재생성돼(실측 최대 67회)
      // degrade 로그가 그만큼 반복됐다 — 동일 바이트면 쓰기·로그 모두 생략한다.
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([]);
      await syncer.pullAll();

      const sidecarCall = (mockVaultFs.writeFile as any).mock.calls.find((c: any[]) =>
        String(c[0]).endsWith(".notion.json"),
      );
      expect(sidecarCall).toBeDefined();

      (mockVaultFs.readFile as any).mockImplementation(async (p: string) =>
        p.endsWith(".notion.json") ? sidecarCall[1] : "# Test\n\nContent",
      );
      (mockVaultFs.writeFile as any).mockClear();
      await syncer.pullAll();

      const rewrites = (mockVaultFs.writeFile as any).mock.calls.filter((c: any[]) =>
        String(c[0]).endsWith(".notion.json"),
      );
      expect(rewrites).toHaveLength(0);
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

  describe("F25 — linked view 컨테이너 행 소유 양보", () => {
    // 실측(E2E): 원본이 공유 범위에 있으면 linked view 컨테이너도 data_sources 가 채워져
    // 캐시에 원본처럼 오등록된다. 행 parent.database_id 는 항상 원본이므로 이것으로 판정한다.
    const linkedPage = (id: string, title: string, ownerDbId: string) => ({
      id,
      last_edited_time: "2026-05-16T00:00:00.000Z",
      parent: { type: "data_source_id", data_source_id: "ds-1", database_id: ownerDbId },
      properties: {
        Name: { type: "title", title: [{ plain_text: title }] },
      },
    });

    it("행 parent 가 다른 DB 면 행 처리를 건너뛰고 linkedOriginalDbId 를 반환한다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        linkedPage("row-1", "달리기", "db-original"),
      ]);
      mockNotionClient.extractTitle.mockReturnValue("달리기");
      const config = createDbConfig({ databaseId: "db-linked", localFolder: "루틴/습관-목록" });

      const result = await syncer.pullDatabase(config, {
        resolveDbFolder: (dbId) => (dbId === "db-original" ? "루틴/목록" : null),
      });

      expect(result.linkedOriginalDbId).toBe("db-original");
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      const mdWriteCalls = (mockVaultFs.writeFile as any).mock.calls.filter((c: any[]) =>
        String(c[0]).endsWith(".md"),
      );
      expect(mdWriteCalls).toHaveLength(0);
      expect(mockStateDb.upsert).not.toHaveBeenCalled();
    });

    it("컨테이너의 .base 는 원본 폴더 필터로 재지향돼 빈 뷰가 되지 않는다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        linkedPage("row-1", "달리기", "db-original"),
      ]);
      const config = createDbConfig({ databaseId: "db-linked", localFolder: "루틴/습관-목록" });

      await syncer.pullDatabase(config, {
        resolveDbFolder: () => "루틴/목록",
      });

      const baseWrite = (mockVaultFs.writeFile as any).mock.calls.find((c: any[]) =>
        String(c[0]).endsWith(".base"),
      );
      expect(baseWrite).toBeDefined();
      expect(baseWrite![0]).toBe("루틴/습관-목록/Tasks.base");
      expect(baseWrite![1]).toContain('file.inFolder("루틴/목록")');
    });

    it("원본 폴더를 모르면(미발견) 유일한 접근 통로이므로 기존대로 행을 소유한다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        linkedPage("row-1", "달리기", "db-unknown"),
      ]);
      mockNotionClient.extractTitle.mockReturnValue("달리기");
      const config = createDbConfig({ databaseId: "db-linked", localFolder: "루틴/습관-목록" });

      const result = await syncer.pullDatabase(config, { resolveDbFolder: () => null });

      expect(result.linkedOriginalDbId).toBeUndefined();
      expect(result.created).toBe(1);
      expect(mockVaultFs.writeFile).toHaveBeenCalledWith(
        "루틴/습관-목록/달리기.md",
        expect.any(String),
      );
    });

    it("행 parent 가 자기 자신이면(원본) 판정 없이 정상 처리한다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        linkedPage("row-1", "달리기", "db-123"),
      ]);
      mockNotionClient.extractTitle.mockReturnValue("달리기");

      const result = await syncer.pullDatabase(createDbConfig(), {
        resolveDbFolder: () => {
          throw new Error("원본 config 에서는 호출되지 않아야 한다");
        },
      });

      expect(result.linkedOriginalDbId).toBeUndefined();
      expect(result.created).toBe(1);
    });

    it("resolveDbFolder 미주입(명시 설정 경로)이면 기존 동작을 유지한다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        linkedPage("row-1", "달리기", "db-original"),
      ]);
      mockNotionClient.extractTitle.mockReturnValue("달리기");

      const result = await syncer.pullDatabase(createDbConfig());

      expect(result.linkedOriginalDbId).toBeUndefined();
      expect(result.created).toBe(1);
    });
  });
});
