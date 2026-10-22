/**
 * 「읽지 못했다」 를 「없다」 로 바꾸던 곳 — 끝 점검(2026-10-21).
 *
 * - 보기 설정 파일(`db-views.json`)을 읽지 못하면 빈 객체에서 시작해 이 DB 의 설정만 담아 썼다 —
 *   다른 DB 들의 보기 설정이 모두 지워졌다.
 * - 부모 페이지 조회가 일시 오류로 실패하면 부모 경로를 ""(볼트 맨 위)로 보아 노트를 맨 위에 받았다.
 *   그 경로가 상태 DB 에 굳어 다음 pull 도 옮기지 않았다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DB_VIEWS_PATH } from "../../src/constants/paths.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";
const DB_ID = "db000000-0000-4000-8000-0000000000d1";

/** SDK 가 503 에 던지는 오류의 모양. */
const unavailable = () => Object.assign(new Error("service unavailable"), { status: 503 });

describe("읽지 못함을 없음으로 보지 않는다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (databases: { databaseId: string; localFolder: string }[] = []) =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, databases },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-read-failure-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("보기 설정 파일", () => {
    const withDatabase = () => {
      notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
      notion.client.getDatabaseViewsConfig.mockResolvedValue({
        databaseId: DB_ID,
        lastSynced: "",
        views: [{ id: "v1", name: "표", type: "table" }],
      });
      notion.add(DB_ID, "행", "본문", { properties: {} });
      return build([{ databaseId: DB_ID, localFolder: "Tasks" }]);
    };

    it("읽지 못한 파일은 덮지 않는다 — 다른 DB 의 설정이 남는다", async () => {
      vault.write(DB_VIEWS_PATH, '{"other-db": {"views": [');

      expect(await withDatabase().pull()).toMatchObject({ failed: [] });

      expect(vault.read(DB_VIEWS_PATH)).toBe('{"other-db": {"views": [');
    });

    it("읽은 파일에는 이 DB 의 설정을 더하고 다른 DB 의 설정은 둔다", async () => {
      vault.write(DB_VIEWS_PATH, JSON.stringify({ "other-db": { views: [] } }));

      await withDatabase().pull();

      expect(Object.keys(JSON.parse(vault.read(DB_VIEWS_PATH)!)).sort()).toEqual(
        [DB_ID, "other-db"].sort(),
      );
    });
  });

  describe("부모 페이지 조회", () => {
    it("일시 오류면 노트를 볼트 맨 위에 받지 않고, 다음 pull 이 제자리에 받는다", async () => {
      const parent = notion.add(ROOT, "부모", "부모 글");
      notion.add(parent.id, "자식", "자식 글");
      const getPage = notion.client.getPage.getMockImplementation()!;
      const getPageMarkdown = notion.client.getPageMarkdown.getMockImplementation()!;
      // 부모는 받지 못하고(상태 DB 에 없다), 부모 조회도 일시 오류다.
      notion.client.getPage.mockImplementation(async (id: string) => {
        if (id === parent.id) throw unavailable();
        return getPage(id);
      });
      notion.client.getPageMarkdown.mockImplementation(async (id: string) => {
        if (id === parent.id) throw unavailable();
        return getPageMarkdown(id);
      });

      await build().pull();

      expect(vault.read("자식.md")).toBeUndefined();

      notion.client.getPage.mockImplementation(getPage);
      notion.client.getPageMarkdown.mockImplementation(getPageMarkdown);
      expect(await build().pull({ force: true })).toMatchObject({ failed: [] });

      expect(vault.read("자식.md")).toBeUndefined();
      expect(vault.read("부모/자식.md")).toContain("자식 글");
    });
  });
});
