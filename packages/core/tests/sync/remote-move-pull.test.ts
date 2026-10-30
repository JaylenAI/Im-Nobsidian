/**
 * ADR-039 — Notion 에서 옮긴 페이지를 pull 이 볼트에서도 옮긴다.
 *
 * `pages.move` 는 수정 시각을 바꾸지 않는다(2026-09-27 실측). 예전에는 감지되지 않아 볼트의 노트가 옛 자리에
 * 남았다. 여기서는 메모리 Notion 의 부모만 바꿔(수정 시각 그대로) 그 상태를 만든다 — `movePage` 는 시각을 올린다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로 이어 쓴다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG, type DatabaseSyncConfig } from "../../src/types/config.js";
import { createConfig, mockDatabaseMeta } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";

describe("Notion 에서 옮긴 페이지를 볼트에서 옮긴다 (ADR-039)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-remotemove-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const notes = () => [...vault.files.keys()].filter((path) => path.endsWith(".md")).sort();
  const idOf = (path: string) => db.getByPath(path)!.notionPageId!;
  /** Notion 에서 옮긴다 — 수정 시각은 그대로(실측). */
  const moveInNotion = (path: string, parentPath: string | null) => {
    notion.pages.get(idOf(path))!.parent = parentPath === null ? ROOT : idOf(parentPath);
  };

  async function seed(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) vault.write(path, content);
    expect((await orchestrator.push()).failed).toEqual([]);
  }

  it("다른 폴더로 옮긴 노트 — 새 폴더로 옮기고 다시 받아도 그대로", async () => {
    await seed({ "A/a.md": "a\n", "A/c.md": "c\n", "B/b.md": "b\n" });
    const id = idOf("A/c.md");
    moveInNotion("A/c.md", "B");

    const result = await orchestrator.pull({ force: true });

    expect(result.failed).toEqual([]);
    expect(result.moved).toEqual([{ from: "A/c.md", to: "B/c.md" }]);
    expect(notes()).toEqual(["A/a.md", "B/b.md", "B/c.md"]);
    expect(vault.read("B/c.md")).toBe("c\n");
    expect(db.getByNotionId(id)).toMatchObject({ obsidianPath: "B/c.md" });
    expect(db.resolvePageId(id)?.obsidianPath).toBe("B/c.md");
    expect(db.getIncompletePendingOperations()).toEqual([]);

    const again = await orchestrator.pull({ force: true });
    expect(again).toMatchObject({ created: 0, updated: 0, deleted: 0, restored: 0, moved: [] });
    expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, moved: 0 });
  });

  it("증분 pull 도 조회 창에 든 페이지면 옮긴다", async () => {
    await seed({ "A/c.md": "c\n", "B/b.md": "b\n" });
    moveInNotion("A/c.md", "B");

    const result = await orchestrator.pull();

    expect(result.moved).toEqual([{ from: "A/c.md", to: "B/c.md" }]);
    expect(notes()).toEqual(["B/b.md", "B/c.md"]);
  });

  it("status 는 다음 pull 이 옮길 것과 옮기지 않을 것을 보이고 볼트는 둔다", async () => {
    await seed({ "A/c.md": "c\n", "B/b.md": "b\n", "A/d.md": "d\n", "B/d.md": "other\n" });
    moveInNotion("A/c.md", "B");
    moveInNotion("A/d.md", "B");

    const status = await orchestrator.status();

    expect(status.remoteMoves).toEqual([{ from: "A/c.md", to: "B/c.md" }]);
    expect(status.remoteMoveSkipped).toEqual([
      { path: "A/d.md", reason: expect.stringContaining("B/d.md") },
    ]);
    expect(notes()).toEqual(["A/c.md", "A/d.md", "B/b.md", "B/d.md"]);
    expect((await orchestrator.pull()).moved).toEqual([{ from: "A/c.md", to: "B/c.md" }]);
  });

  it("루트로 옮긴 노트", async () => {
    await seed({ "A/c.md": "c\n", "A/a.md": "a\n" });
    moveInNotion("A/c.md", null);

    expect((await orchestrator.pull({ force: true })).moved).toEqual([
      { from: "A/c.md", to: "c.md" },
    ]);
    expect(notes()).toEqual(["A/a.md", "c.md"]);
  });

  it("폴더 노트는 폴더째 — 안의 노트 레코드도 새 경로로", async () => {
    await seed({ "P/P.md": "p\n", "P/child.md": "child\n", "B/b.md": "b\n" });
    const child = idOf("P/child.md");
    moveInNotion("P/P.md", "B");

    const result = await orchestrator.pull({ force: true });

    expect(result.moved).toEqual([{ from: "P", to: "B/P" }]);
    expect(notes()).toEqual(["B/P/P.md", "B/P/child.md", "B/b.md"]);
    expect(db.getByNotionId(child)?.obsidianPath).toBe("B/P/child.md");
    expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, moved: 0 });
  });

  it("자식 폴더를 둔 노트는 자식 폴더와 함께", async () => {
    await seed({ "N.md": "n\n", "N/sub.md": "sub\n", "B/b.md": "b\n" });
    moveInNotion("N.md", "B");

    const result = await orchestrator.pull({ force: true });

    expect(result.moved).toEqual([
      { from: "N.md", to: "B/N.md" },
      { from: "N", to: "B/N" },
    ]);
    expect(notes()).toEqual(["B/N.md", "B/N/sub.md", "B/b.md"]);
  });

  it("노트와 자식 폴더 중 하나를 옮기지 못하면 옮긴 것을 되돌린다", async () => {
    await seed({ "N.md": "n\n", "N/sub.md": "sub\n", "B/b.md": "b\n" });
    moveInNotion("N.md", "B");
    const fs = vault.fs();
    const real = vi.mocked(fs.moveFile).getMockImplementation()!;
    vi.mocked(fs.moveFile).mockImplementation(async (from, to) => {
      if (from === "N") throw new Error("EBUSY");
      await real(from, to);
    });
    const failing = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      fs,
    );

    const result = await failing.pull({ force: true });

    expect(result.moved).toEqual([]);
    expect(result.moveSkipped).toEqual([
      { path: "N.md", reason: expect.stringContaining("EBUSY") },
    ]);
    expect(notes()).toEqual(["B/b.md", "N.md", "N/sub.md"]);
    expect(db.getByPath("N.md")).not.toBeNull();
  });

  it("옮길 자리에 같은 이름이 있으면 옮기지 않고 까닭을 낸다", async () => {
    await seed({ "A/c.md": "c\n", "B/c.md": "other\n" });
    moveInNotion("A/c.md", "B");

    const result = await orchestrator.pull({ force: true });

    expect(result.moved).toEqual([]);
    expect(result.moveSkipped).toEqual([
      { path: "A/c.md", reason: expect.stringContaining("B/c.md") },
    ]);
    expect(notes()).toEqual(["A/c.md", "B/c.md"]);
    expect(vault.read("B/c.md")).toBe("other\n");
  });

  it("볼트에서 옮긴 것을 아직 올리지 않았으면 볼트가 먼저다", async () => {
    await seed({ "A/c.md": "c\n", "B/b.md": "b\n", "C/x.md": "x\n" });
    moveInNotion("A/c.md", "B");
    vault.rename("A/c.md", "C/c.md");

    const preview = await orchestrator.pull({ force: true, dryRun: true });
    const result = await orchestrator.pull({ force: true });
    expect(preview.moveSkipped).toEqual(result.moveSkipped);

    expect(result.moved).toEqual([]);
    expect(result.moveSkipped?.[0]?.path).toBe("C/c.md");
    expect(notes()).toEqual(["B/b.md", "C/c.md", "C/x.md"]);
    // 다음 push 가 Notion 을 볼트의 자리로 옮긴다.
    expect(await orchestrator.push()).toMatchObject({ moved: 1, failed: [] });
    expect(notion.pages.get(idOf("C/c.md"))!.parent).toBe(idOf("C"));
  });

  describe("DB 가 든 폴더", () => {
    const DB_ID = "db000000-0000-4000-8000-0000000000d1";
    /** 전체 대조를 pull 마다 — 발견한 DB 의 행을 처음 받는다. */
    const everyPull = (databases: DatabaseSyncConfig[] = []) =>
      new SyncOrchestrator(
        createConfig({
          notion: { token: "ntn_test_token", rootPageId: ROOT, databases },
          sync: { ...DEFAULT_CONFIG.sync, fullReconcileInterval: 0 },
          advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
        }),
        db,
        notion.client as never,
        vault.fs(),
      );
    const bases = () => [...vault.files.keys()].filter((path) => path.endsWith(".base")).sort();

    beforeEach(() => {
      notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
      notion.client.getDatabaseViewsConfig.mockResolvedValue({
        databaseId: DB_ID,
        lastSynced: "",
        views: [],
      });
    });

    it("발견한 DB 의 폴더 · .base 보기 · 행을 함께 옮기고 링크를 고친다 — 다시 돌려도 바뀌는 것이 없다", async () => {
      await seed({ "A/a.md": "a\n", "B/b.md": "b\n" });
      db.setMeta(
        "discovered_dbs",
        JSON.stringify([{ databaseId: DB_ID, localFolder: "A/Tasks", titleProperty: "Name" }]),
      );
      const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
      // 플러그인처럼 같은 오케스트레이터를 계속 쓴다 — 읽어 둔 `.base` 기록이 옮긴 뒤에도 맞아야 한다.
      const sync = everyPull();
      expect((await sync.pull()).failed).toEqual([]);
      expect(notes()).toContain("A/Tasks/행.md");
      const [base] = bases();
      expect(base).toMatch(/^A\/Tasks\/.+\.base$/);
      expect(vault.read(base!)).toContain('file.folder == "A/Tasks"');
      vault.write("x.md", `![[${base!}]] [[A/Tasks/행]]\n`);
      const mine = 'filters:\n  and:\n    - file.inFolder("A/Tasks")\n';
      vault.write("A/mine.base", mine);
      expect((await sync.push()).failed).toEqual([]);

      moveInNotion("A", "B");
      // 행 · DB 는 그대로다 — 이 pull 은 DB 를 조회하지 않는다(ADR-027). 보기 · 기록을 옮긴 쪽이 고쳐야 한다.
      const result = await orchestrator.pull();
      // 직접 만든 `.base` 는 함께 옮기되 내용은 둔다.
      expect(vault.read("B/A/mine.base")).toBe(mine);

      expect(result.failed).toEqual([]);
      expect(result.moved).toEqual([{ from: "A", to: "B/A" }]);
      const moved = `B/${base!}`;
      expect(bases()).toEqual([moved, "B/A/mine.base"]);
      expect(vault.read(moved)).toContain('file.folder == "B/A/Tasks"');
      expect(notes()).toEqual(["B/A/Tasks/행.md", "B/A/a.md", "B/b.md", "x.md"]);
      expect(vault.read("x.md")).toBe(`![[${moved}]] [[B/A/Tasks/행]]\n`);
      expect(db.getByNotionId(row.id)?.obsidianPath).toBe("B/A/Tasks/행.md");
      expect(JSON.parse(db.getMeta("discovered_dbs")!)).toMatchObject([
        { databaseId: DB_ID, localFolder: "B/A/Tasks" },
      ]);
      expect(Object.values(JSON.parse(db.getMeta("db_base_files")!))).toEqual([
        expect.objectContaining({ basePath: moved }),
      ]);

      // 같은 오케스트레이터가 DB 를 다시 받아도 옛 자리에 쓰지 않는다.
      const again = await sync.pull();
      expect(again).toMatchObject({ created: 0, updated: 0, deleted: 0, moved: [], failed: [] });
      expect([...vault.files.keys()].filter((path) => path.startsWith("A/"))).toEqual([]);
      expect(bases()).toEqual([moved, "B/A/mine.base"]);
      expect(await sync.push()).toMatchObject({ created: 0, updated: 0, moved: 0 });
    });

    it("DB 밖 페이지 아래로 옮긴 행은 페이지가 된다 — 하위 페이지 폴더와 함께, frontmatter 는 볼트에 둔다 (ADR-047)", async () => {
      await seed({ "B/b.md": "b\n" });
      db.setMeta(
        "discovered_dbs",
        JSON.stringify([{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }]),
      );
      const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
      const sync = everyPull();
      expect((await sync.pull()).failed).toEqual([]);
      vault.write("Tasks/행/아래.md", "아래 본문\n");
      expect((await sync.push()).failed).toEqual([]);
      const sub = { id: idOf("Tasks/행/아래.md") };
      expect(notes()).toEqual(["B/b.md", "Tasks/행.md", "Tasks/행/아래.md"]);
      const before = vault.read("Tasks/행.md");

      // Notion 에서 DB 밖으로 — 부모가 페이지가 되고 수정 시각은 그대로(실측 2026-10-30).
      Object.assign(notion.pages.get(row.id)!, { parent: idOf("B"), parentType: "page" });
      const preview = await sync.pull({ dryRun: true });
      expect(preview.moved).toEqual([
        { from: "Tasks/행.md", to: "B/행.md" },
        { from: "Tasks/행", to: "B/행" },
      ]);
      const result = await sync.pull();

      expect(result.failed).toEqual([]);
      expect(result).toMatchObject({ created: 0, deleted: 0 });
      expect(result.moved).toEqual(preview.moved);
      expect(notes()).toEqual(["B/b.md", "B/행.md", "B/행/아래.md"]);
      expect(vault.read("B/행.md")).toBe(before);
      expect(db.getByNotionId(row.id)).toMatchObject({
        obsidianPath: "B/행.md",
        fileType: "file",
        notionParentId: idOf("B"),
      });
      expect(db.getByNotionId(sub.id)?.obsidianPath).toBe("B/행/아래.md");

      expect(await sync.pull()).toMatchObject({ created: 0, updated: 0, deleted: 0, moved: [] });
      expect(await sync.push()).toMatchObject({ created: 0, updated: 0, moved: 0, failed: [] });
    });

    it("다른 DB 로 옮긴 행은 그 DB 폴더로 — 하위 페이지 폴더와 함께 옮기고 링크를 고친다 (ADR-047)", async () => {
      const OTHER = "db000000-0000-4000-8000-0000000000d2";
      db.setMeta(
        "discovered_dbs",
        JSON.stringify([
          { databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" },
          { databaseId: OTHER, localFolder: "Other", titleProperty: "Name" },
        ]),
      );
      const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
      notion.add(OTHER, "남", "남 본문", { properties: {} });
      const sync = everyPull();
      expect((await sync.pull()).failed).toEqual([]);
      vault.write("Tasks/행/아래.md", "아래 본문\n");
      vault.write("x.md", "[[Tasks/행]]\n");
      expect((await sync.push()).failed).toEqual([]);
      const sub = idOf("Tasks/행/아래.md");

      // 데이터 소스 사이 이동 — 수정 시각은 그대로다.
      Object.assign(notion.pages.get(row.id)!, { parent: OTHER, parentType: "database" });
      const preview = await sync.pull({ dryRun: true });
      expect(preview.moved).toEqual([
        { from: "Tasks/행.md", to: "Other/행.md" },
        { from: "Tasks/행", to: "Other/행" },
      ]);
      const result = await sync.pull();

      expect(result.failed).toEqual([]);
      expect(result.moved).toEqual(preview.moved);
      expect(result).toMatchObject({ created: 0, deleted: 0, updated: preview.updated });
      expect(notes()).toEqual(["Other/남.md", "Other/행.md", "Other/행/아래.md", "x.md"]);
      expect(vault.read("Other/행.md")).toContain("행 본문");
      expect(vault.read("x.md")).toBe("[[Other/행]]\n");
      expect(db.getByNotionId(row.id)).toMatchObject({
        obsidianPath: "Other/행.md",
        fileType: "db-row",
        notionParentId: OTHER,
      });
      expect(db.getByNotionId(sub)?.obsidianPath).toBe("Other/행/아래.md");

      expect(await sync.pull()).toMatchObject({ created: 0, updated: 0, deleted: 0, moved: [] });
      expect(await sync.push()).toMatchObject({ created: 0, updated: 0, moved: 0, failed: [] });
    });

    it("DB 안으로 옮긴 페이지는 행이 된다 — 폴더 노트의 폴더 · 노트의 자식 폴더는 행의 하위 페이지 폴더로 (ADR-047)", async () => {
      await seed({ "P/P.md": "p\n", "P/c.md": "c\n", "N.md": "n\n", "N/sub.md": "sub\n" });
      db.setMeta(
        "discovered_dbs",
        JSON.stringify([{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }]),
      );
      notion.add(DB_ID, "행", "행 본문", { properties: {} });
      const sync = everyPull();
      expect((await sync.pull()).failed).toEqual([]);
      const [p, c, n, sub] = ["P/P.md", "P/c.md", "N.md", "N/sub.md"].map(idOf);

      for (const id of [p, n]) {
        Object.assign(notion.pages.get(id!)!, { parent: DB_ID, parentType: "database" });
      }
      const preview = await sync.pull({ dryRun: true });
      expect(notes()).toContain("P/P.md");
      const result = await sync.pull();

      expect(result.failed).toEqual([]);
      expect(result.moved).toEqual([
        { from: "N.md", to: "Tasks/N.md" },
        { from: "N", to: "Tasks/N" },
        { from: "P/P.md", to: "Tasks/P.md" },
        { from: "P", to: "Tasks/P" },
      ]);
      expect(preview.moved).toEqual(result.moved);
      expect(preview.updated).toBe(result.updated);
      expect(notes()).toEqual([
        "Tasks/N.md",
        "Tasks/N/sub.md",
        "Tasks/P.md",
        "Tasks/P/c.md",
        "Tasks/행.md",
      ]);
      expect([...vault.folders].filter((f) => f === "P" || f === "N")).toEqual([]);
      expect(db.getByNotionId(p!)).toMatchObject({
        obsidianPath: "Tasks/P.md",
        fileType: "db-row",
      });
      expect(db.getByNotionId(c!)?.obsidianPath).toBe("Tasks/P/c.md");
      expect(db.getByNotionId(n!)).toMatchObject({
        obsidianPath: "Tasks/N.md",
        fileType: "db-row",
      });
      expect(db.getByNotionId(sub!)?.obsidianPath).toBe("Tasks/N/sub.md");

      expect(await sync.pull()).toMatchObject({ created: 0, updated: 0, deleted: 0, moved: [] });
      expect(await sync.push()).toMatchObject({ created: 0, updated: 0, moved: 0, failed: [] });
    });

    it("DB 안으로 옮긴 페이지의 frontmatter 는 비어 있는 열에 지우지 않고 다음 push 가 행의 속성으로 올린다 (ADR-047)", async () => {
      notion.client.getDatabaseSchema.mockResolvedValue({
        Name: { id: "title", type: "title" },
        저자: { id: "a", type: "rich_text" },
      });
      await seed({ "M.md": "---\n저자: 김\n메모: 볼트만\n---\n본문\n" });
      db.setMeta(
        "discovered_dbs",
        JSON.stringify([{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }]),
      );
      notion.add(DB_ID, "행", "행 본문", { properties: {} });
      const sync = everyPull();
      expect((await sync.pull()).failed).toEqual([]);
      const m = idOf("M.md");

      // 페이지의 frontmatter 는 본문 첫머리의 속성 블록으로 올라가 있다. DB 로 옮기면 행은 그 열을 빈 값으로 갖는다(실측).
      expect(notion.pages.get(m)!.body).toContain(":properties");
      Object.assign(notion.pages.get(m)!, {
        parent: DB_ID,
        parentType: "database",
        properties: { 저자: { type: "rich_text", rich_text: [] } },
      });
      const result = await sync.pull();

      expect(result.failed).toEqual([]);
      const note = vault.read("Tasks/M.md");
      expect(note).not.toContain(":properties");
      expect(note).toContain("저자: 김");
      expect(note).toContain("메모: 볼트만");
      expect(note).toContain("본문");
      // push 전에 다시 받아도 볼트 값을 지우거나 충돌로 올리지 않는다.
      expect(await sync.pull({ force: true })).toMatchObject({
        updated: 0,
        conflicts: [],
        failed: [],
      });
      expect(vault.read("Tasks/M.md")).toBe(note);
      const push = await sync.push();
      expect(push).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(m)!.properties.저자).toMatchObject({
        rich_text: [expect.objectContaining({ plain_text: "김" })],
      });
      // 페이지 시절의 속성 블록은 그 push 가 걷어 낸다.
      expect(notion.pages.get(m)!.body).not.toContain(":properties");
      expect(notion.pages.get(m)!.body).toContain("본문");
      expect(await sync.pull()).toMatchObject({ created: 0, updated: 0, deleted: 0, moved: [] });
      expect(await sync.push()).toMatchObject({ created: 0, updated: 0, moved: 0, failed: [] });
      expect(vault.read("Tasks/M.md")).toBe(note);
    });

    describe("양쪽에서 옮긴 노트 — 볼트가 먼저 (ADR-047)", () => {
      const OTHER = "db000000-0000-4000-8000-0000000000d2";
      const notionParent = (id: string) => {
        const page = notion.pages.get(id)!;
        return { parent: page.parent, parentType: page.parentType ?? "page" };
      };

      async function setup() {
        notion.client.getDatabaseMeta.mockImplementation(async (id: string) => ({
          ...mockDatabaseMeta(id),
          dataSources: [{ id, name: "" }],
        }));
        await seed({ "A/c.md": "c\n", "B/b.md": "b\n" });
        db.setMeta(
          "discovered_dbs",
          JSON.stringify([
            { databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" },
            { databaseId: OTHER, localFolder: "Other", titleProperty: "Name" },
          ]),
        );
        const row = notion.add(DB_ID, "행", "행 본문", { properties: {} });
        notion.add(OTHER, "남", "남 본문", { properties: {} });
        const sync = everyPull();
        expect((await sync.pull()).failed).toEqual([]);
        return { sync, page: idOf("A/c.md"), row: row.id };
      }

      /** 볼트에서 옮기고 Notion 에서도 다른 곳으로 옮긴 뒤 pull · push — Notion 이 볼트의 자리를 따라야 한다. */
      async function bothMoved(
        sync: SyncOrchestrator,
        id: string,
        vaultTo: string,
        notionTo: { parent: string; parentType: string },
      ) {
        const from = db.getByNotionId(id)!.obsidianPath;
        vault.rename(from, vaultTo);
        Object.assign(notion.pages.get(id)!, notionTo);
        const preview = await sync.pull({ dryRun: true });
        const result = await sync.pull();
        expect(result.failed).toEqual([]);
        expect(result.moved).toEqual([]);
        expect(preview.moved).toEqual([]);
        expect(preview.moveSkipped).toEqual(result.moveSkipped);
        expect(result).toMatchObject({ created: 0, deleted: 0 });
        expect(notes()).toContain(vaultTo);
        expect(notes()).not.toContain(from);
        expect((await sync.push()).failed).toEqual([]);
        expect(db.getByNotionId(id)?.obsidianPath).toBe(vaultTo);
        expect(await sync.pull()).toMatchObject({ created: 0, deleted: 0, moved: [] });
        expect(await sync.push()).toMatchObject({ created: 0, moved: 0, failed: [] });
        expect(notes().filter((path) => path.endsWith("/" + vaultTo.split("/").pop()))).toEqual([
          vaultTo,
        ]);
      }

      it("볼트는 페이지를 DB 폴더로 · Notion 은 다른 페이지 아래로", async () => {
        const { sync, page } = await setup();
        await bothMoved(sync, page, "Tasks/c.md", { parent: idOf("B"), parentType: "page" });
        expect(notionParent(page).parent).toBe(DB_ID);
        expect(db.getByNotionId(page)?.fileType).toBe("db-row");
      });

      it("볼트는 페이지를 DB 폴더로 · Notion 은 다른 DB 안으로", async () => {
        const { sync, page } = await setup();
        await bothMoved(sync, page, "Tasks/c.md", { parent: OTHER, parentType: "database" });
        expect(notionParent(page).parent).toBe(DB_ID);
      });

      it("볼트는 행을 DB 밖으로 · Notion 은 다른 DB 안으로", async () => {
        const { sync, row } = await setup();
        await bothMoved(sync, row, "B/행.md", { parent: OTHER, parentType: "database" });
        expect(notionParent(row)).toEqual({ parent: idOf("B"), parentType: "page" });
        expect(db.getByNotionId(row)?.fileType).not.toBe("db-row");
      });

      it("볼트는 행을 다른 DB 폴더로 · Notion 은 DB 밖으로", async () => {
        const { sync, row } = await setup();
        await bothMoved(sync, row, "Other/행.md", { parent: idOf("B"), parentType: "page" });
        expect(notionParent(row).parent).toBe(OTHER);
        expect(db.getByNotionId(row)?.fileType).toBe("db-row");
      });
    });

    describe("Notion 에서 옮긴 DB (ADR-047)", () => {
      /** Notion 이 돌려주는 DB 의 부모 — `notion.databases` 에 적은 자리. */
      const placeInNotion = (parent: string | null) => {
        notion.databases.set(DB_ID, { parent: parent ?? ROOT, title: "Tasks" });
      };
      beforeEach(() => {
        notion.client.getDatabaseMeta.mockImplementation(async (id: string) => ({
          ...mockDatabaseMeta(id),
          parentPageId: notion.databases.get(id)?.parent ?? null,
        }));
      });

      async function shelf(): Promise<{ sync: SyncOrchestrator; row: string; base: string }> {
        await seed({ "A/a.md": "a\n", "B/b.md": "b\n" });
        db.setMeta(
          "discovered_dbs",
          JSON.stringify([{ databaseId: DB_ID, localFolder: "A/Tasks", titleProperty: "Name" }]),
        );
        placeInNotion(idOf("A"));
        const row = notion.add(DB_ID, "행", "행 본문", { properties: {} }).id;
        const sync = everyPull();
        expect((await sync.pull()).failed).toEqual([]);
        const [base] = bases();
        vault.write("x.md", `![[${base!}]] [[A/Tasks/행]]\n`);
        expect((await sync.push()).failed).toEqual([]);
        return { sync, row, base: base! };
      }

      it("다른 페이지 아래로 옮긴 DB 는 폴더 · 행 · .base 보기를 그 페이지의 폴더로 옮기고 링크를 고친다", async () => {
        const { sync, row, base } = await shelf();
        placeInNotion(idOf("B"));

        const preview = await sync.pull({ dryRun: true });
        expect(preview.moved).toEqual([{ from: "A/Tasks", to: "B/Tasks" }]);
        expect(notes()).toContain("A/Tasks/행.md");

        const result = await sync.pull();
        expect(result.failed).toEqual([]);
        expect(result.moved).toEqual(preview.moved);
        expect(result).toMatchObject({ created: preview.created, updated: preview.updated });
        const moved = base.replace(/^A\//, "B/");
        expect(bases()).toEqual([moved]);
        expect(vault.read(moved)).toContain('file.folder == "B/Tasks"');
        expect(notes()).toEqual(["A/a.md", "B/Tasks/행.md", "B/b.md", "x.md"]);
        expect(vault.read("x.md")).toBe(`![[${moved}]] [[B/Tasks/행]]\n`);
        expect(db.getByNotionId(row)?.obsidianPath).toBe("B/Tasks/행.md");
        expect(JSON.parse(db.getMeta("discovered_dbs")!)).toMatchObject([
          { databaseId: DB_ID, localFolder: "B/Tasks" },
        ]);

        // Notion 은 이미 그 자리다 — push 가 DB 를 다시 옮기지 않는다.
        expect(await sync.push()).toMatchObject({ created: 0, updated: 0, moved: 0, failed: [] });
        expect(notion.client.updateDatabasePlacement).not.toHaveBeenCalled();
        expect(await sync.pull()).toMatchObject({ created: 0, updated: 0, moved: [], failed: [] });
      });

      it("루트로 옮긴 DB 는 databases 선반으로 — 맨 위 폴더에 둔 DB 는 루트 아래 그대로", async () => {
        const { sync } = await shelf();
        placeInNotion(null);
        expect((await sync.pull()).moved).toEqual([{ from: "A/Tasks", to: "databases/Tasks" }]);
        expect(notes()).toContain("databases/Tasks/행.md");
        expect(await sync.push()).toMatchObject({ moved: 0, failed: [] });
        expect(notion.client.updateDatabasePlacement).not.toHaveBeenCalled();

        // 볼트에서 맨 위로 옮긴 DB — push 가 루트 아래에 둔다. 다음 pull 이 선반으로 되돌리지 않는다.
        vault.renameFolder("databases/Tasks", "Tasks");
        expect((await sync.push()).failed).toEqual([]);
        expect(await sync.pull()).toMatchObject({ moved: [], failed: [] });
        expect(notes()).toContain("Tasks/행.md");
      });

      it("볼트에서 옮긴 DB 폴더를 아직 올리지 않았거나 · 부모가 블록 안 · 볼트가 모르는 페이지면 옮기지 않는다", async () => {
        const { sync } = await shelf();
        db.setMeta(
          "db_moves_pending",
          JSON.stringify([{ databaseId: DB_ID, from: "B/Tasks", to: "A/Tasks" }]),
        );
        placeInNotion(idOf("B"));
        expect(await sync.pull()).toMatchObject({ moved: [], failed: [] });
        db.setMeta("db_moves_pending", "[]");

        notion.client.getDatabaseMeta.mockImplementation(async (id: string) => ({
          ...mockDatabaseMeta(id),
          parentPageId: null,
        }));
        expect(await sync.pull()).toMatchObject({ moved: [], failed: [] });

        placeInNotion("eeee0000-0000-4000-8000-00000000000e");
        notion.client.getDatabaseMeta.mockImplementation(async (id: string) => ({
          ...mockDatabaseMeta(id),
          parentPageId: notion.databases.get(id)?.parent ?? null,
        }));
        expect(await sync.pull()).toMatchObject({ moved: [], failed: [] });
        expect(notes()).toContain("A/Tasks/행.md");
      });

      it("옮길 자리에 같은 이름이 있으면 옮기지 않고 옛 자리에서 받는다", async () => {
        const { sync } = await shelf();
        vault.write("B/Tasks/남의 것.md", "x\n");
        placeInNotion(idOf("B"));
        const result = await sync.pull();
        expect(result).toMatchObject({ moved: [], failed: [] });
        expect(notes()).toContain("A/Tasks/행.md");
      });
    });

    it("설정 파일로 정한 DB 의 폴더는 옮기지 않는다 — 설정을 고쳐 적을 수 없다", async () => {
      await seed({ "A/a.md": "a\n", "B/b.md": "b\n" });
      moveInNotion("A", "B");

      const result = await everyPull([
        { databaseId: DB_ID, localFolder: "A/Tasks", titleProperty: "Name" },
      ]).pull();

      expect(result.moved).toEqual([]);
      expect(result.moveSkipped).toEqual([
        { path: "A", reason: expect.stringContaining("notion.databases") },
      ]);
      expect(notes()).toEqual(expect.arrayContaining(["A/a.md", "B/b.md"]));
    });
  });

  it("dry-run 은 옮길 것만 알리고 쓰지 않는다", async () => {
    await seed({ "A/c.md": "c\n", "B/b.md": "b\n" });
    moveInNotion("A/c.md", "B");

    const result = await orchestrator.pull({ force: true, dryRun: true });

    expect(result.moved).toEqual([{ from: "A/c.md", to: "B/c.md" }]);
    expect(notes()).toEqual(["A/c.md", "B/b.md"]);
    expect(db.getByPath("A/c.md")).not.toBeNull();
  });

  it("경로를 좁힌 pull 은 범위 밖의 이동을 옮기지 않는다", async () => {
    await seed({ "A/c.md": "c\n", "B/b.md": "b\n" });
    moveInNotion("A/c.md", "B");

    const result = await orchestrator.pull({ force: true, paths: ["B"] });

    expect(result.moved).toEqual([]);
    expect(notes()).toEqual(["A/c.md", "B/b.md"]);
  });
});
