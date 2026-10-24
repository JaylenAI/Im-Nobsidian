/**
 * DB 행 아래의 하위 페이지 — 감지가 빠뜨리면 행 본문의 자식 태그로 채운다.
 *
 * 결함(2026-10-23 최종 E2E): 실데이터 1,225 노트를 새 루트에 올리고 빈 볼트로 받자 DB 행의 하위 페이지
 * 4 개가 빠진 채 실패 0 으로 끝났다. `--force` 로 다시 받아도 같았다. 감지는 큰 트리를 search 로 보충하는데
 * search 가 갓 만든 페이지를 돌려주지 않을 수 있고, 그것을 받은 본문의 자식 태그로 채우는 길은 페이지
 * 본문만 보고 DB 행 본문은 보지 않았다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000d1";

describe("DB 행의 하위 페이지 — 행 본문의 자식 태그로 받는다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const orchestrator = () =>
    new SyncOrchestrator(
      createConfig({
        notion: {
          token: "ntn_test_token",
          rootPageId: "root-page-id",
          databases: [{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
        },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-row-subpage-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
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

  const notes = () => [...vault.files.keys()].filter((path) => path.endsWith(".md"));

  it("감지가 못 본 행의 하위 페이지를 받는다 — 같은 pull 에서", async () => {
    const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
    notion.add(row.id, "하위", "하위 본문");

    const result = await orchestrator().pull();

    // 수정 전: 행 1 만 받고 실패 0.
    expect(result.failed).toEqual([]);
    expect(notes()).toContain("Tasks/행.md");
    expect(notes().filter((path) => path.endsWith("/하위.md"))).toHaveLength(1);
    expect(result.created).toBe(2);
  });

  it("다시 받으면 더 받지 않는다", async () => {
    const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
    notion.add(row.id, "하위", "하위 본문");
    await orchestrator().pull();

    const again = await orchestrator().pull();

    expect(again.created).toBe(0);
    expect(again.failed).toEqual([]);
  });

  it("페이지 변경이 없고 행만 바뀐 pull 에서도 새 하위 페이지를 받는다", async () => {
    notion = memoryNotion({ bumpParentOnCreate: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseViewsConfig.mockResolvedValue({
      databaseId: DB_ID,
      lastSynced: "",
      views: [],
    });
    const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
    expect((await orchestrator().pull()).created).toBe(1);
    // search 가 갓 만든 하위 페이지를 아직 돌려주지 않는다 — 행의 수정 시각만 오른다.
    const child = notion.add(row.id, "하위", "하위 본문");
    const recent = notion.client.searchRecentPages.getMockImplementation()!;
    notion.client.searchRecentPages.mockImplementation(async (...args: unknown[]) =>
      ((await recent(...(args as []))) as Array<{ id: string }>).filter(
        (page) => page.id !== child.id,
      ),
    );

    const result = await orchestrator().pull();

    expect(result.failed).toEqual([]);
    expect(result.created).toBe(1);
    expect(notes().filter((path) => path.endsWith("/하위.md"))).toHaveLength(1);
  });

  it("이미 받은 행의 빠진 하위 페이지는 --force 가 찾는다 — 행 파일은 다시 쓰지 않는다", async () => {
    const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
    expect((await orchestrator().pull()).created).toBe(1);
    // 예전 버전이 받은 볼트 — 하위 페이지가 빠졌고 행은 그 뒤로 그대로다. search 도 돌려주지 않는다.
    const child = notion.add(row.id, "하위", "하위 본문");
    const recent = notion.client.searchRecentPages.getMockImplementation()!;
    notion.client.searchRecentPages.mockImplementation(async (...args: unknown[]) =>
      ((await recent(...(args as []))) as Array<{ id: string }>).filter(
        (page) => page.id !== child.id,
      ),
    );
    const rowFile = vault.files.get("Tasks/행.md");

    expect((await orchestrator().pull()).created).toBe(0);
    const forced = await orchestrator().pull({ force: true });

    expect(forced.failed).toEqual([]);
    expect(forced.created).toBe(1);
    expect(notes().filter((path) => path.endsWith("/하위.md"))).toHaveLength(1);
    expect(vault.files.get("Tasks/행.md")).toEqual(rowFile);
  });
});
