/**
 * 설정 DB(`notion.databases`) · DB 모드(`parentMode: database`)의 행 push 가 행 경로를 탄다.
 *
 * 설정 DB 의 행은 오케스트레이터의 변경 목록 밖에서 따로 올라갔다(`DatabaseSyncer.pushAll`).
 * 그 경로는 바뀔 때마다 모든 속성과 본문을 통째로 보냈고, Notion 에서도 바뀐 행의 수정 시각을
 * 덮어써 다음 pull 이 그 변경을 받지 못했다. 충돌로 표시된 행도 올렸고, 새 행의 생성 요청이
 * 적용됐는지 모르고 끝나면 다음 push 가 같은 행을 하나 더 만들었다. dry-run · 범위를 좁힌 push ·
 * 이름 변경 · 삭제는 이 행들을 보지 않았다.
 *
 * DB 모드의 새 노트는 행이 되면서도 조상 폴더를 페이지로 만들었고, 생성 요청이 적용됐는지 모르면
 * 입양하지 않고 새로 만들었다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로
 * 이어 쓴다(local-move-push 와 같은 하니스).
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
import { MemoryVault, memoryNotion, type MemoryPage } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000c1";
const ROOT_DB_ID = "db000000-0000-4000-8000-0000000000d1";

const SCHEMA = {
  Name: { id: "title", type: "title" },
  진척: { id: "p1", type: "number" },
  메모: { id: "p2", type: "rich_text" },
  단계: { id: "p3", type: "select" },
};

const ROW = "---\ntitle: Row\n진척: 1\n메모: 첫 메모\n단계: 시작\n---\n본문 한 줄\n";
/** 제목을 frontmatter 에 적지 않은 행 — 제목이 파일 이름을 따른다. */
const UNTITLED_ROW = "---\n진척: 1\n---\n본문 한 줄\n";

function configuredDb(
  sync?: Partial<Config["sync"]>,
  advanced?: Partial<Config["advanced"]>,
): Config {
  return createConfig({
    notion: {
      token: "ntn_test_token",
      rootPageId: "root-page-id",
      databases: [{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
    },
    sync: { ...DEFAULT_CONFIG.sync, ...sync },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, ...advanced },
  });
}

function databaseMode(): Config {
  return createConfig({
    notion: {
      token: "ntn_test_token",
      rootPageId: "root-page-id",
      parentMode: "database",
      databaseId: ROOT_DB_ID,
    },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
  });
}

describe("설정 DB · DB 모드의 행 push 는 행 경로를 탄다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  const build = (config: Config): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-cfgdb-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    notion.client.getDatabaseSchema.mockResolvedValue(SCHEMA);
    notion.client.getDatabaseViewsConfig.mockResolvedValue({
      databaseId: DB_ID,
      lastSynced: "",
      views: [],
    });
    orchestrator = build(configuredDb());
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const pageOf = (path: string): MemoryPage => notion.pages.get(db.getByPath(path)!.notionPageId!)!;
  const rowsIn = (databaseId: string) =>
    [...notion.pages.values()].filter(
      (page) => page.parentType === "database" && page.parent === databaseId && !page.archived,
    );
  const clearCalls = () => {
    for (const fn of Object.values(notion.client)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
    }
  };

  /** 처음 동기화 — push 가 만든 레코드를 이후 시험이 그대로 쓴다. */
  async function seed(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) vault.write(path, content);
    const result = await orchestrator.push();
    expect(result.failed).toEqual([]);
    clearCalls();
  }

  /** 생성 요청은 적용됐는데 응답을 받지 못한 것처럼 — 행은 생기고 요청은 실패한다(S-07). */
  function loseNextCreateResponse(): void {
    const create = notion.client.createPageWithMarkdown.getMockImplementation()!;
    notion.client.createPageWithMarkdown.mockImplementationOnce(async (params: never) => {
      await create(params);
      throw new Error("socket hang up");
    });
  }

  describe("설정 DB", () => {
    it("새 행은 DB 의 행으로 만들고, 행 레코드를 적고, 생성 WAL 을 마친다", async () => {
      vault.write("Tasks/Row.md", ROW);

      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 1, updated: 0, failed: [] });
      const row = pageOf("Tasks/Row.md");
      expect(row).toMatchObject({ parentType: "database", parent: DB_ID, title: "Row" });
      expect(row.properties).toMatchObject({
        진척: { type: "number", number: 1 },
        단계: { type: "select", select: { name: "시작" } },
      });
      expect(db.getByPath("Tasks/Row.md")).toMatchObject({
        fileType: "db-row",
        notionParentId: DB_ID,
        status: "synced",
      });
      expect(db.getIncompletePendingOperations()).toEqual([]);
      expect(db.resolveWikilink("Row")?.notionPageId).toBe(row.id);
      expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    });

    it("속성 하나를 고치면 그 속성만 보내고 본문은 다시 쓰지 않는다", async () => {
      await seed({ "Tasks/Row.md": ROW });
      const row = pageOf("Tasks/Row.md");

      vault.write("Tasks/Row.md", ROW.replace("진척: 1", "진척: 2"));
      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 0, updated: 1, failed: [] });
      expect(notion.client.updatePageProperties).toHaveBeenCalledTimes(1);
      expect(notion.client.updatePageProperties).toHaveBeenCalledWith(row.id, {
        진척: { number: 2 },
      });
      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(db.getByPath("Tasks/Row.md")!.notionLastEdited).toBe(row.lastEdited);
    });

    it("Notion 에서도 바뀐 행은 로컬에서 바꾼 것만 보내고 수정 시각을 올리지 않는다 — 다음 pull 이 Notion 쪽 변경을 받는다", async () => {
      await seed({ "Tasks/Row.md": ROW });
      const row = pageOf("Tasks/Row.md");
      const syncedAt = db.getByPath("Tasks/Row.md")!.notionLastEdited;
      // 누군가 Notion 에서 메모를 고친다.
      await notion.client.updatePageProperties(row.id, {
        메모: { rich_text: [{ text: { content: "Notion 메모" } }] },
      });
      clearCalls();

      vault.write("Tasks/Row.md", ROW.replace("진척: 1", "진척: 2"));
      const result = await orchestrator.push();

      expect(result).toMatchObject({ updated: 1, failed: [] });
      expect(notion.client.updatePageProperties).toHaveBeenCalledWith(row.id, {
        진척: { number: 2 },
      });
      expect(row.properties["메모"]).toMatchObject({
        rich_text: [expect.objectContaining({ plain_text: "Notion 메모" })],
      });
      expect(db.getByPath("Tasks/Row.md")!.notionLastEdited).toBe(syncedAt);

      const pulled = await orchestrator.pull();

      expect(pulled.failed).toEqual([]);
      const local = vault.read("Tasks/Row.md")!;
      expect(local).toContain("메모: Notion 메모");
      expect(local).toContain("진척: 2");
    });

    it("본문을 보내지 못한 행은 실패로 남고 해시를 올리지 않는다 — 다음 push 가 다시 보낸다", async () => {
      await seed({ "Tasks/Row.md": ROW });
      const synced = db.getByPath("Tasks/Row.md")!.contentHash;
      notion.client.replacePageMarkdown
        .mockRejectedValueOnce(new Error("본문 교체 실패"))
        .mockRejectedValueOnce(new Error("본문 교체 실패"));

      vault.write("Tasks/Row.md", ROW.replace("본문 한 줄", "고친 본문"));
      const failed = await orchestrator.push();

      expect(failed).toMatchObject({ updated: 0 });
      expect(failed.failed).toEqual([
        { path: "Tasks/Row.md", operation: "update", error: "본문 교체 실패" },
      ]);
      expect(db.getByPath("Tasks/Row.md")!.contentHash).toBe(synced);

      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
      expect(pageOf("Tasks/Row.md").body).toContain("고친 본문");
    });

    it("끝나지 않는 행은 변경 1건의 상한에서 끊겨 실패로 남고 나머지 행은 올라간다", async () => {
      orchestrator = build(configuredDb(undefined, { itemTimeoutMs: 40 }));
      const create = notion.client.createPageWithMarkdown.getMockImplementation()!;
      notion.client.createPageWithMarkdown.mockImplementation(async (params: { title: string }) =>
        params.title === "Stuck" ? new Promise<never>(() => {}) : create(params as never),
      );
      vault.write("Tasks/Stuck.md", ROW.replace("title: Row", "title: Stuck"));
      vault.write("Tasks/Row.md", ROW);

      const result = await orchestrator.push();

      expect(result.created).toBe(1);
      expect(result.failed).toEqual([
        {
          path: "Tasks/Stuck.md",
          operation: "create",
          error: expect.stringContaining("시간 상한 초과"),
        },
      ]);
      // 해시를 적으면 다음 push 가 이 행을 건너뛰어 영영 만들지 않는다.
      expect(db.getByPath("Tasks/Stuck.md")).toMatchObject({ notionPageId: null, contentHash: "" });
      expect(rowsIn(DB_ID).map((row) => row.title)).toEqual(["Row"]);
    });

    it("충돌로 표시된 행은 --force 없이 올리지 않는다", async () => {
      await seed({ "Tasks/Row.md": ROW });
      db.updateStatus(db.getByPath("Tasks/Row.md")!.id, "conflict");

      vault.write("Tasks/Row.md", ROW.replace("진척: 1", "진척: 2"));
      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 0, updated: 0, failed: [] });
      expect(notion.client.updatePageProperties).not.toHaveBeenCalled();
      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(db.getByPath("Tasks/Row.md")!.status).toBe("conflict");
    });

    it("dry-run 이 설정 DB 의 새 행 · 바뀐 행을 세고 Notion 에 쓰지 않는다", async () => {
      await seed({ "Tasks/Row.md": ROW });
      vault.write("Tasks/Row.md", ROW.replace("진척: 1", "진척: 2"));
      vault.write("Tasks/New.md", ROW.replace("title: Row", "title: New"));

      const dry = await orchestrator.push({ dryRun: true });

      expect(dry).toMatchObject({ created: 1, updated: 1, failed: [] });
      expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
      expect(notion.client.updatePageProperties).not.toHaveBeenCalled();
    });

    it("범위를 좁힌 push 는 범위 밖의 설정 DB 행을 올리지 않는다", async () => {
      vault.write("Tasks/Row.md", ROW);
      vault.write("notes/a.md", "note body\n");

      const result = await orchestrator.push({ paths: ["notes"] });

      expect(result).toMatchObject({ created: 1, failed: [] });
      expect(rowsIn(DB_ID)).toEqual([]);
      expect(db.getByPath("Tasks/Row.md")).toBeNull();
    });

    it("새 행의 생성 요청이 적용됐는지 모르고 끝나면 같은 제목의 행을 입양한다 — 하나 더 만들지 않는다", async () => {
      vault.write("Tasks/Row.md", ROW);
      loseNextCreateResponse();

      await orchestrator.push();
      await orchestrator.push();

      expect(rowsIn(DB_ID)).toHaveLength(1);
      expect(db.getByPath("Tasks/Row.md")).toMatchObject({
        notionPageId: rowsIn(DB_ID)[0]!.id,
        status: "synced",
      });
      expect(db.getIncompletePendingOperations()).toEqual([]);
    });

    it("이름을 바꾸면 Notion 행의 제목이 따라 바뀐다 — 새 행을 만들지 않는다", async () => {
      await seed({ "Tasks/Row.md": UNTITLED_ROW });
      const row = pageOf("Tasks/Row.md");

      vault.rename("Tasks/Row.md", "Tasks/Renamed.md");
      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 0, updated: 0, moved: 1, failed: [] });
      expect(row.title).toBe("Renamed");
      expect(rowsIn(DB_ID)).toHaveLength(1);
      expect(db.getByPath("Tasks/Renamed.md")!.notionPageId).toBe(row.id);
      expect(db.getByPath("Tasks/Row.md")).toBeNull();
    });

    it("이름과 내용을 함께 바꾼 행도 플러그인이 알린 이름 변경이면 같은 행이다", async () => {
      await seed({ "Tasks/Row.md": UNTITLED_ROW });
      const row = pageOf("Tasks/Row.md");

      vault.rename("Tasks/Row.md", "Tasks/Renamed.md");
      vault.write("Tasks/Renamed.md", UNTITLED_ROW.replace("진척: 1", "진척: 5"));
      orchestrator.recordLocalRename("Tasks/Row.md", "Tasks/Renamed.md", "file");
      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 0, failed: [] });
      expect(rowsIn(DB_ID)).toHaveLength(1);
      expect(row).toMatchObject({ title: "Renamed" });
      expect(row.properties["진척"]).toMatchObject({ number: 5 });
    });

    it("deleteSync 를 켜면 지운 행을 Notion 에서도 지운다", async () => {
      orchestrator = build(configuredDb({ deleteSync: true }));
      await seed({ "Tasks/Row.md": ROW });
      const row = pageOf("Tasks/Row.md");

      vault.files.delete("Tasks/Row.md");
      const result = await orchestrator.push();

      expect(result).toMatchObject({ deleted: 1, failed: [] });
      expect(row.archived).toBe(true);
      expect(db.getByPath("Tasks/Row.md")).toBeNull();
    });

    it("deleteSync 를 끄면 지운 행을 Notion 에 남기고 다음 pull 이 되살린다", async () => {
      await seed({ "Tasks/Row.md": ROW });
      const row = pageOf("Tasks/Row.md");

      vault.files.delete("Tasks/Row.md");
      const result = await orchestrator.push();
      const pulled = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 0, failed: [] });
      expect(row.archived).toBe(false);
      expect(pulled.failed).toEqual([]);
      expect(vault.read("Tasks/Row.md")).toContain("본문 한 줄");
    });

    it("행 이름의 하위 폴더에 든 노트는 그 행 아래 페이지로 만든다", async () => {
      vault.write("Tasks/Row.md", ROW);
      vault.write("Tasks/Row/Sub.md", "sub body\n");

      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 2, failed: [] });
      const row = pageOf("Tasks/Row.md");
      expect(pageOf("Tasks/Row/Sub.md")).toMatchObject({ parentType: "page", parent: row.id });
    });

    it("새 행이 `# 제목` 으로 시작하면 만든 뒤 되살린다 (N-04)", async () => {
      vault.write("Tasks/Row.md", "---\ntitle: Row\n---\n# Heading\n\nRow body\n");

      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 1, failed: [] });
      const row = pageOf("Tasks/Row.md");
      expect(row.body).toMatch(/^# Heading\n/);
      expect(db.getByPath("Tasks/Row.md")!.notionLastEdited).toBe(row.lastEdited);
    });
  });

  describe("DB 모드", () => {
    beforeEach(() => {
      orchestrator = build(databaseMode());
    });

    it("새 노트는 폴더 안에 있어도 루트 DB 의 행이 된다 — 폴더 페이지를 만들지 않는다", async () => {
      vault.write("A/B/note.md", "---\n진척: 3\n---\n본문\n");

      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 1, failed: [] });
      expect(notion.client.createPage).not.toHaveBeenCalled();
      const row = pageOf("A/B/note.md");
      expect(row).toMatchObject({ parentType: "database", parent: ROOT_DB_ID, title: "note" });
      expect(row.properties).toMatchObject({ 진척: { type: "number", number: 3 } });
      expect(db.getByPath("A/B/note.md")).toMatchObject({
        fileType: "file",
        notionParentId: ROOT_DB_ID,
        status: "synced",
      });
      expect(db.getByPath("A")).toBeNull();
      expect(db.getByPath("A/B")).toBeNull();
      expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    });

    it("생성 요청이 적용됐는지 모르고 끝나면 같은 제목의 행을 입양한다 — 하나 더 만들지 않는다", async () => {
      vault.write("note.md", "---\n진척: 3\n---\n본문\n");
      loseNextCreateResponse();

      await orchestrator.push();
      await orchestrator.push();

      expect(rowsIn(ROOT_DB_ID)).toHaveLength(1);
      expect(db.getByPath("note.md")).toMatchObject({
        notionPageId: rowsIn(ROOT_DB_ID)[0]!.id,
        status: "synced",
      });
    });
  });

  describe("F-08 행 속성 모양 — 왕복", () => {
    const SEOUL = { ...DEFAULT_CONFIG.conversion, timeZone: "Asia/Seoul" };
    /** 로컬에만 있는 키 · 흐름 목록 · 주석 · 기간 짝 키 · 벽시계 시각이 든 행. */
    const note = (title: string) =>
      [
        "---",
        "aliases: [별칭]",
        `title: ${title}`,
        "진척: 1",
        "마감: 2026-10-01T10:00",
        "마감_end: 2026-10-03T18:00",
        "메모: 첫 메모 # 손으로 단 주석",
        "cssclasses:",
        "  - wide",
        "---",
        "본문 한 줄",
        "",
      ].join("\n");

    beforeEach(() => {
      notion.client.getDatabaseSchema.mockResolvedValue({
        ...SCHEMA,
        마감: { id: "p4", type: "date" },
      });
    });

    /** Notion 에서 진척을 고친다 — Notion 은 오프셋을 붙여 보낸 시각을 UTC 로 돌려준다. */
    async function editInNotion(row: MemoryPage): Promise<void> {
      await notion.client.updatePageProperties(row.id, { 진척: { number: 2 } });
      row.properties["마감"] = {
        type: "date",
        date: {
          start: "2026-10-01T01:00:00.000+00:00",
          end: "2026-10-03T09:00:00.000+00:00",
          time_zone: null,
        },
      };
      clearCalls();
    }

    for (const [mode, config, path, title] of [
      ["설정 DB", () => ({ ...configuredDb(), conversion: SEOUL }), "Tasks/Row.md", "Row"],
      ["DB 모드", () => ({ ...databaseMode(), conversion: SEOUL }), "note.md", "note"],
    ] as const) {
      it(`${mode}: 시각 · 기간은 같은 순간으로 올라가고, 받을 때는 Notion 에서 고친 줄만 바뀐다`, async () => {
        orchestrator = build(config());
        await seed({ [path]: note(title) });
        const row = pageOf(path);
        expect(row.properties["마감"]).toMatchObject({
          date: { start: "2026-10-01T10:00:00+09:00", end: "2026-10-03T18:00:00+09:00" },
        });
        expect(Object.keys(row.properties)).not.toContain("마감_end");
        expect(Object.keys(row.properties)).not.toContain("aliases");

        await editInNotion(row);
        const pulled = await orchestrator.pull();

        expect(pulled.failed).toEqual([]);
        expect(vault.read(path)).toBe(note(title).replace("진척: 1", "진척: 2"));
        expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
        expect(notion.client.updatePageProperties).not.toHaveBeenCalled();
      });
    }
  });
});
