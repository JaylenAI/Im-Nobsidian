/**
 * dry-run 은 세기만 한다 — 볼트 · 상태 DB 를 바꾸지 않고, 곧이어 돌린 실제 실행과 같은 수를 보인다.
 *
 * - N-01: 페이지 변경이 없으면 `pull --dry-run` 이 DB 경로로 가 행을 실제로 쓰고 기준 시각을 옮겼다.
 *   페이지 변경이 있으면 거꾸로 DB 행을 하나도 세지 않았다. 원격에서 지운 노트는 폴더 레코드 ·
 *   올리지 않은 편집이 있는 노트까지 «삭제» 로 셌다 — 실제 pull 은 지우지 않는다.
 * - N-02: deleteSync 가 꺼져 있어도 `push --dry-run` 이 지운 노트를 «삭제» 로 셌다 — 실제 push 는
 *   Notion 에서 지우지 않는다.
 * - N-03: dry-run 이 끊긴 실행의 표시를 지우고 끊긴 작업(WAL)을 정리했다.
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
import type { ProgressItem } from "../../src/types/sync.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000a1";
const FOUND_DB_ID = "db000000-0000-4000-8000-0000000000b2";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

const counts = (result: {
  created: number;
  updated: number;
  deleted: number;
  restored?: number;
}) => ({
  created: result.created,
  updated: result.updated,
  deleted: result.deleted,
  restored: result.restored ?? 0,
});

describe("dry-run 은 세기만 한다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (
    sync: Partial<Config["sync"]> = {},
    databases: DatabaseSyncConfig[] = [ROW_DB],
  ): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: {
          token: "ntn_test_token",
          rootPageId: "root-page-id",
          parentMode: "page",
          databases,
        },
        sync: { ...DEFAULT_CONFIG.sync, ...sync },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  /** 볼트 · 상태 DB 에서 dry-run 이 바꾸면 안 되는 것 전부. */
  const snapshot = () => ({
    files: [...vault.files].map(([path, file]) => [path, file.content, file.mtime]),
    records: db.getAll(),
    meta: ["last_pull_at", "last_sync_at", "last_push_at", "discovered_dbs"].map((key) =>
      db.getMeta(key),
    ),
  });

  /** dry-run 을 돌려 수와 진행 항목을 받고, 아무것도 바뀌지 않았는지 본다. */
  async function dryPull(orchestrator: SyncOrchestrator, paths?: string[]) {
    const before = snapshot();
    const seen: ProgressItem[] = [];
    const result = await orchestrator.pull({
      dryRun: true,
      paths,
      onProgress: (_current, _total, item) => seen.push(item),
    });
    expect(snapshot()).toEqual(before);
    return { result, seen: seen.map((item) => `${item.operation} ${item.path}`).sort() };
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-dry-run-"));
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

  /** 설정한 DB 에 행 A · B · C 를 두고 한 번 받는다. 행마다 볼트 경로를 돌려준다. */
  async function seedRows(orchestrator: SyncOrchestrator) {
    const added = ["A", "B", "C"].map((title) => notion.add(ROW_DB_ID, title, `${title} 처음`, {}));
    at("10:00:20");
    expect(await orchestrator.pull()).toMatchObject({ created: 3, failed: [] });
    const [a, b, c] = added.map((page) => ({
      id: page.id,
      path: db.getByNotionId(page.id)!.obsidianPath,
    }));
    at("10:02:00");
    return { a: a!, b: b!, c: c! };
  }

  describe("pull — DB 행 (N-01)", () => {
    it("페이지 변경이 없어도 행을 쓰지 않고 기준 시각을 옮기지 않는다 — 실제 pull 과 같은 수", async () => {
      const orchestrator = build();
      const { a } = await seedRows(orchestrator);
      notion.edit(a.id, (page) => {
        page.body = "A 원격 편집";
      });
      notion.add(ROW_DB_ID, "D", "D 새 행", {});
      at("10:03:00");

      const dry = await dryPull(orchestrator);

      expect(counts(dry.result)).toEqual({ created: 1, updated: 1, deleted: 0, restored: 0 });
      expect(dry.result.failed).toEqual([]);
      expect(dry.seen).toEqual(["create Tasks/D.md", `update ${a.path}`]);

      const real = await orchestrator.pull();
      expect(counts(real)).toEqual(counts(dry.result));
      expect(vault.read("Tasks/D.md")).toContain("D 새 행");
    });

    it("페이지 변경이 있어도 행을 함께 센다", async () => {
      const orchestrator = build();
      const { a } = await seedRows(orchestrator);
      notion.edit(a.id, (page) => {
        page.body = "A 원격 편집";
      });
      notion.add("root-page-id", "새 페이지", "본문");
      at("10:03:00");

      const dry = await dryPull(orchestrator);

      expect(counts(dry.result)).toEqual({ created: 1, updated: 1, deleted: 0, restored: 0 });
      expect(counts(await orchestrator.pull())).toEqual(counts(dry.result));
    });

    it("지운 행 · 사라진 행 파일은 실제 pull 처럼 가른다 — 올리지 않은 편집이 있는 행은 지운 것으로 세지 않는다", async () => {
      const orchestrator = build({ deleteSync: true, conflictStrategy: "manual" });
      const { a, b, c } = await seedRows(orchestrator);
      vault.write(a.path, "A 로컬 편집\n");
      notion.edit(a.id, (page) => {
        page.archived = true;
      });
      notion.edit(b.id, (page) => {
        page.archived = true;
      });
      vault.files.delete(c.path);
      at("10:03:00");

      const dry = await dryPull(orchestrator);

      expect(counts(dry.result)).toEqual({ created: 0, updated: 0, deleted: 1, restored: 1 });
      expect(dry.seen).toEqual([`delete ${b.path}`, `update ${c.path}`]);

      const real = await orchestrator.pull();
      expect(counts(real)).toEqual(counts(dry.result));
      expect(real.conflicts).toHaveLength(1);
      expect(vault.read(a.path)).toBe("A 로컬 편집\n");
    });

    it("다른 DB 로 옮긴 행은 조회에 없어도 지운 것으로 세지 않는다", async () => {
      const orchestrator = build({ deleteSync: true });
      const { b } = await seedRows(orchestrator);
      notion.edit(b.id, (page) => {
        page.parent = "db000000-0000-4000-8000-0000000000c3";
      });
      at("10:03:00");

      const dry = await dryPull(orchestrator);

      expect(counts(dry.result)).toEqual({ created: 0, updated: 0, deleted: 0, restored: 0 });
      expect(counts(await orchestrator.pull())).toEqual(counts(dry.result));
      expect(vault.read(b.path)).toContain("B 처음");
    });

    it("deleteSync 가 꺼져 있으면 지운 행을 세지 않는다", async () => {
      const orchestrator = build({ deleteSync: false });
      const { b } = await seedRows(orchestrator);
      // Notion 검색은 휴지통 · 보관 페이지를 돌려주지 않는다(I10) — 메모리 Notion 도 그렇게 한다.
      notion.client.searchRecentPages.mockImplementation(async () =>
        [...notion.pages.values()]
          .filter((page) => !page.archived)
          .map((page) => ({
            id: page.id,
            last_edited_time: page.lastEdited,
            last_edited_by: { id: page.lastEditedBy },
          })),
      );
      notion.edit(b.id, (page) => {
        page.archived = true;
      });
      at("10:03:00");

      const dry = await dryPull(orchestrator);

      expect(counts(dry.result)).toEqual({ created: 0, updated: 0, deleted: 0, restored: 0 });
      expect(counts(await orchestrator.pull())).toEqual(counts(dry.result));
      expect(vault.read(b.path)).toContain("B 처음");
    });

    it("경로를 좁히면 그 범위의 행만 센다", async () => {
      const orchestrator = build();
      const { a, b } = await seedRows(orchestrator);
      for (const row of [a, b]) {
        notion.edit(row.id, (page) => {
          page.body = "원격 편집";
        });
      }
      notion.add(ROW_DB_ID, "D", "D 새 행", {});
      at("10:03:00");

      const dry = await dryPull(orchestrator, [a.path]);

      expect(dry.seen).toEqual([`update ${a.path}`]);
      expect(counts(await orchestrator.pull({ paths: [a.path] }))).toEqual(counts(dry.result));
    });

    describe("발견해 둔 DB", () => {
      const discover = () =>
        db.setMeta(
          "discovered_dbs",
          JSON.stringify([
            { databaseId: FOUND_DB_ID, localFolder: "Found", titleProperty: "Name" },
          ]),
        );

      it("설정한 DB 처럼 센다", async () => {
        const orchestrator = build({}, []);
        discover();
        notion.add(FOUND_DB_ID, "F1", "첫 행", {});
        notion.add(FOUND_DB_ID, "F2", "둘째 행", {});
        at("10:03:00");

        const dry = await dryPull(orchestrator);

        expect(dry.seen).toEqual(["create Found/F1.md", "create Found/F2.md"]);
        expect(counts(await orchestrator.pull())).toEqual(counts(dry.result));
      });

      it("접근 불가로 뺀 DB 는 세지 않는다", async () => {
        const orchestrator = build({}, []);
        discover();
        db.setMeta("inaccessible_dbs", JSON.stringify([FOUND_DB_ID]));
        notion.add(FOUND_DB_ID, "F1", "첫 행", {});

        const dry = await dryPull(orchestrator);

        expect(dry.seen).toEqual([]);
        expect(dry.result.failed).toEqual([]);
      });

      it("DB 모드는 발견해 둔 DB 를 받지 않는다 — 세지도 않는다", async () => {
        const base = createConfig();
        const orchestrator = new SyncOrchestrator(
          {
            ...base,
            notion: {
              ...base.notion,
              parentMode: "database",
              databaseId: ROW_DB_ID,
              databases: [],
            },
            advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
          },
          db,
          notion.client as never,
          vault.fs(),
        );
        discover();
        notion.add(FOUND_DB_ID, "F1", "첫 행", {});

        const dry = await dryPull(orchestrator);

        expect(dry.seen).toEqual([]);
        expect(counts(await orchestrator.pull())).toEqual(counts(dry.result));
      });

      it("사라진 DB(404)는 실패로 세지 않고, 그 밖에 읽지 못한 DB 는 이유와 함께 실패로 싣는다", async () => {
        const orchestrator = build();
        discover();
        const notFound = Object.assign(new Error("object_not_found"), {
          code: "object_not_found",
          status: 404,
        });
        notion.client.queryAllDatabasePages.mockImplementation(async (databaseId: string) => {
          throw databaseId === FOUND_DB_ID ? notFound : new Error("rate limited");
        });

        const dry = await dryPull(orchestrator);

        expect(dry.result.failed).toEqual([
          { path: "Tasks", operation: "update", error: "rate limited" },
        ]);
      });
    });
  });

  describe("pull — 원격에서 지운 페이지", () => {
    it("폴더 레코드와 올리지 않은 편집이 있는 노트는 지운 것으로 세지 않는다", async () => {
      const orchestrator = build({ deleteSync: true, conflictStrategy: "manual" }, []);
      vault.write("A/B/x.md", "x\n");
      vault.write("y.md", "y\n");
      vault.write("z.md", "z\n");
      expect(await orchestrator.push()).toMatchObject({ failed: [] });
      at("10:00:20");
      await orchestrator.pull();
      at("10:02:00");
      const folderB = db.getByPath("A/B")!.notionPageId!;
      for (const page of notion.pages.values()) {
        if (page.id === folderB || page.parent === folderB) page.archived = true;
      }
      for (const path of ["y.md", "z.md"]) {
        notion.edit(db.getByPath(path)!.notionPageId!, (page) => {
          page.archived = true;
        });
      }
      vault.write("z.md", "z 로컬 편집\n");
      at("10:03:00");

      const dry = await dryPull(orchestrator);

      expect(dry.seen).toEqual(["delete A/B/x.md", "delete y.md"]);
      const real = await orchestrator.pull();
      expect(counts(real)).toEqual(counts(dry.result));
      expect(real.conflicts).toHaveLength(1);
    });

    it("볼트에서도 폴더를 지웠으면 안의 노트만 지운 것으로 센다 — 폴더 레코드는 추적만 놓는다", async () => {
      const orchestrator = build({ deleteSync: true }, []);
      vault.write("A/B/x.md", "x\n");
      expect(await orchestrator.push()).toMatchObject({ failed: [] });
      at("10:00:20");
      await orchestrator.pull();
      at("10:02:00");
      const folderB = db.getByPath("A/B")!.notionPageId!;
      for (const page of notion.pages.values()) {
        if (page.id === folderB || page.parent === folderB) page.archived = true;
      }
      vault.files.delete("A/B/x.md");
      vault.folders.delete("A/B");
      at("10:03:00");

      const dry = await dryPull(orchestrator);

      expect(dry.seen).toEqual(["delete A/B/x.md"]);
      expect(counts(await orchestrator.pull())).toEqual(counts(dry.result));
      expect(db.getByPath("A/B")).toBeNull();
    });
  });

  describe("push — deleteSync (N-02)", () => {
    async function deletedLocally(orchestrator: SyncOrchestrator): Promise<void> {
      vault.write("keep.md", "keep\n");
      vault.write("gone.md", "gone\n");
      expect(await orchestrator.push()).toMatchObject({ created: 2, failed: [] });
      vault.files.delete("gone.md");
    }

    it("꺼져 있으면 지운 노트를 삭제로 세지 않는다 — 실제 push 도 지우지 않는다", async () => {
      const orchestrator = build({ deleteSync: false }, []);
      await deletedLocally(orchestrator);
      const seen: ProgressItem[] = [];

      const dry = await orchestrator.push({
        dryRun: true,
        onProgress: (_current, _total, item) => seen.push(item),
      });

      expect(dry).toMatchObject({ created: 0, updated: 0, deleted: 0 });
      expect(seen).toEqual([]);
      expect(await orchestrator.push()).toMatchObject({ deleted: 0 });
    });

    it("켜져 있으면 센다", async () => {
      const orchestrator = build({ deleteSync: true }, []);
      await deletedLocally(orchestrator);

      const dry = await orchestrator.push({ dryRun: true });

      expect(dry).toMatchObject({ created: 0, updated: 0, deleted: 1 });
      expect(await orchestrator.push()).toMatchObject({ deleted: 1 });
    });
  });

  describe("끊긴 실행의 표시와 작업 (N-03)", () => {
    it("dry-run 은 표시를 지우지 않고 끊긴 작업을 정리하지 않는다 — 실제 push 가 정리한다", async () => {
      const orchestrator = build({}, []);
      vault.write("a.md", "a\n");
      expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
      db.setMeta("push_in_progress", "true");
      db.setMeta("pull_in_progress", "true");
      db.recordPendingOperation({
        syncStateId: db.getByPath("a.md")!.id,
        operation: "update",
        direction: "pull",
      });
      const flags = () => [db.getMeta("push_in_progress"), db.getMeta("pull_in_progress")];

      await orchestrator.push({ dryRun: true });
      expect(flags()).toEqual(["true", "true"]);
      expect(db.getIncompletePendingOperations()).toHaveLength(1);

      await orchestrator.pull({ dryRun: true });
      expect(flags()).toEqual(["true", "true"]);
      expect(db.getIncompletePendingOperations()).toHaveLength(1);

      await orchestrator.push();
      expect(flags()).not.toContain("true");
      expect(db.getIncompletePendingOperations()).toEqual([]);
    });
  });
});
