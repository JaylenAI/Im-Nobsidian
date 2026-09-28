import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { computeHash } from "../../src/utils/hash.js";
import { remoteBodyFingerprint } from "../../src/sync/remote-observation.js";
import { settledObservation } from "../helpers/mock-orchestrator.js";

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
    getFileStat: vi.fn().mockResolvedValue(null),
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
    setRemoteObservation: vi.fn(),
    setNotionBodyFingerprint: vi.fn(),
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
    restoreUploadedMedia: vi.fn().mockImplementation(async (md: string) => md),
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
        ...settledObservation("2026-05-16T00:00:00.000Z"),
        contentHash: "hash1",
      });
      (mockVaultFs.exists as any).mockResolvedValue(true);

      const result = await syncer.pullAll();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toEqual([]);
      const mdWriteCalls = (mockVaultFs.writeFile as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".md"),
      );
      expect(mdWriteCalls).toHaveLength(0);
      // 본문을 읽지 않는다 — 건너뛰는 행은 조회 1건 비용이다
      expect(mockNotionClient.getPageMarkdown).not.toHaveBeenCalled();
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

    it("올린 미디어는 행 id · 노트 경로로 먼저 되찾고 남은 것만 내려받는다(S-05)", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([
        {
          id: "page-1",
          last_edited_time: "2026-05-16T00:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Note" }] } },
        },
      ]);
      mockNotionClient.extractTitle.mockReturnValue("Note");
      mockNotionClient.getPageMarkdown.mockResolvedValue({
        markdown: "![](https://prod-files-secure.s3.us-west-2.amazonaws.com/s/f/a.png)",
        truncated: false,
        unknown_block_ids: [],
      });
      mockImageHandler.restoreUploadedMedia.mockResolvedValue("![[assets/a.png|300]]");

      await syncer.pullAll();

      const mdCall = (mockVaultFs.writeFile as any).mock.calls.find((c: string[]) =>
        c[0].endsWith(".md"),
      );
      expect(mockImageHandler.restoreUploadedMedia).toHaveBeenCalledWith(
        expect.stringContaining("prod-files-secure"),
        "page-1",
        mdCall[0],
      );
      expect(mockImageHandler.downloadAllImages).toHaveBeenCalledWith(
        "![[assets/a.png|300]]",
        "Note",
        "page-1",
      );
      expect(mdCall[1]).toContain("![[assets/a.png|300]]");
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

      // 본문을 못 읽은 행은 빈 본문으로 만들지 않고 실패로 남긴다(S-10). 예전 기대값
      // (created 2 · failed 0)은 제목과 반대로 그 유실을 잠그고 있었다.
      expect(result.created).toBe(1);
      expect(result.failed).toEqual([
        expect.objectContaining({ path: "databases/tasks/page-1", error: "API error" }),
      ]);
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
        ...settledObservation("2026-05-16T00:00:00.000Z"),
        contentHash: "hash1",
      });
      (mockVaultFs.exists as any).mockResolvedValue(true);

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

  describe("같은 분 안의 원격 편집 (N-05)", () => {
    // Notion 은 수정 시각을 분 단위로 자른다. 우리가 본 «뒤» 같은 분 안에서 고친 행은 시각이
    // 그대로라, 시각만 보고 건너뛰면 영영 받지 못했다.
    const T = "2026-05-16T00:00:00.000Z";
    const PATH = "databases/tasks/Task One.md";
    const BOT = "bot-user-id";
    const HUMAN = "human-user-id";
    /** 이번 실행이 시작한 때 — T 의 분이 아직 가라앉지 않았다. */
    const SEEN_NOW = "2026-05-16T00:00:30.000Z";

    const row = (editor: string) => ({
      id: "page-1",
      last_edited_time: T,
      last_edited_by: { object: "user", id: editor },
      properties: { Name: { type: "title", title: [{ plain_text: "Task One" }] } },
    });

    const observing = (botUserId: string | null = BOT, config = createConfig([createDbConfig()])) =>
      new DatabaseSyncer(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
        pipeline,
        mockImageHandler as any,
        () => ({ seenAt: SEEN_NOW, botUserId }),
      );

    /** 같은 분 안에 앞서 받아 둔 행 — 로컬 사본은 그때 받은 내용이다. */
    const recordOf = (
      content: string,
      editor: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: "rec-1",
      obsidianPath: PATH,
      notionPageId: "page-1",
      notionLastEdited: T,
      notionLastEditedBy: editor,
      notionSeenAt: "2026-05-16T00:00:10.000Z",
      notionBodyFingerprint: null,
      contentHash: computeHash(content),
      baseSnapshot: Buffer.from(content, "utf-8"),
      localLastModified: T,
      syncDirection: "both",
      fileType: "db-row",
      status: "synced",
      localMtime: null,
      localFileSize: null,
      ...overrides,
    });

    const mdWrites = () =>
      (mockVaultFs.writeFile as any).mock.calls.filter((c: any[]) => String(c[0]).endsWith(".md"));

    /** 행을 처음 받아 로컬 사본을 얻는다 — 그 뒤의 호출 기록은 비운다. */
    async function firstPull(): Promise<string> {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([row(HUMAN)]);
      mockNotionClient.extractTitle.mockReturnValue("Task One");
      await observing().pullAll();
      const content = String(mdWrites()[0]![1]);
      vi.clearAllMocks();
      (mockVaultFs.readFile as any).mockResolvedValue(content);
      (mockVaultFs.exists as any).mockResolvedValue(true);
      return content;
    }

    it("수정 시각이 같아도 가라앉기 전이면 받아서 견준다 — 로컬과 같으면 쓰지 않고 본 것만 적는다", async () => {
      const content = await firstPull();
      mockStateDb.getByNotionId.mockReturnValue(recordOf(content, HUMAN));

      const result = await observing().pullAll();

      expect(result).toMatchObject({ created: 0, updated: 0, restored: 0, failed: [] });
      expect(result.conflicts).toEqual([]);
      expect(result.writtenPaths).toEqual([]);
      expect(mockNotionClient.getPageMarkdown).toHaveBeenCalledTimes(1);
      expect(mdWrites()).toHaveLength(0);
      expect(mockStateDb.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: PATH,
          notionLastEdited: T,
          notionLastEditedBy: HUMAN,
          notionSeenAt: SEEN_NOW,
          notionBodyFingerprint: remoteBodyFingerprint("# Hello\n\nWorld"),
          status: "synced",
        }),
      );
    });

    it("같은 분 안에 Notion 에서 고친 행을 받는다", async () => {
      const content = await firstPull();
      mockStateDb.getByNotionId.mockReturnValue(recordOf(content, HUMAN));
      mockNotionClient.getPageMarkdown.mockResolvedValue({
        markdown: "# Hello\n\nWorld — 같은 분에 고침",
        truncated: false,
        unknown_block_ids: [],
      });

      const result = await observing().pullAll();

      expect(result).toMatchObject({ updated: 1, failed: [] });
      expect(result.writtenPaths).toEqual([PATH]);
      expect(String(mdWrites()[0]![1])).toContain("World — 같은 분에 고침");
    });

    it("봇이 마지막으로 쓴 행은 가라앉기 전이어도 본문을 읽지 않고 건너뛴다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([row(BOT)]);
      mockStateDb.getByNotionId.mockReturnValue(recordOf("로컬 사본", BOT));
      (mockVaultFs.exists as any).mockResolvedValue(true);

      const result = await observing().pullAll();

      expect(result).toMatchObject({ updated: 0, failed: [] });
      expect(mockNotionClient.getPageMarkdown).not.toHaveBeenCalled();
    });

    it("봇 id 를 받지 못했으면 봇이 쓴 행도 받아서 견준다", async () => {
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([row(BOT)]);
      mockStateDb.getByNotionId.mockReturnValue(recordOf("로컬 사본", BOT));
      (mockVaultFs.exists as any).mockResolvedValue(true);

      await observing(null).pullAll();

      expect(mockNotionClient.getPageMarkdown).toHaveBeenCalledTimes(1);
    });

    it("편집자가 바뀌었으면 수정 시각이 같아도 받는다", async () => {
      const content = await firstPull();
      mockNotionClient.queryAllDatabasePages.mockResolvedValue([row(HUMAN)]);
      mockStateDb.getByNotionId.mockReturnValue(
        recordOf(content, BOT, { notionSeenAt: settledObservation(T).notionSeenAt }),
      );
      mockNotionClient.getPageMarkdown.mockResolvedValue({
        markdown: "# Hello\n\n사람이 고침",
        truncated: false,
        unknown_block_ids: [],
      });

      const result = await observing().pullAll();

      expect(result).toMatchObject({ updated: 1, failed: [] });
      expect(String(mdWrites()[0]![1])).toContain("사람이 고침");
    });

    it("원격이 지난 사본 그대로면 remote-first 여도 로컬 편집을 덮지 않는다", async () => {
      const content = await firstPull();
      mockStateDb.getByNotionId.mockReturnValue(recordOf(content, HUMAN));
      (mockVaultFs.readFile as any).mockResolvedValue(`${content}\n로컬에서 더한 문단\n`);
      const config: Config = {
        ...createConfig([createDbConfig()]),
        sync: { ...DEFAULT_CONFIG.sync, conflictStrategy: "remote-first" },
      };

      const result = await observing(BOT, config).pullAll();

      expect(result).toMatchObject({ updated: 0, failed: [] });
      expect(result.conflicts).toEqual([]);
      expect(mdWrites()).toHaveLength(0);
      expect(mockStateDb.setRemoteObservation).toHaveBeenCalledWith("rec-1", {
        lastEdited: T,
        lastEditedBy: HUMAN,
        seenAt: SEEN_NOW,
        bodyFingerprint: remoteBodyFingerprint("# Hello\n\nWorld"),
      });
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

    it("재배치하며 받은 행도 옛 자리의 노트에서 코드 펜스 표기를 되살린다(S-20)", async () => {
      const oldPath = "databases/tasks-shared/Task One (0db13b18).md";
      const local = "```dataview\nLIST\n```\n";
      (mockVaultFs.readFile as any).mockResolvedValue(local);
      (mockVaultFs.exists as any).mockImplementation(async (path: string) => path === oldPath);
      mockNotionClient.getPageMarkdown.mockResolvedValue({
        markdown: "```plain text\nLIST\n```",
        truncated: false,
        unknown_block_ids: [],
      });
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
        obsidianPath: oldPath,
        notionPageId: "page-1",
        notionLastEdited: "2026-05-16T00:00:00.000Z",
        contentHash: computeHash(local),
      });

      await syncer.pullAll();

      const written = (mockVaultFs.writeFile as any).mock.calls.find(
        (c: any[]) => c[0] === "databases/tasks/Task One.md",
      );
      expect(written?.[1]).toContain("```dataview\nLIST\n```");
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
        ...settledObservation("2026-05-16T00:00:00.000Z"),
        contentHash: "hash1",
      });
      (mockVaultFs.exists as any).mockResolvedValue(true);

      const result = await syncer.pullAll();

      expect(result.updated).toBe(0);
      expect(mockStateDb.updatePath).not.toHaveBeenCalled();
      const mdWrites = (mockVaultFs.writeFile as any).mock.calls.filter((c: any[]) =>
        String(c[0]).endsWith(".md"),
      );
      expect(mdWrites).toHaveLength(0);
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
