/**
 * S-15 — 폴더 노트 `F/F.md` 가 폴더 F 의 페이지다(pull 이 그렇게 받는다).
 *
 * 예전 push 는 새 폴더의 페이지를 먼저 만들고, 같은 push 의 폴더 노트를 그 아래에 만들었다. Notion
 * 에 같은 이름의 페이지가 두 겹으로 생기고, 형제 노트는 어느 쪽이 먼저 생겼느냐에 따라 두 부모로
 * 갈렸다. 다음 push 는 폴더 레코드를 지워 폴더 페이지를 추적에서 놓았고, 그다음 pull 이 그 페이지를
 * 새 페이지로 받아 `(id)` 이름의 파일로 썼다.
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
import { computeHash } from "../../src/utils/hash.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";

describe("폴더 노트가 폴더의 페이지다 (S-15)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-foldernote-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    orchestrator = new SyncOrchestrator(
      createConfig({ advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 } }),
      db,
      notion.client as never,
      vault.fs(),
    );
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const pageOf = (path: string) => notion.pages.get(db.getByPath(path)!.notionPageId!)!;
  const titled = (title: string) =>
    [...notion.pages.values()].filter((page) => page.title === title && !page.archived);
  const incompleteOps = () => db.getIncompletePendingOperations();
  const idle = { created: 0, updated: 0, deleted: 0, failed: [] };

  /** 처음 동기화 — push 가 만든 레코드를 이후 시험이 그대로 쓴다. */
  async function seed(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) vault.write(path, content);
    const result = await orchestrator.push();
    expect(result.failed).toEqual([]);
    notion.client.createPageWithMarkdown.mockClear();
    notion.client.createPage.mockClear();
    notion.client.movePage.mockClear();
    notion.client.updatePageProperties.mockClear();
    notion.client.replacePageMarkdown.mockClear();
  }

  it("새 폴더와 폴더 노트 · 형제 · 하위 폴더를 한 번에 올리면 폴더 노트가 폴더의 페이지다", async () => {
    vault.write("A/A.md", "# A\n\nFolder body\n");
    vault.write("A/x.md", "# X\n");
    vault.write("A/B/w.md", "# W\n");

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 3, updated: 0, failed: [] });
    // 폴더 A 의 페이지는 폴더 노트 하나다 — 루트 바로 아래.
    expect(db.getByPath("A")).toBeNull();
    expect(titled("A")).toHaveLength(1);
    const folderNote = pageOf("A/A.md");
    expect(folderNote.parent).toBe(ROOT);
    // 형제와 하위 폴더는 폴더 노트 아래로 — 먼저 생긴 쪽에 따라 갈리지 않는다.
    expect(pageOf("A/x.md").parent).toBe(folderNote.id);
    const folderB = pageOf("A/B");
    expect(folderB.parent).toBe(folderNote.id);
    expect(pageOf("A/B/w.md").parent).toBe(folderB.id);
    expect(incompleteOps()).toEqual([]);

    expect(await orchestrator.push()).toMatchObject(idle);
    expect(db.getByPath("A/A.md")!.notionPageId).toBe(folderNote.id);
  });

  it("폴더 노트가 겹쳐 있으면 폴더 페이지를 하나도 만들지 않는다", async () => {
    vault.write("A/A.md", "# A\n");
    vault.write("A/B/B.md", "# B\n");
    vault.write("A/B/c.md", "# C\n");

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 3, failed: [] });
    expect(notion.client.createPage).not.toHaveBeenCalled();
    expect(db.getByPath("A")).toBeNull();
    expect(db.getByPath("A/B")).toBeNull();
    const a = pageOf("A/A.md");
    const b = pageOf("A/B/B.md");
    expect(a.parent).toBe(ROOT);
    expect(b.parent).toBe(a.id);
    expect(pageOf("A/B/c.md").parent).toBe(b.id);

    expect(await orchestrator.push()).toMatchObject(idle);
  });

  it("push 가 만든 폴더 페이지에 폴더 노트를 더하면 그 페이지를 폴더 노트의 페이지로 삼는다", async () => {
    await seed({ "P/x.md": "# X\n" });
    const folderPage = db.getByPath("P")!.notionPageId!;

    vault.write("P/P.md", "# P\n\nNow a folder note\n");
    // dry-run 은 새 노트로 세고 레코드를 옮겨 적지 않는다.
    expect(await orchestrator.push({ dryRun: true })).toMatchObject({ created: 1, failed: [] });
    expect(db.getByPath("P")!.notionPageId).toBe(folderPage);
    const result = await orchestrator.push();

    // 새로 만들지 않고 폴더 페이지의 본문을 채운다 — 하위 페이지 · 페이지 id 가 그대로다.
    expect(result).toMatchObject({ created: 1, updated: 0, failed: [] });
    expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
    expect(notion.client.createPage).not.toHaveBeenCalled();
    expect(notion.client.replacePageMarkdown.mock.calls[0]![0]).toBe(folderPage);
    expect(db.getByPath("P")).toBeNull();
    expect(db.getByPath("P/P.md")!.notionPageId).toBe(folderPage);
    // 제목은 폴더 이름 그대로 — frontmatter title 이 없으면 보내지 않는다.
    expect(notion.pages.get(folderPage)!.title).toBe("P");
    expect(notion.client.updatePageProperties).not.toHaveBeenCalled();
    expect(pageOf("P/x.md").parent).toBe(folderPage);
    expect(incompleteOps()).toEqual([]);

    expect(await orchestrator.push()).toMatchObject(idle);
  });

  it("삼은 폴더 노트에 frontmatter title 이 있으면 페이지 제목을 그것으로 바꾼다", async () => {
    await seed({ "P/x.md": "# X\n" });
    const folderPage = db.getByPath("P")!.notionPageId!;

    vault.write("P/P.md", "---\ntitle: Project P\n---\n# P\n");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    expect(notion.pages.get(folderPage)!.title).toBe("Project P");
    expect(await orchestrator.push()).toMatchObject(idle);
  });

  it("범위를 좁혀 형제만 올린 뒤 폴더 노트를 올리면 앞서 만든 폴더 페이지를 삼는다", async () => {
    vault.write("A/A.md", "# A\n");
    vault.write("A/x.md", "# X\n");

    const scoped = await orchestrator.push({ paths: ["A/x.md"] });
    expect(scoped).toMatchObject({ created: 1, failed: [] });
    const folderPage = db.getByPath("A")!.notionPageId!;
    expect(pageOf("A/x.md").parent).toBe(folderPage);
    expect(db.getByPath("A/A.md")).toBeNull();
    notion.client.createPageWithMarkdown.mockClear();
    notion.client.createPage.mockClear();

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
    expect(notion.client.createPage).not.toHaveBeenCalled();
    expect(db.getByPath("A")).toBeNull();
    expect(db.getByPath("A/A.md")!.notionPageId).toBe(folderPage);
    expect(titled("A")).toHaveLength(1);
    expect(await orchestrator.push()).toMatchObject(idle);
  });

  it("폴더 노트 생성의 응답을 잃으면 폴더 페이지를 따로 만들지 않고, 재시도가 그 페이지를 찾아 이어 쓴다", async () => {
    vault.write("A/A.md", "# A\n");
    vault.write("A/x.md", "# X\n");
    vault.write("A/B/w.md", "# W\n");
    // 생성 요청은 적용됐는데 응답을 잃는다(504) — 폴더 노트에서 한 번만.
    const create = notion.client.createPageWithMarkdown.getMockImplementation()!;
    let lost = false;
    notion.client.createPageWithMarkdown.mockImplementation(
      async (args: { parentId: string; title: string }) => {
        const page = await create(args);
        if (args.title === "A" && !lost) {
          lost = true;
          throw new Error("504 Gateway Timeout");
        }
        return page;
      },
    );

    const result = await orchestrator.push();

    expect(lost).toBe(true);
    expect(result).toMatchObject({ created: 3, failed: [] });
    expect(titled("A")).toHaveLength(1);
    expect(db.getByPath("A")).toBeNull();
    const a = pageOf("A/A.md");
    expect(a.parent).toBe(ROOT);
    expect(pageOf("A/x.md").parent).toBe(a.id);
    // 폴더 페이지는 B 하나뿐 — 폴더 노트를 기다리는 동안 A 를 따로 만들지 않았다.
    expect(notion.client.createPage).toHaveBeenCalledTimes(1);
    const b = pageOf("A/B");
    expect(b.parent).toBe(a.id);
    expect(pageOf("A/B/w.md").parent).toBe(b.id);
    expect(incompleteOps()).toEqual([]);
  });

  it("폴더 노트를 올리지 못하면 그 폴더 · 하위 폴더를 루트에 만들지 않고 이유와 함께 실패로 남긴다", async () => {
    vault.write("A/A.md", "# A\n");
    vault.write("A/x.md", "# X\n");
    vault.write("A/B/w.md", "# W\n");
    const create = notion.client.createPageWithMarkdown.getMockImplementation()!;
    notion.client.createPageWithMarkdown.mockImplementation(
      async (args: { parentId: string; title: string }) => {
        if (args.title === "A") throw new Error("validation_error: body failed validation");
        return create(args);
      },
    );

    const result = await orchestrator.push();

    expect(result.created).toBe(0);
    expect(result.failed.map((f) => f.path).sort()).toEqual(["A/A.md", "A/B/w.md", "A/x.md"]);
    const errorOf = (path: string) => result.failed.find((f) => f.path === path)!.error;
    expect(errorOf("A/A.md")).toContain("validation_error");
    expect(errorOf("A/x.md")).toContain("폴더 노트(A/A.md)");
    expect(errorOf("A/B/w.md")).toContain("폴더 노트(A/A.md)");
    expect(notion.client.createPage).not.toHaveBeenCalled();
    expect(notion.pages.size).toBe(0);
  });

  it("새 폴더로 옮긴 노트는 같은 push 의 새 폴더 노트 아래로 간다", async () => {
    await seed({ "x.md": "# X\n" });
    const xPage = db.getByPath("x.md")!.notionPageId!;

    vault.rename("x.md", "N/x.md");
    vault.write("N/N.md", "# N\n");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, updated: 0, moved: 1, failed: [] });
    expect(notion.client.createPage).not.toHaveBeenCalled();
    expect(db.getByPath("N")).toBeNull();
    const n = pageOf("N/N.md");
    expect(n.parent).toBe(ROOT);
    expect(notion.pages.get(xPage)!.parent).toBe(n.id);
    expect(incompleteOps()).toEqual([]);
  });

  it("폴더 이름을 바꾸며 폴더 노트를 더하면 옮긴 폴더 페이지를 폴더 노트의 페이지로 삼는다", async () => {
    await seed({ "Old/x.md": "# X\n" });
    const folderPage = db.getByPath("Old")!.notionPageId!;

    vault.renameFolder("Old", "New");
    vault.write("New/New.md", "# New\n");
    const result = await orchestrator.push();

    expect(result.failed).toEqual([]);
    expect(result.created).toBe(1);
    expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
    expect(notion.client.createPage).not.toHaveBeenCalled();
    expect(db.getByPath("New")).toBeNull();
    expect(db.getByPath("New/New.md")!.notionPageId).toBe(folderPage);
    expect(notion.pages.get(folderPage)!.title).toBe("New");
    expect(pageOf("New/x.md").parent).toBe(folderPage);
    expect(incompleteOps()).toEqual([]);

    expect(await orchestrator.push()).toMatchObject(idle);
  });

  describe("남아 있는 폴더 레코드", () => {
    /** 폴더 레코드를 손으로 심는다 — 지난 버전이 남긴 모습. */
    function folderRecord(path: string, pageId: string, parentId: string): void {
      db.upsert({
        obsidianPath: path,
        notionPageId: pageId,
        notionParentId: parentId,
        contentHash: "",
        notionLastEdited: null,
        localLastModified: "2026-05-01T00:00:00.000Z",
        syncDirection: "both",
        fileType: "folder-note",
        status: "synced",
      });
    }

    it("루트 페이지를 폴더의 페이지로 적은 옛 폴더 레코드는 실제 push 에서만 지운다 — dry-run 은 고치지 않는다", async () => {
      await seed({ "A/A.md": "# A\n" });
      const notePage = db.getByPath("A/A.md")!.notionPageId!;
      // 587b405 이전 push 는 폴더 노트의 «부모» 페이지를 폴더의 페이지로 적었다 — 맨 위 폴더에서는
      // 루트다. 더 깊은 폴더는 그 부모 페이지를 다른 레코드가 이미 가리켜 생기지 않았다(고유 색인).
      folderRecord("A", ROOT, "");

      await orchestrator.push({ dryRun: true });
      expect(db.getByPath("A")).not.toBeNull();

      await orchestrator.push();
      expect(db.getByPath("A")).toBeNull();
      expect(db.getByPath("A/A.md")!.notionPageId).toBe(notePage);
    });

    it("폴더 페이지 아래에 폴더 노트가 든 두 겹의 폴더는 레코드를 지우지 않는다 — 새 노트는 폴더 노트 아래로", async () => {
      await seed({ "Q/y.md": "# Y\n" });
      const folderPage = db.getByPath("Q")!.notionPageId!;
      // v0.4 이전 push 가 만든 모습 — 폴더 페이지 아래의 폴더 노트.
      const content = "# Q\n";
      vault.write("Q/Q.md", content);
      const note = notion.add(folderPage, "Q");
      const stat = vault.stat("Q/Q.md")!;
      db.upsert({
        obsidianPath: "Q/Q.md",
        notionPageId: note.id,
        notionParentId: folderPage,
        contentHash: computeHash(content),
        notionLastEdited: note.lastEdited,
        localLastModified: stat.mtime,
        syncDirection: "both",
        fileType: "folder-note",
        status: "synced",
        baseSnapshot: Buffer.from(content, "utf-8"),
        localMtime: stat.mtime,
        localFileSize: stat.size,
      });

      vault.write("Q/z.md", "# Z\n");
      const result = await orchestrator.push();

      expect(result).toMatchObject({ created: 1, failed: [] });
      // 폴더 페이지를 추적에서 놓지 않는다 — 놓으면 다음 pull 이 그것을 새 페이지로 받는다.
      expect(db.getByPath("Q")!.notionPageId).toBe(folderPage);
      expect(db.getByPath("Q/Q.md")!.notionPageId).toBe(note.id);
      expect(pageOf("Q/z.md").parent).toBe(note.id);
      expect(await orchestrator.push()).toMatchObject(idle);
    });
  });
});
