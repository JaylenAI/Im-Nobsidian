/**
 * 노트 하나(행 · 자식 없이 받은 페이지)의 하위 페이지 — 그 노트 이름의 폴더에 받는다.
 *
 * push 는 `X.md` 옆 `X/` 를 X 의 하위로 읽는다(`folderContainer`). pull 은 그런 부모의 자식을 노트 옆에 두어,
 * 행의 하위 페이지가 DB 폴더에 행처럼 섞였다(실데이터 E2E 4 페이지 — DB 폴더에는 행만 든다).
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

const ROOT = "root-page-id";
const DB_ID = "db000000-0000-4000-8000-0000000000d1";

describe("노트 하나의 하위 페이지는 그 노트 이름의 폴더에 받는다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const orchestrator = () =>
    new SyncOrchestrator(
      createConfig({
        notion: {
          token: "ntn_test_token",
          rootPageId: ROOT,
          databases: [{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
        },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-child-folder-"));
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

  const notes = () => [...vault.files.keys()].filter((path) => path.endsWith(".md")).sort();

  it("DB 행의 하위 페이지 — DB 폴더가 아니라 행 이름의 폴더", async () => {
    const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
    notion.add(row.id, "하위", "하위 본문");

    expect((await orchestrator().pull()).failed).toEqual([]);

    expect(notes()).toEqual(["Tasks/행.md", "Tasks/행/하위.md"]);
  });

  it("자식 없이 받은 페이지에 나중에 생긴 하위 페이지 — 다시 올려도 바뀌는 것이 없다", async () => {
    // 볼트 맨 위의 부모는 예전에도 제 이름의 폴더로 갔다(부모 경로가 비면 제목으로 채웠다). 한 층 아래부터 갈렸다.
    const group = notion.add(ROOT, "묶음", "묶음 본문");
    const parent = notion.add(group.id, "부모", "부모 본문");
    expect((await orchestrator().pull()).created).toBe(2);
    expect(notes()).toEqual(["묶음/묶음.md", "묶음/부모.md"]);

    notion.add(parent.id, "자식", "자식 본문");
    expect((await orchestrator().pull()).created).toBe(1);

    expect(notes()).toEqual(["묶음/묶음.md", "묶음/부모.md", "묶음/부모/자식.md"]);
    const pushed = await orchestrator().push();
    expect(pushed).toMatchObject({ created: 0, updated: 0, failed: [] });
  });
});
