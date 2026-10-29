/**
 * P3 — 데이터 소스가 여럿인 DB 의 행 push.
 *
 * 새 행은 DB 를 부모로 만들었다 — 그런 DB 에서는 Notion 이 400 으로 거절한다(2026-10-29 실측: «Databases with multiple
 * data sources are not supported in this API version»). 고친 행은 소스들을 합친 스키마로 옮겨, 그 행의 소스에 없는
 * 속성까지 보내 행 전체가 거절됐다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000c1";
const DS1 = "ds000000-0000-4000-8000-0000000000a1";
const DS2 = "ds000000-0000-4000-8000-0000000000a2";

const OWN1 = { Name: { id: "title", type: "title" }, 진척: { id: "p1", type: "number" } };
const OWN2 = { Name: { id: "title", type: "title" }, 메모: { id: "q1", type: "rich_text" } };

function config(): Config {
  return createConfig({
    notion: {
      token: "ntn_test_token",
      rootPageId: "root-page-id",
      databases: [{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
    },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
  });
}

describe("데이터 소스가 여럿인 DB 의 행 push", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let sources: Array<{ id: string; properties: Record<string, unknown> }>;

  const build = () => new SyncOrchestrator(config(), db, notion.client as never, vault.fs());

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-multids-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    sources = [
      { id: DS1, properties: OWN1 },
      { id: DS2, properties: OWN2 },
    ];
    const merged = () => Object.assign({}, ...sources.map((ds) => ds.properties).reverse());
    notion.client.getDatabaseMeta.mockImplementation(async (databaseId: string) => ({
      databaseId,
      title: "Tasks",
      dataSources: sources.map((ds) => ({ id: ds.id, name: ds.id, properties: ds.properties })),
      properties: merged(),
      isInline: false,
    }));
    notion.client.getDatabaseSchema.mockImplementation(
      async (_id: string, from?: { properties: Record<string, unknown> }) =>
        from?.properties ?? merged(),
    );
    notion.client.getDatabaseViewsConfig.mockResolvedValue({
      databaseId: DB_ID,
      lastSynced: "",
      views: [],
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("새 행은 첫 data source 에 두고, 그 소스의 속성만 보낸다", async () => {
    vault.write("Tasks/Row.md", "---\ntitle: Row\n진척: 1\n메모: 다른 소스의 속성\n---\n본문\n");

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.client.createPageWithMarkdown).toHaveBeenCalledTimes(1);
    const params = notion.client.createPageWithMarkdown.mock.calls[0]![0] as {
      dataSourceId?: string;
      properties: Record<string, unknown>;
    };
    expect(params.dataSourceId).toBe(DS1);
    expect(Object.keys(params.properties)).toContain("진척");
    expect(Object.keys(params.properties)).not.toContain("메모");
  });

  it("고친 행은 그 행이 사는 data source 의 스키마로 옮긴다 — 다른 소스의 속성은 보내지 않는다", async () => {
    vault.write("Tasks/Row.md", "---\ntitle: Row\n메모: 처음\n---\n본문\n");
    await build().push();
    const pageId = db.getByPath("Tasks/Row.md")!.notionPageId!;
    // 이 행은 둘째 소스에 산다.
    const view = notion.client.getPage.getMockImplementation()!;
    notion.client.getPage.mockImplementation(async (id: string) => {
      const page = (await view(id)) as Record<string, unknown>;
      return id === pageId
        ? { ...page, parent: { type: "data_source_id", data_source_id: DS2, database_id: DB_ID } }
        : page;
    });
    notion.client.updatePageProperties.mockClear();

    vault.write("Tasks/Row.md", "---\ntitle: Row\n메모: 고침\n진척: 5\n---\n본문\n");
    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.client.updatePageProperties).toHaveBeenCalledTimes(1);
    const [, props] = notion.client.updatePageProperties.mock.calls[0]!;
    expect(Object.keys(props as object)).toEqual(["메모"]);
  });

  it("데이터 소스가 하나뿐인 DB 는 예전처럼 DB 를 부모로 만든다", async () => {
    sources = [{ id: DS1, properties: OWN1 }];
    vault.write("Tasks/Row.md", "---\ntitle: Row\n진척: 1\n---\n본문\n");

    await build().push();

    const params = notion.client.createPageWithMarkdown.mock.calls[0]![0] as {
      dataSourceId?: string;
    };
    expect(params.dataSourceId).toBeUndefined();
  });
});
