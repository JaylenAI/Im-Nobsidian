/**
 * F-h — local-first 가 지킨 노트를 pull 이 «받은 것» 으로 셌다.
 *
 * 양쪽이 바뀐 노트를 local-first 는 로컬을 지키고 원격을 받지 않는다. 그런데 페이지 pull 은 그
 * 노트를 받은 것으로 세어(`updated` · `writtenPaths`), `sync` 가 이어지는 push 에서 뺐다 — pull
 * 이 방금 쓴 노트를 다시 올리지 않으려는 장치다. 원격을 본 기록도 적지 않으니 다음 sync 도 같았다.
 * local-first 인데 그 노트의 로컬 편집은 `sync` 로는 영영 올라가지 않았다(단독 `push` 는 올린다).
 * DB 행은 처음부터 세지 않았다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-03";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000f8";

/** 이 기기 시계를 `DAY` 의 그 시각으로 — 메모리 Notion 의 수정 시각도 이 시계를 따른다. */
function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

const localFirst = (notion: Partial<Config["notion"]> = {}): Config =>
  createConfig({
    notion: {
      ...DEFAULT_CONFIG.notion,
      token: "ntn_test_token",
      rootPageId: "root-page-id",
      ...notion,
    },
    sync: { ...DEFAULT_CONFIG.sync, conflictStrategy: "local-first" },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
  });

describe("F-h local-first 가 지킨 노트는 받은 것이 아니다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (config = localFirst()): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-pullskip-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const pageIdOf = (path: string): string => db.getByPath(path)!.notionPageId!;

  /** 10:00:05 에 올린 노트를 10:05 에 양쪽에서 고친다 — Notion 은 사람이, 볼트는 로컬 편집. */
  async function editedOnBothSides(orchestrator: SyncOrchestrator): Promise<string> {
    vault.write("Note.md", "원본\n");
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    const pageId = pageIdOf("Note.md");

    at("10:05:00");
    notion.edit(pageId, (page) => {
      page.body = "원본\n\nNotion 에서 더함";
    });
    vault.write("Note.md", "원본\n\n로컬에서 더함\n");
    at("10:05:10");
    return pageId;
  }

  it("pull 은 지킨 노트를 받은 것으로 세지 않고 쓰지도 않는다", async () => {
    const orchestrator = build();
    await editedOnBothSides(orchestrator);

    const pulled = await orchestrator.pull();

    expect(pulled).toMatchObject({ updated: 0, conflicts: [], failed: [] });
    expect(pulled.writtenPaths).not.toContain("Note.md");
    expect(vault.read("Note.md")).toBe("원본\n\n로컬에서 더함\n");
  });

  it("sync 는 이어지는 push 에서 로컬 편집을 올린다", async () => {
    const orchestrator = build();
    const pageId = await editedOnBothSides(orchestrator);

    const result = await orchestrator.sync();

    expect(result.pull).toMatchObject({ updated: 0, conflicts: [], failed: [] });
    expect(result.push).toMatchObject({ updated: 1, failed: [] });
    expect(notion.pages.get(pageId)!.body).toContain("로컬에서 더함");
    expect(notion.pages.get(pageId)!.body).not.toContain("Notion 에서 더함");
    expect(vault.read("Note.md")).toBe("원본\n\n로컬에서 더함\n");
  });

  it("올린 뒤의 sync 는 할 일이 없다", async () => {
    const orchestrator = build();
    const pageId = await editedOnBothSides(orchestrator);
    await orchestrator.sync();
    const bodyAfterSync = notion.pages.get(pageId)!.body;

    at("10:08:00");
    const again = await orchestrator.sync();

    expect(again.pull).toMatchObject({ created: 0, updated: 0, conflicts: [], failed: [] });
    expect(again.push).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(notion.pages.get(pageId)!.body).toBe(bodyAfterSync);
  });

  describe("DB 행 — 같은 규칙", () => {
    beforeEach(() => {
      notion.client.getDatabaseSchema.mockResolvedValue({
        Name: { id: "title", type: "title" },
      });
    });

    it("sync 는 지킨 행을 받은 것으로 세지 않고 로컬 편집을 올린다", async () => {
      const orchestrator = build(
        localFirst({
          databases: [{ databaseId: ROW_DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
        }),
      );
      const row = notion.add(ROW_DB_ID, "Task", "행 본문", {});
      notion.edit(row.id, () => {});
      at("10:00:20");
      expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
      const path = db.getByNotionId(row.id)!.obsidianPath;

      at("10:05:00");
      notion.edit(row.id, (page) => {
        page.body = "행 본문\n\nNotion 에서 더함";
      });
      vault.write(path, `${vault.read(path)}\n로컬에서 더함\n`);
      at("10:05:10");
      const result = await orchestrator.sync();

      expect(result.pull).toMatchObject({ updated: 0, conflicts: [], failed: [] });
      expect(result.pull.writtenPaths).not.toContain(path);
      expect(result.push).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(row.id)!.body).toContain("로컬에서 더함");
    });
  });
});
