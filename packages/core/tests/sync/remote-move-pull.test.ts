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
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
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

    const result = await orchestrator.pull({ force: true });

    expect(result.moved).toEqual([]);
    expect(result.moveSkipped?.[0]?.path).toBe("C/c.md");
    expect(notes()).toEqual(["B/b.md", "C/c.md", "C/x.md"]);
    // 다음 push 가 Notion 을 볼트의 자리로 옮긴다.
    expect(await orchestrator.push()).toMatchObject({ moved: 1, failed: [] });
    expect(notion.pages.get(idOf("C/c.md"))!.parent).toBe(idOf("C"));
  });

  it("DB 폴더를 품은 폴더는 옮기지 않는다 — .base 보기가 경로를 품는다", async () => {
    await seed({ "A/a.md": "a\n", "B/b.md": "b\n" });
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: "db-1", localFolder: "A/Tasks", titleProperty: "Name" }]),
    );
    moveInNotion("A", "B");

    const result = await orchestrator.pull({ force: true });

    expect(result.moved).toEqual([]);
    expect(result.moveSkipped?.[0]?.path).toBe("A");
    expect(notes()).toEqual(["A/a.md", "B/b.md"]);
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
