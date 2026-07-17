import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageHandler } from "../../src/sync/image-handler.js";
import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";

// P3-A: DB 행 files 속성의 notion-hosted 서명 URL(약 1시간 만료)을 pull 때
// 로컬 첨부로 내려받아 [[wikilink]] 로 대체한다 — frontmatter 에 만료 URL 이
// 남거나 push 로 원본이 오염되는 것을 막는 실측 기반 방어.

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn().mockResolvedValue(""),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("fake")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
    listNonMarkdownFiles: vi.fn().mockResolvedValue([]),
  } as unknown as VaultFS;
}

describe("ImageHandler.localizeNotionFileUrl", () => {
  let handler: ImageHandler;
  let mockFs: VaultFS;

  beforeEach(() => {
    mockFs = createMockVaultFs();
    handler = new ImageHandler(mockFs, "attachments");
  });

  it("notion-hosted 서명 URL → 다운로드 후 로컬 경로 반환", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-type", "image/jpeg"]]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
    });

    const url = "https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/cover.jpg?X-Amz=1";
    const localPath = await handler.localizeNotionFileUrl(url, "표지");

    expect(localPath).toMatch(/^attachments\/.+\.jpe?g$/);
    expect(mockFs.writeBinary).toHaveBeenCalled();
  });

  it("신형 file.notion.so URL 도 다운로드 대상", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-type", "image/png"]]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
    });

    const url = "https://file.notion.so/f/f/space/file/img.png?table=block&id=x";
    const localPath = await handler.localizeNotionFileUrl(url, "img");

    expect(localPath).toMatch(/^attachments\//);
  });

  it("일반 외부 URL → null (사용자 데이터 존중, 다운로드 안 함)", async () => {
    global.fetch = vi.fn();
    const result = await handler.localizeNotionFileUrl("https://cdn.example.com/a.jpg", "a");
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("http(s) 가 아닌 값(위키링크 등) → null", async () => {
    expect(await handler.localizeNotionFileUrl("[[attachments/a.jpg]]", "a")).toBeNull();
  });

  it("다운로드 실패 → null (원문 유지 신호)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });
    const url = "https://prod-files-secure.s3.us-west-2.amazonaws.com/broken.jpg";
    expect(await handler.localizeNotionFileUrl(url, "b")).toBeNull();
  });
});

describe("DatabaseSyncer — files 속성 pull 로컬라이즈", () => {
  function createDbConfig(): DatabaseSyncConfig {
    return { databaseId: "db-123", localFolder: "databases/tasks", titleProperty: "Name" };
  }

  function createConfig(): Config {
    return {
      ...DEFAULT_CONFIG,
      notion: {
        ...DEFAULT_CONFIG.notion,
        token: "ntn_test",
        rootPageId: "root-id",
        databases: [createDbConfig()],
      },
    };
  }

  function createMocks(pageFiles: unknown) {
    const page = {
      id: "page-1",
      last_edited_time: "2026-07-16T00:00:00.000Z",
      properties: {
        Name: { type: "title", title: [{ plain_text: "책 A" }] },
        표지: { type: "files", files: pageFiles },
      },
    };
    const notionClient = {
      getDatabaseSchema: vi.fn().mockResolvedValue({
        Name: { id: "title", type: "title" },
        표지: { id: "p1", type: "files" },
      }),
      getDatabaseSchemaFull: vi.fn().mockResolvedValue({
        Name: { id: "title", type: "title" },
        표지: { id: "p1", type: "files" },
      }),
      getDatabaseTitle: vi.fn().mockResolvedValue("책장"),
      getDatabaseViewsConfig: vi
        .fn()
        .mockResolvedValue({ databaseId: "db-123", lastSynced: "", views: [] }),
      queryAllDatabasePages: vi.fn().mockResolvedValue([page]),
      getPageMarkdown: vi
        .fn()
        .mockResolvedValue({ markdown: "본문", truncated: false, unknown_block_ids: [] }),
      extractTitle: vi.fn().mockReturnValue("책 A"),
      extractCover: vi.fn().mockReturnValue(null),
      extractIcon: vi.fn().mockReturnValue(null),
    };
    const imageHandler = {
      downloadAllImages: vi
        .fn()
        .mockImplementation(async (md: string) => ({ content: md, downloads: [] })),
      downloadAllFiles: vi
        .fn()
        .mockImplementation(async (md: string) => ({ content: md, downloads: [] })),
      localizeNotionFileUrl: vi.fn(),
      uploadAndAppendImages: vi.fn().mockResolvedValue(undefined),
    };
    const stateDb = {
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
    return { notionClient, imageHandler, stateDb };
  }

  async function pullWith(pageFiles: unknown, localizeReturns: string | null) {
    const { notionClient, imageHandler, stateDb } = createMocks(pageFiles);
    imageHandler.localizeNotionFileUrl.mockResolvedValue(localizeReturns);
    const vaultFs = createMockVaultFs();
    const syncer = new DatabaseSyncer(
      createConfig(),
      stateDb as any,
      notionClient as any,
      vaultFs,
      createDefaultPipeline({ wikilinkResolver: () => null }),
      imageHandler as any,
    );
    await syncer.pullDatabase(createDbConfig());
    const mdWrite = (vaultFs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).endsWith(".md"),
    );
    return { frontmatter: String(mdWrite?.[1] ?? ""), imageHandler };
  }

  it("notion-hosted file → [[attachments/..]] 위키링크로 대체 (원본 파일명 전달)", async () => {
    const { frontmatter, imageHandler } = await pullWith(
      [
        {
          name: "표지.jpg",
          type: "file",
          file: { url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/x/표지.jpg?sig=1" },
        },
      ],
      "attachments/표지-abc123def456.jpg",
    );

    expect(imageHandler.localizeNotionFileUrl).toHaveBeenCalledWith(
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/x/표지.jpg?sig=1",
      "표지.jpg",
    );
    // 단일 파일 = 스칼라 (Bases 카드 image: 렌더 규약)
    expect(frontmatter).toContain("[[attachments/표지-abc123def456.jpg]]");
    expect(frontmatter).not.toContain("prod-files-secure");
  });

  it("로컬라이즈 실패(null) → 원문 URL 유지", async () => {
    const url = "https://prod-files-secure.s3.us-west-2.amazonaws.com/x/broken.jpg";
    const { frontmatter } = await pullWith([{ name: "b", type: "file", file: { url } }], null);
    expect(frontmatter).toContain(url);
    expect(frontmatter).not.toContain("[[attachments/");
  });

  it("외부 URL 파일(external) → localize 가 null 이면 원문 유지", async () => {
    const url = "https://cdn.example.com/cover.jpg";
    const { frontmatter, imageHandler } = await pullWith(
      [{ name: "c", type: "external", external: { url } }],
      null,
    );
    expect(imageHandler.localizeNotionFileUrl).toHaveBeenCalledWith(url, "c");
    expect(frontmatter).toContain(url);
  });
});
