/**
 * Notion 에서 바꾼 제목으로 노트 이름을 바꾼다(`sync.renameOnTitleChange`) — 다른 노트의 링크도 고친다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로 이어 쓴다.
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

describe("Notion 에서 바꾼 제목으로 노트 이름을 바꾼다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-rename-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function orchestrator(renameOnTitleChange = true): SyncOrchestrator {
    return new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, renameOnTitleChange },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
  }

  const notes = () => [...vault.files.keys()].filter((path) => path.endsWith(".md")).sort();
  const idOf = (path: string) => db.getByPath(path)!.notionPageId!;
  const retitle = (path: string, title: string) =>
    notion.edit(idOf(path), (page) => {
      page.title = title;
    });

  async function seed(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) vault.write(path, content);
    expect((await orchestrator().push()).failed).toEqual([]);
  }

  it("끄면(기본) 이름은 두고 새 제목을 frontmatter 에 적는다", async () => {
    await seed({ "A/old.md": "old\n" });
    retitle("A/old.md", "new");

    const result = await orchestrator(false).pull({ force: true });

    expect(result.moved ?? []).toEqual([]);
    expect(notes()).toEqual(["A/old.md"]);
    expect(vault.read("A/old.md")).toContain("title: new");
  });

  it("노트 이름을 바꾸고 다른 노트의 링크를 고친다 — 다시 돌려도 바뀌는 것이 없다", async () => {
    await seed({
      "A/old.md": "old\n",
      "B/b.md": "see [[old]] and [[A/old#H|x]] and [md](../A/old.md)\n",
    });
    const id = idOf("A/old.md");
    retitle("A/old.md", "new");

    const result = await orchestrator().pull({ force: true });

    expect(result.failed).toEqual([]);
    expect(result.moved).toEqual([{ from: "A/old.md", to: "A/new.md", renamed: true }]);
    expect(result.relinked).toEqual(["B/b.md"]);
    expect(notes()).toEqual(["A/new.md", "B/b.md"]);
    expect(vault.read("A/new.md")).toBe("old\n");
    expect(vault.read("B/b.md")).toBe("see [[new]] and [[A/new#H|x]] and [md](../A/new.md)\n");
    expect(db.getByNotionId(id)?.obsidianPath).toBe("A/new.md");
    expect(db.resolvePageId(id)).toMatchObject({ obsidianPath: "A/new.md", title: "new" });

    expect(await orchestrator().push()).toMatchObject({
      created: 0,
      updated: 0,
      moved: 0,
      failed: [],
    });
    expect(await orchestrator().pull({ force: true })).toMatchObject({
      created: 0,
      updated: 0,
      moved: [],
      relinked: [],
    });
    expect(notion.pages.get(id)!.title).toBe("new");
  });

  it("자식 폴더를 둔 노트는 자식 폴더 이름도 — 경로로 적은 링크를 고친다", async () => {
    await seed({ "N.md": "n\n", "N/sub.md": "sub\n", "x.md": "[[N/sub]] [[sub]]\n" });
    retitle("N.md", "M");

    const result = await orchestrator().pull({ force: true });

    expect(result.moved).toEqual([{ from: "N.md", to: "M.md", renamed: true }]);
    expect(notes()).toEqual(["M.md", "M/sub.md", "x.md"]);
    expect(vault.read("x.md")).toBe("[[M/sub]] [[sub]]\n");
  });

  it("폴더 노트는 폴더와 노트 이름을 함께", async () => {
    await seed({ "P/P.md": "p\n", "P/child.md": "c\n", "x.md": "[[P]] [[P/child]]\n" });
    const child = idOf("P/child.md");
    retitle("P/P.md", "Q");

    const result = await orchestrator().pull({ force: true });

    expect(result.failed).toEqual([]);
    expect(result.moved).toEqual([{ from: "P/P.md", to: "Q/Q.md", renamed: true }]);
    expect(notes()).toEqual(["Q/Q.md", "Q/child.md", "x.md"]);
    expect(vault.read("x.md")).toBe("[[Q]] [[Q/child]]\n");
    expect(db.getByNotionId(child)?.obsidianPath).toBe("Q/child.md");
    expect(await orchestrator().push()).toMatchObject({ created: 0, updated: 0, moved: 0 });
  });

  it("새 이름이 차 있으면 새 페이지를 받을 때처럼 id 를 붙인다", async () => {
    await seed({ "A/old.md": "old\n", "A/new.md": "other\n" });
    const id = idOf("A/old.md");
    retitle("A/old.md", "new");

    const result = await orchestrator().pull({ force: true });

    const suffixed = `A/new (${id.replace(/-/g, "").slice(0, 8)}).md`;
    expect(result.moved).toEqual([{ from: "A/old.md", to: suffixed, renamed: true }]);
    expect(vault.read("A/new.md")).toBe("other\n");
    expect(await orchestrator().pull({ force: true })).toMatchObject({ moved: [] });
  });

  it("파일 이름과 따로 정한 제목이면 이름을 바꾸지 않는다", async () => {
    await seed({ "foo.md": "---\ntitle: Bar\n---\nbody\n" });
    retitle("foo.md", "Baz");

    const result = await orchestrator().pull({ force: true });

    expect(result.moved ?? []).toEqual([]);
    expect(notes()).toEqual(["foo.md"]);
  });

  it("볼트에서 옮긴 것을 아직 올리지 않았으면 볼트가 먼저다", async () => {
    await seed({ "A/old.md": "old\n", "C/x.md": "x\n" });
    retitle("A/old.md", "new");
    vault.rename("A/old.md", "C/old.md");

    const result = await orchestrator().pull({ force: true });

    expect(result.moved ?? []).toEqual([]);
    expect(notes()).toContain("C/old.md");
  });

  it("status 는 다음 pull 이 바꿀 이름을 보인다 — 끄면 보이지 않는다", async () => {
    await seed({ "A/old.md": "old\n" });
    retitle("A/old.md", "new");

    expect((await orchestrator().status()).remoteMoves).toEqual([
      { from: "A/old.md", to: "A/new.md", renamed: true },
    ]);
    expect((await orchestrator(false).status()).remoteMoves).toEqual([]);
    expect(notes()).toEqual(["A/old.md"]);
  });

  it("dry-run 은 바꿀 것만 알리고 쓰지 않는다", async () => {
    await seed({ "A/old.md": "old\n", "B/b.md": "[[old]]\n" });
    retitle("A/old.md", "new");

    const result = await orchestrator().pull({ force: true, dryRun: true });

    expect(result.moved).toEqual([{ from: "A/old.md", to: "A/new.md", renamed: true }]);
    expect(notes()).toEqual(["A/old.md", "B/b.md"]);
    expect(vault.read("B/b.md")).toBe("[[old]]\n");
  });

  describe("DB 행", () => {
    const DB_ID = "db000000-0000-4000-8000-0000000000d1";
    const rows = (renameOnTitleChange = true) =>
      new SyncOrchestrator(
        createConfig({
          notion: {
            token: "ntn_test_token",
            rootPageId: ROOT,
            databases: [{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
          },
          sync: { ...DEFAULT_CONFIG.sync, renameOnTitleChange },
          advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
        }),
        db,
        notion.client as never,
        vault.fs(),
      );

    beforeEach(() => {
      notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
      notion.client.getDatabaseViewsConfig.mockResolvedValue({
        databaseId: DB_ID,
        lastSynced: "",
        views: [],
      });
    });

    it("행 이름과 하위 페이지 폴더를 바꾸고 링크를 고친다 — 다시 돌려도 바뀌는 것이 없다", async () => {
      const row = notion.add(DB_ID, "옛 행", "행 본문", { properties: {} });
      notion.add(row.id, "하위", "하위 본문");
      notion.add(ROOT, "메모", "[[옛 행]] · [[Tasks/옛 행/하위]]");
      expect((await rows().pull()).failed).toEqual([]);
      expect(notes()).toEqual(["Tasks/옛 행.md", "Tasks/옛 행/하위.md", "메모.md"]);
      vault.write("메모.md", "[[옛 행]] · [[Tasks/옛 행/하위]]\n");
      expect((await rows().push()).failed).toEqual([]);

      notion.edit(row.id, (page) => {
        page.title = "새 행";
      });
      const result = await rows().pull({ force: true });

      expect(result.failed).toEqual([]);
      expect(result.moved).toEqual([
        { from: "Tasks/옛 행.md", to: "Tasks/새 행.md", renamed: true },
      ]);
      expect(notes()).toEqual(["Tasks/새 행.md", "Tasks/새 행/하위.md", "메모.md"]);
      expect(vault.read("메모.md")).toBe("[[새 행]] · [[Tasks/새 행/하위]]\n");
      expect(db.getByNotionId(row.id)?.obsidianPath).toBe("Tasks/새 행.md");
      expect(await rows().push()).toMatchObject({ created: 0, updated: 0, moved: 0, failed: [] });
      expect(await rows().pull({ force: true })).toMatchObject({
        created: 0,
        updated: 0,
        moved: [],
      });
    });

    it("끄면(기본) 행 이름은 두고 제목만 받는다", async () => {
      const row = notion.add(DB_ID, "옛 행", "행 본문", { properties: {} });
      expect((await rows(false).pull()).failed).toEqual([]);
      notion.edit(row.id, (page) => {
        page.title = "새 행";
      });

      const result = await rows(false).pull({ force: true });

      expect(result.moved ?? []).toEqual([]);
      expect(notes()).toEqual(["Tasks/옛 행.md"]);
      expect(vault.read("Tasks/옛 행.md")).toContain("title: 새 행");
    });
  });

  it("Notion 에서 옮긴 페이지를 가리키던 경로 링크도 고친다", async () => {
    await seed({ "A/c.md": "c\n", "B/b.md": "b\n", "x.md": "[[A/c]] [[c]]\n" });
    notion.pages.get(idOf("A/c.md"))!.parent = idOf("B");

    const result = await orchestrator(false).pull({ force: true });

    expect(result.moved).toEqual([{ from: "A/c.md", to: "B/c.md" }]);
    expect(result.relinked).toEqual(["x.md"]);
    expect(vault.read("x.md")).toBe("[[B/c]] [[c]]\n");
    expect(await orchestrator(false).push()).toMatchObject({ created: 0, updated: 0, moved: 0 });
  });
});
