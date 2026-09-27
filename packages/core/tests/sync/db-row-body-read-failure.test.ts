/**
 * S-10 — DB 행의 본문을 읽지 못하면 «빈 본문» 이 아니라 «실패» 다.
 *
 * 예전 pullDatabasePage 는 Markdown API 실패를 삼키고 빈 본문으로 넘어갔다. 로컬이 그대로인
 * 행은 local-first 판정에서 «덮어써도 된다» 가 나오므로, 본문이 지워진 파일이 쓰이고 레코드는
 * 새 해시 · 새 편집 시각으로 «동기화 완료» 가 됐다. 원격이 다시 바뀌기 전까지는 아무도 그
 * 행을 다시 받지 않는다 — 조용한 유실이다.
 *
 * 여기서 잠그는 것: 읽지 못한 행은 실패로 보고되고, 파일도 레코드도 건드리지 않는다.
 * 레코드의 편집 시각이 그대로여야 다음 pull 이 그 행을 다시 받는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { computeHash } from "../../src/utils/hash.js";

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

function dbPage(id: string, title: string) {
  return {
    id,
    last_edited_time: "2026-07-27T00:00:00.000Z",
    properties: { Name: { type: "title", title: [{ plain_text: title }] } },
  };
}

function createMockNotionClient() {
  return {
    getDatabaseSchema: vi.fn().mockResolvedValue({ Name: { id: "title", type: "title" } }),
    getDatabaseSchemaFull: vi.fn().mockResolvedValue({ Name: { id: "title", type: "title" } }),
    getDatabaseTitle: vi.fn().mockResolvedValue("Tasks"),
    getDatabaseViewsConfig: vi
      .fn()
      .mockResolvedValue({ databaseId: "db-123", lastSynced: "", views: [] }),
    queryAllDatabasePages: vi.fn().mockResolvedValue([]),
    getPage: vi.fn().mockResolvedValue({ id: "p", last_edited_time: "2026-07-27T00:00:00.000Z" }),
    getPageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "본문", truncated: false, unknown_block_ids: [] }),
    replacePageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] }),
    createPageWithMarkdown: vi
      .fn()
      .mockResolvedValue({ id: "new-page", last_edited_time: "2026-07-27T00:00:00.000Z" }),
    updatePageProperties: vi.fn().mockResolvedValue(undefined),
    extractTitle: vi.fn().mockImplementation((page: { id: string }) => `제목 ${page.id}`),
    extractCover: vi.fn().mockReturnValue(null),
    extractIcon: vi.fn().mockReturnValue(null),
    uploadFile: vi.fn().mockResolvedValue("upload-id"),
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
    localizeNotionFileUrl: vi.fn().mockResolvedValue(null),
  };
}

const dbConfig: DatabaseSyncConfig = {
  databaseId: "db-123",
  localFolder: "databases/tasks",
  titleProperty: "Name",
};

function createConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    notion: {
      ...DEFAULT_CONFIG.notion,
      token: "ntn_test",
      rootPageId: "root-id",
      databases: [dbConfig],
    },
    advanced: { ...DEFAULT_CONFIG.advanced },
  };
}

const ROW_PATH = "databases/tasks/행.md";

/** 행 파일(.md) 쓰기만 센다 — .base 등 DB 부속 파일은 행 본문과 무관하게 쓰인다. */
function rowWrites(vaultFs: VaultFS): string[] {
  return (vaultFs.writeFile as ReturnType<typeof vi.fn>).mock.calls
    .map(([path]) => path as string)
    .filter((path) => path.endsWith(".md"));
}
const LOCAL = "---\ntitle: 행\n---\n\n지키고 싶은 본문\n";

function serverError(): Error {
  return Object.assign(new Error("HTTP 502"), { status: 502 });
}

describe("DB 행 본문을 읽지 못함 (S-10)", () => {
  let syncer: DatabaseSyncer;
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notionClient: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notionClient = createMockNotionClient();
    syncer = new DatabaseSyncer(
      createConfig(),
      stateDb as never,
      notionClient as never,
      vaultFs,
      createDefaultPipeline({ wikilinkResolver: () => null }),
      createMockImageHandler() as never,
    );
    notionClient.queryAllDatabasePages.mockResolvedValue([dbPage("row-1", "행")]);
    notionClient.getPageMarkdown.mockRejectedValue(serverError());
  });

  it("이미 받아 둔 행 — 원격이 바뀌었어도 본문을 못 읽으면 로컬 파일과 레코드를 그대로 둔다", async () => {
    // 로컬은 마지막 동기화 그대로다 → 예전에는 «덮어써도 된다» 로 판정돼 빈 본문이 쓰였다.
    stateDb.getByNotionId.mockReturnValue({
      id: 1,
      obsidianPath: ROW_PATH,
      notionPageId: "row-1",
      notionParentId: "db-123",
      contentHash: computeHash(LOCAL),
      notionLastEdited: "2026-07-01T00:00:00.000Z",
      status: "synced",
      fileType: "db-row",
      baseSnapshot: Buffer.from(LOCAL, "utf-8"),
    });
    vaultFs.exists.mockResolvedValue(true);
    vaultFs.readFile.mockResolvedValue(LOCAL);

    const result = await syncer.pullDatabase(dbConfig);

    expect(result.failed).toEqual([
      expect.objectContaining({ path: "databases/tasks/row-1", error: "HTTP 502" }),
    ]);
    expect(result.updated).toBe(0);
    expect(rowWrites(vaultFs)).toEqual([]);
    // 레코드의 편집 시각이 그대로여야 다음 pull 이 이 행을 다시 받는다.
    expect(stateDb.upsert).not.toHaveBeenCalled();
  });

  it("새 행 — 본문을 못 읽으면 빈 파일을 만들지 않는다", async () => {
    const result = await syncer.pullDatabase(dbConfig);

    expect(result.failed).toHaveLength(1);
    expect(result.created).toBe(0);
    expect(result.writtenPaths).toEqual([]);
    expect(rowWrites(vaultFs)).toEqual([]);
    expect(stateDb.upsert).not.toHaveBeenCalled();
  });

  it("다음 pull 에서 읽히면 그때 받는다", async () => {
    await syncer.pullDatabase(dbConfig);
    notionClient.getPageMarkdown.mockResolvedValue({
      markdown: "원격 본문",
      truncated: false,
      unknown_block_ids: [],
    });

    const result = await syncer.pullDatabase(dbConfig);

    expect(result.failed).toEqual([]);
    expect(result.created).toBe(1);
    expect(vaultFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("databases/tasks/"),
      expect.stringContaining("원격 본문"),
    );
  });
});
