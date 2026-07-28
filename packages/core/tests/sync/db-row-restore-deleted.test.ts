/**
 * R13 — 로컬에서 지워진 **DB 행**의 복원.
 *
 * R0 은 "볼트에서 지워진 추적 파일은 pull 이 되살린다"를 계약으로 세웠다. 그런데 그
 * 계약은 **페이지 경로에만** 걸렸다. 오케스트레이터의 `detectMissingLocalFiles` 는
 * db-row 를 일부러 제외하면서 이유를 이렇게 적어 두었다 —
 *
 *   > db-row 는 매 pull 마다 database-syncer 가 전 행을 훑으며 같은 복원 판정을 이미 거치므로
 *
 * 그 전제가 틀렸다. `pullDatabase` 의 루프는 원격 `last_edited_time` 이 그대로면
 * **로컬 파일이 있는지 묻지도 않고** `continue` 한다. 즉 복원 판정을 하는 코드
 * (`pullDatabasePage` 안의 `localExists`)에 도달하지 못한다. 같은 계약이 두 경로에 있고
 * 한쪽만 지키지 않는 이 프로젝트의 상습 결함군이다(R9a·R9e·R10-D·R11-A 와 동형).
 *
 * 결과는 조용한 영구 소실이다. 지정 볼트 1,268 레코드 중 925개(73%)가 db-row 인데,
 * 그중 하나를 지우면 어떤 게이트도 알아채지 못한다 —
 *   · `analyze` 는 FS→DB 방향(고아)만 보고 DB→FS 방향은 안 본다
 *   · `verify` 는 **상태 DB 의 id 집합**을 대조하므로 레코드만 있으면 "완결"이다
 *   · `repull churn 0` 은 그 행을 건너뛰므로 애초에 변화가 없다
 * 실제로 3차 전량 E2E 의 roundtrip 단계(`rm -rf __e2e_probe__` 후 재pull)에서
 * 페이지 28개는 복원되고 db-row 1개만 돌아오지 않는 형태로 드러났다.
 *
 * 가드 유효성: 존재 확인을 지우면 첫 테스트가 "복원 안 함"으로 실패한다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { computeHash } from "../../src/utils/hash.js";

const ROW_ID = "row-alive";
const ROW_TITLE = "살아 있던 행";
const ROW_PATH = "databases/tasks/살아 있던 행.md";
const LAST_EDITED = "2026-07-27T00:00:00.000Z";

const dbConfig: DatabaseSyncConfig = {
  databaseId: "db-123",
  localFolder: "databases/tasks",
  titleProperty: "Name",
};

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn().mockResolvedValue(""),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("fake")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
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
    getDatabaseSchema: vi.fn().mockResolvedValue({ Name: { id: "title", type: "title" } }),
    getDatabaseSchemaFull: vi.fn().mockResolvedValue({ Name: { id: "title", type: "title" } }),
    getDatabaseTitle: vi.fn().mockResolvedValue("Tasks"),
    getDatabaseViewsConfig: vi
      .fn()
      .mockResolvedValue({ databaseId: "db-123", lastSynced: "", views: [] }),
    queryAllDatabasePages: vi.fn().mockResolvedValue([
      {
        id: ROW_ID,
        last_edited_time: LAST_EDITED,
        properties: { Name: { type: "title", title: [{ plain_text: ROW_TITLE }] } },
      },
    ]),
    getPage: vi.fn().mockResolvedValue({ id: ROW_ID, last_edited_time: LAST_EDITED }),
    getPageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "리모트 본문", truncated: false, unknown_block_ids: [] }),
    replacePageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] }),
    createPageWithMarkdown: vi
      .fn()
      .mockResolvedValue({ id: "new-page", last_edited_time: LAST_EDITED }),
    updatePageProperties: vi.fn().mockResolvedValue(undefined),
    extractTitle: vi.fn().mockReturnValue(ROW_TITLE),
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

function createConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    notion: {
      ...DEFAULT_CONFIG.notion,
      token: "ntn_test",
      rootPageId: "root-id",
      databases: [dbConfig],
    },
  };
}

/** 마지막 동기화 시점의 레코드 — 원격은 그 뒤로 한 번도 바뀌지 않았다. */
function syncedRecord() {
  return {
    id: 1,
    obsidianPath: ROW_PATH,
    notionPageId: ROW_ID,
    notionParentId: "db-123",
    contentHash: computeHash("동기화 당시 본문"),
    notionLastEdited: LAST_EDITED,
    localLastModified: LAST_EDITED,
    syncDirection: "both",
    fileType: "db-row",
    status: "synced",
  };
}

/** .base 생성 등 부수 쓰기를 걸러내고 행 파일 쓰기만 본다. */
function rowWrites(vaultFs: VaultFS): string[] {
  return (vaultFs.writeFile as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as string)
    .filter((p) => p.endsWith(".md"));
}

describe("삭제된 DB 행 복원 (R13)", () => {
  let syncer: DatabaseSyncer;
  let vaultFs: VaultFS;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notionClient: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notionClient = createMockNotionClient();
    stateDb.getByNotionId.mockReturnValue(syncedRecord());
    syncer = new DatabaseSyncer(
      createConfig(),
      stateDb as never,
      notionClient as never,
      vaultFs,
      createDefaultPipeline({ wikilinkResolver: () => null }),
      createMockImageHandler() as never,
    );
  });

  it("원격이 안 바뀌었어도 로컬 파일이 사라졌으면 되살린다", async () => {
    vaultFs.exists = vi.fn().mockResolvedValue(false);
    vaultFs.readFile = vi.fn().mockRejectedValue(new Error("ENOENT"));

    const result = await syncer.pullDatabase(dbConfig);

    expect(rowWrites(vaultFs)).toEqual([ROW_PATH]);
    expect(result.restored).toBe(1);
    // 복원은 신규 생성이 아니다 — 같은 page_id 의 같은 행이 돌아온 것이다.
    expect(result.created).toBe(0);
  });

  it("복원본은 리모트 본문이다 — 빈 파일로 덮어쓰지 않는다", async () => {
    vaultFs.exists = vi.fn().mockResolvedValue(false);
    vaultFs.readFile = vi.fn().mockRejectedValue(new Error("ENOENT"));

    await syncer.pullDatabase(dbConfig);

    const written = (vaultFs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      (c[0] as string).endsWith(".md"),
    );
    expect(written?.[1]).toContain("리모트 본문");
  });

  it("파일이 멀쩡하면 종전대로 건너뛴다 — 멱등성이 무너지지 않는다", async () => {
    const result = await syncer.pullDatabase(dbConfig);

    expect(rowWrites(vaultFs)).toEqual([]);
    expect(result.restored).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.created).toBe(0);
    // 스킵 경로는 본문 조회조차 하지 않아야 한다 — 존재 확인 때문에 API 가 늘면 안 된다.
    expect(notionClient.getPageMarkdown).not.toHaveBeenCalled();
  });

  /**
   * 복원을 `updated` 로 세면 dry-run 과 하니스의 churn 이 거짓말을 한다 — "수정 1건"은
   * 원격이 바뀐 것처럼 읽히지만 실제로 바뀐 것은 로컬의 부재다. 페이지 경로가 이미
   * `restored` 를 따로 보고하므로(R0), 행 경로도 같은 어휘를 써야 두 경로가 갈라지지 않는다.
   */
  it("복원은 updated 와 섞이지 않는다", async () => {
    vaultFs.exists = vi.fn().mockResolvedValue(false);
    vaultFs.readFile = vi.fn().mockRejectedValue(new Error("ENOENT"));

    const result = await syncer.pullDatabase(dbConfig);

    expect(result.updated).toBe(0);
    expect(result.restored).toBe(1);
  });
});
