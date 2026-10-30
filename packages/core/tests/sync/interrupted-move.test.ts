/**
 * 끊긴 이동 · 지우기 이어 하기 (P7) — Notion 에 옮기기 · 지우기를 보낸 뒤 응답을 잃으면 원격은 이미 옮겨졌거나 휴지통에
 * 있지만 상태 DB 는 지난번 그대로다.
 *
 * 페이지 ↔ 행 이동은 옮긴 뒤 노트를 통째로 다시 보낸다. 예전에는 재시도가 옮기며 바뀐 수정 시각을 Notion 편집으로 보고
 * «pull 을 먼저 하라» 고 거절했다. 옮기기 전에 보낼 노트를 갱신 WAL 에 적고, 이미 그 자리에 있고 마지막 편집자가 이
 * 봇이면 옮기기를 건너뛰고 마저 보낸다. 그 사이 사람이 고쳤으면 예전처럼 거절한다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-10-31";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000f5";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

function config(): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [ROW_DB] },
    sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

type DyingMethod = "movePage" | "movePageToDataSource" | "archivePage";

describe("끊긴 이동 · 지우기 이어 하기", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-interrupted-move-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseMeta.mockImplementation(async (id: string) => ({
      id,
      title: "Test DB",
      dataSources: [{ id, name: "" }],
    }));
    notion.client.getDatabaseViewsConfig.mockResolvedValue({
      databaseId: ROW_DB_ID,
      lastSynced: "",
      views: [],
    });
    orchestrator = new SyncOrchestrator(config(), db, notion.client as never, vault.fs());
    vault.write("A.md", "가 본문\n");
    vault.write("dir/B.md", "나 본문\n");
    notion.add(ROW_DB_ID, "R", "행 본문", {});
    await orchestrator.push();
    at("10:00:20");
    await orchestrator.pull();
    at("10:02:00");
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 이번 push 내내 이 요청은 Notion 에 적용되고 응답만 잃는다. `after` 는 적용 직후에 부른다. 끝나면 되돌린다. */
  async function pushDying(method: DyingMethod, after?: (id: string) => void) {
    const mocked = notion.client[method];
    const apply = mocked.getMockImplementation()!;
    mocked.mockImplementation(async (...args: never[]) => {
      await (apply as (...a: never[]) => Promise<unknown>)(...args);
      after?.(args[0] as string);
      throw new Error("socket hang up");
    });
    try {
      return await orchestrator.push();
    } finally {
      mocked.mockImplementation(apply as never);
    }
  }

  const pageOf = (path: string) => notion.pages.get(db.getByPath(path)!.notionPageId!)!;

  it("페이지 → 행: 옮긴 뒤 응답을 잃어도 재시도가 마저 보낸다 — 다시 옮기지 않는다", async () => {
    vault.rename("A.md", "Tasks/A.md");

    const pushed = await pushDying("movePageToDataSource");

    expect(pushed).toMatchObject({ moved: 1, failed: [] });
    expect(notion.client.movePageToDataSource).toHaveBeenCalledTimes(1);
    expect(pageOf("Tasks/A.md")).toMatchObject({ parentType: "database", parent: ROW_DB_ID });
    expect(db.getByPath("Tasks/A.md")).toMatchObject({ fileType: "db-row", status: "synced" });
    at("10:02:30");
    expect(await orchestrator.push()).toMatchObject({ moved: 0, updated: 0, failed: [] });
  });

  it("행 → 페이지: 옮긴 뒤 응답을 잃어도 재시도가 마저 보낸다", async () => {
    vault.rename("Tasks/R.md", "dir/R.md");

    const pushed = await pushDying("movePage");

    expect(pushed).toMatchObject({ moved: 1, failed: [] });
    expect(notion.client.movePage).toHaveBeenCalledTimes(1);
    expect(pageOf("dir/R.md").parentType).toBe("page");
    expect(db.getByPath("dir/R.md")).toMatchObject({ fileType: "file", status: "synced" });
  });

  it("옮긴 직후 사람이 고쳤으면 이어 하지 않고 pull 을 먼저 하라 한다 — 그 편집을 덮지 않는다", async () => {
    vault.rename("A.md", "Tasks/A.md");

    const pushed = await pushDying("movePageToDataSource", (id) =>
      notion.edit(id, (page) => {
        page.body = "사람이 고침";
      }),
    );

    expect(pushed.moved).toBe(0);
    expect(pushed.failed).toEqual([
      expect.objectContaining({ path: "Tasks/A.md", error: expect.stringContaining("pull") }),
    ]);
    expect(pageOf("Tasks/A.md").body).toBe("사람이 고침");
  });

  it("같은 폴더 사이 이동은 다음 push 가 다시 옮긴다 — 같은 자리로 옮기기는 결과가 같다", async () => {
    vault.rename("A.md", "dir/A.md");

    expect((await pushDying("movePage")).failed).toHaveLength(1);
    at("10:02:30");

    expect(await orchestrator.push()).toMatchObject({ moved: 1, failed: [] });
    expect(pageOf("dir/A.md").parent).toBe(db.getByPath("dir")!.notionPageId);
  });

  it("지우기: 휴지통에 넣은 뒤 응답을 잃어도 재시도가 지운 것으로 마친다 — 페이지 · 행", async () => {
    vault.files.delete("A.md");
    vault.files.delete("Tasks/R.md");
    const ids = [db.getByPath("A.md")!.notionPageId!, db.getByPath("Tasks/R.md")!.notionPageId!];

    expect(await pushDying("archivePage")).toMatchObject({ deleted: 2, failed: [] });

    expect(ids.map((id) => notion.pages.get(id)!.archived)).toEqual([true, true]);
    expect(db.getByPath("A.md")).toBeNull();
    expect(db.getByPath("Tasks/R.md")).toBeNull();
    at("10:02:30");
    expect(await orchestrator.pull()).toMatchObject({ created: 0, restored: 0, failed: [] });
  });
});
