/**
 * R11-B 배선 잠금 — `orchestrator.verifyCompleteness()` 의 대조 대상 조립.
 *
 * 완결성 게이트가 "볼트가 db-row 를 추적 중인 DB" 만 보면 **통째로 미발견된 DB** 를
 * 영원히 못 본다(볼트에 흔적이 없으니 대조 대상에도 안 오른다). 그래서 오케스트레이터가
 * 아는 출처 — 설정 `notion.databases[]`, 디스커버리 캐시 `discovered_dbs`, DB 모드의
 * 루트 DB — 를 모아 넘긴다. 이 조립이 끊기면 게이트는 조용히 좁아지므로 여기서 잠근다.
 *
 * `discovered_dbs` 키를 아는 곳이 오케스트레이터 하나여야 한다는 점도 함께 고정한다 —
 * 호출부(CLI·E2E)가 캐시 표현을 각자 해석하면 표현이 바뀔 때 한쪽만 낡는다.
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

const CONFIGURED_DB = "cfgdb000000000000000000000000000";
const DISCOVERED_DB = "discdb00000000000000000000000000";
const TRACKED_DB = "trakdb00000000000000000000000000";

describe("R11-B — verifyCompleteness 대조 대상 조립", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient();
  });

  function makeOrchestrator(config: Config): SyncOrchestrator {
    return new SyncOrchestrator(config, stateDb as never, notion as never, vaultFs as never);
  }

  /** 대조된 database id 목록(정규화). */
  function queriedDbIds(): string[] {
    return notion.queryAllDatabasePages.mock.calls.map((c: unknown[]) =>
      String(c[0]).replace(/-/g, "").toLowerCase(),
    );
  }

  it("설정·디스커버리 캐시·볼트 추적분을 모두 대조 대상에 넣는다", async () => {
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "discovered_dbs"
        ? JSON.stringify([{ databaseId: DISCOVERED_DB, localFolder: "d", titleProperty: "Name" }])
        : null,
    );
    stateDb.getAll.mockReturnValue([
      { notionPageId: "row-1", notionParentId: TRACKED_DB, fileType: "db-row" },
    ]);

    const base = createConfig();
    await makeOrchestrator({
      ...base,
      notion: {
        ...base.notion,
        databases: [{ databaseId: CONFIGURED_DB, localFolder: "c", titleProperty: "Name" }],
      },
    }).verifyCompleteness();

    expect(queriedDbIds().sort()).toEqual([CONFIGURED_DB, DISCOVERED_DB, TRACKED_DB].sort());
  });

  it("DB 모드에서는 루트 database 도 대조한다", async () => {
    const base = createConfig();
    const report = await makeOrchestrator({
      ...base,
      notion: { ...base.notion, parentMode: "database", databaseId: CONFIGURED_DB },
    }).verifyCompleteness();

    expect(queriedDbIds()).toEqual([CONFIGURED_DB]);
    expect(report.databases).toHaveLength(1);
  });

  it("디스커버리 캐시가 깨져 있어도 나머지로 검증을 계속한다", async () => {
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "discovered_dbs" ? "{ not json" : null,
    );
    stateDb.getAll.mockReturnValue([
      { notionPageId: "row-1", notionParentId: TRACKED_DB, fileType: "db-row" },
    ]);

    const report = await makeOrchestrator(createConfig()).verifyCompleteness();

    expect(queriedDbIds()).toEqual([TRACKED_DB]);
    // 원격 0행 vs 볼트 1행 → 잔재로 잡힌다(캐시 파손이 통과로 둔갑하지 않는다).
    expect(report.complete).toBe(false);
  });

  it("볼트가 아무 DB 도 추적하지 않고 설정도 비면 API 를 부르지 않는다", async () => {
    const report = await makeOrchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync } }),
    ).verifyCompleteness();

    expect(notion.queryAllDatabasePages).not.toHaveBeenCalled();
    expect(report.complete).toBe(true);
  });
});
