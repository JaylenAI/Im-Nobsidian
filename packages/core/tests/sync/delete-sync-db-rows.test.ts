/**
 * S-12 — deleteSync 가 켜진 페이지 모드에서 DB 행을 «원격에서 사라진 것» 으로 판정했다.
 *
 * 전체 대조는 루트 아래 페이지를 순회해 추적 레코드와 견준다. 순회는 DB 행을 보지 않는다(행은
 * 자식 페이지가 아니다 — DB 조회로만 보인다). 그런데 견주는 쪽은 추적 레코드 전체라, 행은 매
 * pull 마다 «사라진 페이지» 가 됐다 — 파일을 지우고 이어지는 DB pull 이 다시 만들었다. 올리지 않은
 * 로컬 행 편집은 그 사이에 사라졌다. 플러그인은 deleteSync 를 늘 켠다.
 *
 * 고친 뒤: 행의 삭제는 그 DB 의 조회 결과로 가르고, 목록 · 조회에 없는 것은 지우기 전에 원격에
 * 묻는다 — 휴지통 · 보관 · 없음(404)일 때만 지운다.
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
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000a1";
const OTHER_DB_ID = "db000000-0000-4000-8000-0000000000b2";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

/** 이 기기 시계를 `DAY` 의 그 시각으로 — 메모리 Notion 의 수정 시각도 이 시계를 따른다. */
function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

/** 플러그인과 같은 설정 — 페이지 모드 · deleteSync 켬. */
const deleteSyncConfig = (databases: DatabaseSyncConfig[] = [ROW_DB]): Config =>
  createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases },
    sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
  });

describe("S-12 deleteSync 는 목록에 없는 것을 원격에 물어보고 지운다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let vaultFs: VaultFS;

  const build = (config = deleteSyncConfig()): SyncOrchestrator => {
    vaultFs = vault.fs();
    return new SyncOrchestrator(config, db, notion.client as never, vaultFs);
  };
  const deletedPaths = (): string[] =>
    vi.mocked(vaultFs.deleteFile).mock.calls.map(([path]) => path);
  const trash = (id: string): void => {
    notion.edit(id, (page) => {
      page.archived = true;
    });
  };
  /** 이 페이지만 원격 확인이 실패한다 — 나머지는 그대로 답한다. */
  const failRetrieve = (id: string): void => {
    const retrieve = notion.client.getPage.getMockImplementation()!;
    notion.client.getPage.mockImplementation(async (pageId: string) => {
      if (pageId === id) throw Object.assign(new Error("bad gateway"), { status: 502 });
      return retrieve(pageId);
    });
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-deletesync-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Notion 에 있는 행 하나를 받는다. */
  async function pulledRow(orchestrator: SyncOrchestrator): Promise<{ id: string; path: string }> {
    const row = notion.add(ROW_DB_ID, "Task", "행 본문", {});
    at("10:00:20");
    expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
    return { id: row.id, path: db.getByNotionId(row.id)!.obsidianPath };
  }

  /** 올린 노트 하나를 한 번 받아 둔다 — 다음 pull 이 전체 대조를 한다. */
  async function pushedNote(orchestrator: SyncOrchestrator): Promise<string> {
    vault.write("Note.md", "원본\n");
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    at("10:00:20");
    await orchestrator.pull();
    return db.getByPath("Note.md")!.notionPageId!;
  }

  describe("설정한 DB 의 행", () => {
    it("다시 pull 해도 행 파일을 지웠다 만들지 않는다", async () => {
      const orchestrator = build();
      const row = await pulledRow(orchestrator);

      at("10:05:00");
      const again = await orchestrator.pull();

      expect(again).toMatchObject({ created: 0, updated: 0, deleted: 0, failed: [] });
      expect(deletedPaths()).not.toContain(row.path);
      expect(vault.files.has(row.path)).toBe(true);
      expect(db.getByNotionId(row.id)).not.toBeNull();
    });

    it("올리지 않은 로컬 행 편집을 pull 이 지우지 않고 sync 가 올린다", async () => {
      const orchestrator = build();
      const row = await pulledRow(orchestrator);

      at("10:05:00");
      vault.write(row.path, `${vault.read(row.path)}\n로컬에서 더함\n`);
      at("10:05:10");
      const result = await orchestrator.sync();

      expect(result.pull).toMatchObject({ deleted: 0, failed: [] });
      expect(vault.read(row.path)).toContain("로컬에서 더함");
      expect(result.push).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(row.id)!.body).toContain("로컬에서 더함");
    });

    it("Notion 에서 휴지통으로 간 행은 지운다", async () => {
      const orchestrator = build();
      const row = await pulledRow(orchestrator);

      at("10:05:00");
      trash(row.id);
      at("10:05:10");
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 1, failed: [] });
      expect(vault.files.has(row.path)).toBe(false);
      expect(db.getByNotionId(row.id)).toBeNull();
    });

    it("Notion 에서 아주 지워진 행(404)도 지운다", async () => {
      const orchestrator = build();
      const row = await pulledRow(orchestrator);

      at("10:05:00");
      notion.pages.delete(row.id);
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 1, failed: [] });
      expect(vault.files.has(row.path)).toBe(false);
      expect(db.getByNotionId(row.id)).toBeNull();
    });

    it("조회에 없어도 Notion 에 살아 있는 행(다른 DB 로 옮겨짐)은 지우지 않는다", async () => {
      const orchestrator = build();
      const row = await pulledRow(orchestrator);

      at("10:05:00");
      notion.edit(row.id, (page) => {
        page.parent = OTHER_DB_ID;
      });
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 0, failed: [] });
      expect(vault.files.has(row.path)).toBe(true);
      expect(db.getByNotionId(row.id)).not.toBeNull();
    });

    it("원격을 확인하지 못한 행은 이번에는 지우지 않고 다음 pull 이 다시 묻는다", async () => {
      const orchestrator = build();
      const row = await pulledRow(orchestrator);

      at("10:05:00");
      trash(row.id);
      const retrieve = notion.client.getPage.getMockImplementation()!;
      failRetrieve(row.id);
      const failed = await orchestrator.pull();

      expect(failed).toMatchObject({ deleted: 0 });
      expect(vault.files.has(row.path)).toBe(true);

      notion.client.getPage.mockImplementation(retrieve);
      at("10:06:00");
      const again = await orchestrator.pull();

      expect(again).toMatchObject({ deleted: 1, failed: [] });
      expect(vault.files.has(row.path)).toBe(false);
    });

    it("조회 필터가 있는 DB 는 조회에 없는 행을 묻지도 지우지도 않는다 — 필터 밖일 수 있다", async () => {
      const row = await pulledRow(build());

      const filtered = build(
        deleteSyncConfig([
          { ...ROW_DB, pullFilter: { property: "title", title: { equals: "다른 제목" } } },
        ]),
      );
      notion.client.getPage.mockClear();
      at("10:05:00");
      const result = await filtered.pull();

      expect(result).toMatchObject({ deleted: 0, failed: [] });
      expect(vault.files.has(row.path)).toBe(true);
      expect(db.getByNotionId(row.id)).not.toBeNull();
      // 필터 밖으로 나간 행을 pull 마다 물으면 요청이 끝없이 는다.
      expect(notion.client.getPage).not.toHaveBeenCalledWith(row.id);
    });

    it("`--path` 범위 밖의 행은 지우지 않는다", async () => {
      const orchestrator = build();
      const row = await pulledRow(orchestrator);

      at("10:05:00");
      trash(row.id);
      const outside = await orchestrator.pull({ paths: ["Notes"] });

      expect(outside).toMatchObject({ deleted: 0, failed: [] });
      expect(vault.files.has(row.path)).toBe(true);

      at("10:06:00");
      const inside = await orchestrator.pull({ paths: ["Tasks"] });

      expect(inside).toMatchObject({ deleted: 1, failed: [] });
      expect(vault.files.has(row.path)).toBe(false);
    });
  });

  describe("자동 발견한 DB 의 행 — 플러그인이 쓰는 경로", () => {
    const discovered = (): void => {
      db.setMeta("discovered_dbs", JSON.stringify([ROW_DB]));
    };

    it("다시 pull 해도 지웠다 만들지 않고, 휴지통으로 간 행만 지운다", async () => {
      discovered();
      const orchestrator = build(deleteSyncConfig([]));
      const row = await pulledRow(orchestrator);

      at("10:05:00");
      const again = await orchestrator.pull();

      expect(again).toMatchObject({ created: 0, updated: 0, deleted: 0, failed: [] });
      expect(deletedPaths()).not.toContain(row.path);

      trash(row.id);
      at("10:06:00");
      const trashed = await orchestrator.pull();

      expect(trashed).toMatchObject({ deleted: 1, failed: [] });
      expect(vault.files.has(row.path)).toBe(false);
    });

    it("접근 불가로 뺀 DB 의 행은 페이지처럼 가른다 — 휴지통이면 지운다", async () => {
      discovered();
      const orchestrator = build(deleteSyncConfig([]));
      const row = await pulledRow(orchestrator);

      db.setMeta("inaccessible_dbs", JSON.stringify([ROW_DB_ID.replace(/-/g, "")]));
      at("10:05:00");
      trash(row.id);
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 1, failed: [] });
      expect(vault.files.has(row.path)).toBe(false);
    });
  });

  describe("페이지 — 목록에 없으면 원격에 묻는다", () => {
    it("Notion 에서 휴지통으로 간 페이지는 지금처럼 지운다", async () => {
      const orchestrator = build();
      const pageId = await pushedNote(orchestrator);

      at("10:05:00");
      trash(pageId);
      at("10:05:10");
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 1, failed: [] });
      expect(vault.files.has("Note.md")).toBe(false);
    });

    it("목록이 빠뜨린 살아 있는 페이지는 지우지 않는다", async () => {
      const orchestrator = build();
      const pageId = await pushedNote(orchestrator);

      at("10:05:00");
      notion.client.getChildPagesRecursive.mockResolvedValueOnce([]);
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 0, failed: [] });
      expect(vault.read("Note.md")).toBe("원본\n");
      expect(db.getByNotionId(pageId)).not.toBeNull();
    });

    it("부모와 함께 목록에서 빠진 하위 페이지도 부모가 살아 있으면 지우지 않는다", async () => {
      const orchestrator = build();
      const parent = notion.add("root-page-id", "Parent", "부모 본문");
      const child = notion.add(parent.id, "Child", "자식 본문");
      at("10:00:20");
      expect(await orchestrator.pull()).toMatchObject({ created: 2, failed: [] });
      const childPath = db.getByNotionId(child.id)!.obsidianPath;
      // 레코드가 자식 → 부모 순이어도 같아야 한다 — 부모 레코드를 다시 적어 뒤로 보낸다.
      const parentRecord = db.getByNotionId(parent.id)!;
      db.delete(parentRecord.id);
      db.upsert(parentRecord);
      const order = db.getAll().map((record) => record.notionPageId);
      expect(order.indexOf(child.id)).toBeLessThan(order.indexOf(parent.id));

      at("10:05:00");
      notion.client.getChildPagesRecursive.mockResolvedValueOnce([]);
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 0, failed: [] });
      expect(vault.files.has(childPath)).toBe(true);
      expect(db.getByNotionId(parent.id)).not.toBeNull();
      expect(db.getByNotionId(child.id)).not.toBeNull();
    });

    it("동기화 범위 밖으로 옮겨진 페이지는 지금처럼 지운다", async () => {
      const orchestrator = build();
      const pageId = await pushedNote(orchestrator);

      at("10:05:00");
      notion.edit(pageId, (page) => {
        page.parent = "outside-page-id";
      });
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 1, failed: [] });
      expect(vault.files.has("Note.md")).toBe(false);
    });

    it("원격을 확인하지 못한 페이지는 이번에는 지우지 않는다", async () => {
      const orchestrator = build();
      const pageId = await pushedNote(orchestrator);

      at("10:05:00");
      trash(pageId);
      failRetrieve(pageId);
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 0 });
      expect(vault.read("Note.md")).toBe("원본\n");
    });
  });
});
