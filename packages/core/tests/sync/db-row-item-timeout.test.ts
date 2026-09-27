/**
 * R9e — DB 행 1건의 시간 상한 (pull).
 *
 * R9b 는 오케스트레이터의 페이지 루프 4곳에만 `withDeadline` 을 걸었다. 그런데 지정 볼트의
 * 887개 파일 중 **629개가 DB 행**이라, 정작 다수 경로가 상한 없이 남아 있었다. R9a 의
 * image/file 핸들러 비대칭과 같은 결함군이다 — 같은 계약이 두 경로에 있으면 한쪽만 빠진다.
 *
 * 설정 DB 행의 push 는 이제 오케스트레이터의 변경 목록을 탄다 — 그 상한은 페이지와 같은
 * 변경 1건의 상한이다(`tests/sync/configured-db-row-push.test.ts`).
 *
 * 여기서 잠그는 것은 두 가지다:
 *   1. 끝나지 않는 행 1건이 **유한한, 그리고 보고되는 실패**로 바뀐다.
 *   2. 그 실패가 나머지 행의 처리를 막지 않는다.
 *
 * 테스트는 **끝나지 않는 프로미스**로 설계했다. 상한을 지우면 실패가 아니라 hang 으로
 * 드러나야, 같은 결함을 다시 만들 수 없다(R9a 의 download-timeout 테스트와 같은 방식).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";

/** 절대 끝나지 않는 작업 — 상한이 없으면 테스트가 실패가 아니라 hang 으로 드러난다. */
const never = () => new Promise<never>(() => {});

/** 상한 초과를 몇십 ms 안에 관측하기 위한 값. 정상 경로는 이보다 훨씬 빨리 끝난다. */
const ITEM_TIMEOUT_MS = 40;

/** 경로별로 다른 제목·본문. */
function rowMarkdown(path: string): string {
  const title = path.split("/").pop()!.replace(/\.md$/, "");
  return `---\ntitle: ${title}\n---\n\n${title} 본문`;
}

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn().mockImplementation((path: string) => Promise.resolve(rowMarkdown(path))),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("fake")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    getFileStat: vi.fn().mockResolvedValue(null),
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
    extractTitle: vi.fn().mockImplementation((page: { id: string }) => `제목 ${page.id}`),
    extractCover: vi.fn().mockReturnValue(null),
    extractIcon: vi.fn().mockReturnValue(null),
    uploadFile: vi.fn().mockResolvedValue("upload-id"),
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
    advanced: { ...DEFAULT_CONFIG.advanced, itemTimeoutMs: ITEM_TIMEOUT_MS },
  };
}

describe("DB 행 1건 시간 상한 (R9e)", () => {
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
  });

  describe("pull", () => {
    it("끝나지 않는 행은 상한에서 끊겨 실패로 보고된다", async () => {
      notionClient.queryAllDatabasePages.mockResolvedValue([dbPage("row-hang", "멈춘 행")]);
      notionClient.getPageMarkdown.mockImplementation(never);

      const result = await syncer.pullDatabase(dbConfig);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toContain("시간 상한 초과");
      // 어느 행에서 멎었는지가 메시지에 남아야 한다 — 운영자의 유일한 단서다.
      expect(result.failed[0].error).toContain("pull databases/tasks/row-hang");
      expect(result.failed[0].path).toBe("databases/tasks/row-hang");
      // 상한에 걸린 행을 생성으로 세면 집계가 거짓말을 한다.
      expect(result.created).toBe(0);
      expect(result.writtenPaths).toHaveLength(0);
    });

    it("한 행이 멎어도 나머지 행은 계속 처리된다", async () => {
      notionClient.queryAllDatabasePages.mockResolvedValue([
        dbPage("row-hang", "멈춘 행"),
        dbPage("row-ok", "정상 행"),
      ]);
      notionClient.getPageMarkdown.mockImplementation((pageId: string) =>
        pageId === "row-hang"
          ? never()
          : Promise.resolve({ markdown: "본문", truncated: false, unknown_block_ids: [] }),
      );

      const result = await syncer.pullDatabase(dbConfig);

      expect(result.failed).toHaveLength(1);
      expect(result.created).toBe(1);
      expect(result.writtenPaths).toHaveLength(1);
      expect(vaultFs.writeFile).toHaveBeenCalled();
    });

    it("상한 안에 끝나는 행은 상한이 없는 것과 동일하게 처리된다", async () => {
      notionClient.queryAllDatabasePages.mockResolvedValue([dbPage("row-ok", "정상 행")]);

      const result = await syncer.pullDatabase(dbConfig);

      expect(result.failed).toHaveLength(0);
      expect(result.created).toBe(1);
    });
  });
});
