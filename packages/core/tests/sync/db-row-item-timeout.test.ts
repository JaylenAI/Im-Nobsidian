/**
 * R9e — DB 행 1건의 시간 상한.
 *
 * R9b 는 오케스트레이터의 페이지 루프 4곳에만 `withDeadline` 을 걸었다. 그런데 지정 볼트의
 * 887개 파일 중 **629개가 DB 행**이라, 정작 다수 경로가 상한 없이 남아 있었다. R9a 의
 * image/file 핸들러 비대칭과 같은 결함군이다 — 같은 계약이 두 경로에 있으면 한쪽만 빠진다.
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

/** 경로별로 다른 제목·본문 — 제목으로 hang 분기를 고르고, 해시 충돌(rename 오탐)도 피한다. */
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

  describe("push", () => {
    beforeEach(() => {
      vaultFs.listMarkdownFiles = vi.fn().mockResolvedValue([
        { path: "databases/tasks/멈춘 행.md", content: "", mtime: "2026-07-27T00:00:00.000Z" },
        { path: "databases/tasks/정상 행.md", content: "", mtime: "2026-07-27T00:00:00.000Z" },
      ]);
    });

    it("끝나지 않는 행은 상한에서 끊기고 나머지는 계속 올라간다", async () => {
      notionClient.createPageWithMarkdown.mockImplementation(({ title }: { title: string }) =>
        title === "멈춘 행"
          ? never()
          : Promise.resolve({ id: "new-page", last_edited_time: "2026-07-27T00:00:00.000Z" }),
      );

      const result = await syncer.pushAll();

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toContain("시간 상한 초과");
      expect(result.failed[0].error).toContain("push databases/tasks/멈춘 행.md");
      expect(result.created).toBe(1);
    });

    it("상한에 걸린 행은 동기화 완료로 기록되지 않는다 (거짓 동기화 차단)", async () => {
      vaultFs.listMarkdownFiles = vi
        .fn()
        .mockResolvedValue([
          { path: "databases/tasks/멈춘 행.md", content: "", mtime: "2026-07-27T00:00:00.000Z" },
        ]);
      notionClient.createPageWithMarkdown.mockImplementation(never);

      const result = await syncer.pushAll();

      expect(result.created).toBe(0);
      // 해시가 전진하면 다음 push 에서 스킵되어 변경이 영원히 전달되지 않는다.
      expect(stateDb.upsert).not.toHaveBeenCalled();
      expect(result.failed[0].error).toContain("시간 상한 초과");
    });

    /**
     * 상한을 걸려고 루프 본문을 메서드로 떼어낸 리팩터링이 실패 처리의 **의미**를 바꾸지
     * 않았는지 잠근다. 본문 push 실패는 다른 예외와 달리 레코드를 `error` 로 내려
     * 해시 전진을 막아야 하고, operation 도 create 가 아니라 update 다.
     */
    it("본문 push 실패는 여전히 update 실패로 기록되고 레코드가 error 로 내려간다", async () => {
      vaultFs.listMarkdownFiles = vi
        .fn()
        .mockResolvedValue([
          { path: "databases/tasks/정상 행.md", content: "", mtime: "2026-07-27T00:00:00.000Z" },
        ]);
      stateDb.getByPath.mockReturnValue({
        id: "rec-1",
        obsidianPath: "databases/tasks/정상 행.md",
        notionPageId: "existing-page",
        contentHash: "옛 해시",
      });
      notionClient.replacePageMarkdown.mockRejectedValue(new Error("본문 교체 실패"));

      const result = await syncer.pushAll();

      expect(result.failed).toEqual([
        {
          path: "databases/tasks/정상 행.md",
          operation: "update",
          error: "본문 교체 실패",
        },
      ]);
      expect(stateDb.updateStatus).toHaveBeenCalledWith("rec-1", "error");
      expect(stateDb.updateHash).not.toHaveBeenCalled();
      expect(result.updated).toBe(0);
    });
  });
});
