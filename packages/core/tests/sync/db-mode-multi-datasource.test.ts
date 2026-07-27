/**
 * R11-A 회귀 잠금 — DB 모드 원격 열거는 **전 data source** 를 훑어야 한다.
 *
 * 결함: `detectRemoteChanges()` 의 DB 모드 분기가 `queryDatabase`(= 1차 data source
 * 1페이지)를 인라인 페이지네이션했다. 2025-09-03 모델에서 한 database 는 data source 를
 * 여러 개 가질 수 있고 각자 행 집합이 다르므로, 1차 소스만 훑으면 2번째+ 소스의 행이
 * **원격에 존재하지 않는 것으로 보인다**. 결과는 두 갈래로 갈린다:
 *
 *   1. 미발견 — 그 행들은 created 로 잡히지 않아 볼트에 영원히 들어오지 않는다.
 *   2. 오삭제 — `pullDatabase` 는 `queryAllDatabasePages` 로 전 소스를 훑어 그 행들을
 *      정상 기록하므로, 같은 행을 한 경로는 만들고 다른 경로는 고아로 판정해 지운다
 *      (deleteSync ON). 한쪽만 계약이 빠진 전형적 비대칭.
 *
 * 수정: DB 모드도 `queryAllDatabasePages`(전 소스 순회·페이지네이션·page_id 디듀프)를
 * 쓴다. 인라인 페이지네이션 사본은 제거한다.
 *
 * 가드 유효성: 수정 전(=`queryDatabase` 인라인 페이지네이션)에는 두 테스트가 모두
 * 실패한다 — 2번째 소스 행이 created 로 안 잡히고, deleteSync ON 이면 삭제된다.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const DB_ID = "db-multi-source";

/** 1차 소스 행 1개 + 2번째 소스 행 1개. `queryDatabase` 로는 후자가 보이지 않는다. */
const PRIMARY_ROW = { id: "row-primary", last_edited_time: "2026-07-01T00:00:00.000Z" };
const SECONDARY_ROW = { id: "row-secondary", last_edited_time: "2026-07-02T00:00:00.000Z" };

describe("R11-A — DB 모드 원격 열거의 다중 data source 계약", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient();

    // 전 소스 순회 SSOT 는 두 행을 모두 본다. 1차 소스만 보는 구경로는 하나만 본다.
    notion.queryAllDatabasePages.mockResolvedValue([PRIMARY_ROW, SECONDARY_ROW]);
    notion.queryDatabase.mockResolvedValue({ results: [PRIMARY_ROW], nextCursor: null });
  });

  function dbModeConfig(overrides?: Partial<Config["sync"]>): Config {
    const base = createConfig();
    return {
      ...base,
      notion: { ...base.notion, parentMode: "database", databaseId: DB_ID },
      sync: { ...DEFAULT_CONFIG.sync, ...overrides },
    };
  }

  function makeOrchestrator(config: Config): SyncOrchestrator {
    return new SyncOrchestrator(config, stateDb as never, notion as never, vaultFs as never);
  }

  it("전 data source 순회로 열거한다 — 1차 소스 전용 경로를 타지 않는다", async () => {
    await makeOrchestrator(dbModeConfig()).pull();

    expect(notion.queryAllDatabasePages).toHaveBeenCalledWith(DB_ID);
    expect(notion.queryDatabase).not.toHaveBeenCalled();
  });

  it("2번째 data source 의 행도 created 로 잡힌다 (침묵 미발견 차단)", async () => {
    const seen: string[] = [];
    notion.getPage.mockImplementation(async (id: string) => {
      seen.push(id);
      // 행만 DB 를 부모로 갖는다. 그 외 id 까지 database_id 를 물리면 부모 사슬이
      // 종료되지 않는다(목 자체가 무한 재귀가 됨).
      const isRow = id === PRIMARY_ROW.id || id === SECONDARY_ROW.id;
      return {
        id,
        last_edited_time: "2026-07-02T00:00:00.000Z",
        parent: isRow
          ? { type: "database_id", database_id: DB_ID }
          : { type: "workspace", workspace: true },
        properties: { title: { type: "title", title: [{ plain_text: id }] } },
      };
    });

    await makeOrchestrator(dbModeConfig()).pull();

    expect(seen).toContain(SECONDARY_ROW.id);
  });

  it("deleteSync ON 이어도 2번째 소스 행을 고아로 오판해 지우지 않는다", async () => {
    // pullDatabase(전 소스 순회)가 이미 기록해 둔 db-row 레코드.
    const tracked = {
      id: 1,
      obsidianPath: "DB/secondary.md",
      notionPageId: SECONDARY_ROW.id,
      notionParentId: DB_ID,
      contentHash: "h",
      notionLastEdited: SECONDARY_ROW.last_edited_time,
      localLastModified: SECONDARY_ROW.last_edited_time,
      syncDirection: "both",
      fileType: "db-row",
      status: "synced",
      localMtime: null,
      localFileSize: null,
      baseSnapshot: null,
    };
    stateDb.getAll.mockReturnValue([tracked]);
    stateDb.getByNotionId.mockImplementation((id: string) =>
      id === SECONDARY_ROW.id ? tracked : null,
    );
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "last_pull_at" ? "2026-07-01T00:00:00.000Z" : null,
    );

    const result = await makeOrchestrator(dbModeConfig({ deleteSync: true })).pull();

    expect(result.deleted).toBe(0);
    expect(vaultFs.deleteFile).not.toHaveBeenCalled();
  });
});
