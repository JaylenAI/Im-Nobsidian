/**
 * N-04 — `# 제목` 으로 시작하는 노트를 만들면 Notion 본문에서 그 제목이 사라지던 결함.
 *
 * Notion 은 markdown 으로 페이지 · 행을 만들 때 맨 앞 `# H1` 을 버린다(2026-09-27 실측 — 메모리
 * Notion 이 흉내 낸다). 로컬 노트는 그대로라 아무도 몰랐고, Notion 에서 그 페이지를 고치면 pull 이
 * 제목 없는 본문을 받아 로컬 노트의 제목까지 지웠다.
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
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-000000000001";

describe("맨 앞 `# 제목` 으로 시작하는 노트를 만든다 (N-04)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-h1-"));
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

  it("Notion 본문에 맨 앞 제목이 남는다 — 만든 직후 한 번 되살린다", async () => {
    vault.write("notes/H.md", "# Title\n\nBody\n");

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    const page = pageOf("notes/H.md");
    expect(page.body).toMatch(/^# Title\n/);
    expect(page.body).toContain("Body");
    expect(notion.client.createPageWithMarkdown).toHaveBeenCalledTimes(1);
    expect(notion.client.replacePageMarkdown).toHaveBeenCalledTimes(1);
    expect(notion.client.replacePageMarkdown.mock.calls[0]![0]).toBe(page.id);
    expect(db.getByPath("notes/H.md")).toMatchObject({ status: "synced" });
    expect(incompleteOps()).toEqual([]);
    expect(await orchestrator.push()).toMatchObject(idle);
  });

  it("되살린 교체를 원격 수정으로 보지 않는다 — 다음 pull 이 그 페이지를 다시 읽지 않는다", async () => {
    vault.write("notes/H.md", "# Title\n\nBody\n");
    await orchestrator.push();
    db.setMeta("last_pull_at", "2026-09-02T00:00:00.000Z");
    expect(db.getByPath("notes/H.md")!.notionLastEdited).toBe(pageOf("notes/H.md").lastEdited);
    notion.client.getPageMarkdown.mockClear();

    const pulled = await orchestrator.pull();

    expect(pulled).toMatchObject({ created: 0, updated: 0, failed: [], conflicts: [] });
    expect(notion.client.getPageMarkdown).not.toHaveBeenCalled();
  });

  it("Notion 에서 고친 뒤 받아도 로컬 노트의 제목이 남는다", async () => {
    vault.write("notes/H.md", "# Title\n\nBody\n");
    await orchestrator.push();
    db.setMeta("last_pull_at", "2026-09-02T00:00:00.000Z");
    const page = pageOf("notes/H.md");
    page.body = `${page.body.trimEnd()}\n\nRemote line`;
    notion.touch(page.id);

    const pulled = await orchestrator.pull();

    expect(pulled).toMatchObject({ updated: 1, failed: [], conflicts: [] });
    expect(vault.read("notes/H.md")).toContain("# Title\n");
    expect(vault.read("notes/H.md")).toContain("Remote line");
  });

  it("제목으로 시작하지 않는 노트는 요청을 더하지 않는다", async () => {
    vault.write("notes/Sub.md", "## Sub\n\nBody\n");
    vault.write("notes/Mid.md", "Intro\n\n# Middle\n");
    vault.write("notes/Tag.md", "#tag first\n");

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 3, failed: [] });
    expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
    expect(pageOf("notes/Sub.md").body).toMatch(/^## Sub\n/);
    expect(pageOf("notes/Mid.md").body).toContain("# Middle");
  });

  it("되살리기가 한 번 실패해도 같은 push 의 재시도가 새로 만들지 않고 되살린다", async () => {
    vault.write("notes/H.md", "# Title\n\nBody\n");
    notion.client.replacePageMarkdown.mockRejectedValueOnce(new Error("Notion 503"));

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    expect(titled("H")).toHaveLength(1);
    expect(notion.client.createPageWithMarkdown).toHaveBeenCalledTimes(1);
    expect(pageOf("notes/H.md").body).toMatch(/^# Title\n/);
    // 앞선 시도의 생성 WAL 은 다음 push 가 매핑을 보고 닫는다.
    expect(await orchestrator.push()).toMatchObject(idle);
    expect(incompleteOps()).toEqual([]);
  });

  it("계속 실패하면 그 노트만 이유와 함께 실패로 남고, 다음 push 가 새로 만들지 않고 되살린다", async () => {
    vault.write("notes/H.md", "# Title\n\nBody\n");
    vault.write("notes/Other.md", "Other body\n");
    notion.client.replacePageMarkdown
      .mockRejectedValueOnce(new Error("Notion 503"))
      .mockRejectedValueOnce(new Error("Notion 503"));

    const first = await orchestrator.push();

    expect(first.created).toBe(1);
    expect(first.failed).toEqual([
      expect.objectContaining({ path: "notes/H.md", error: expect.stringContaining("Notion 503") }),
    ]);
    // 페이지는 생겼다 — 매핑은 적고 해시를 비워, 다음 push 가 새로 만들지 않고 갱신한다.
    expect(db.getByPath("notes/H.md")).toMatchObject({ contentHash: "", status: "pending" });
    expect(titled("H")).toHaveLength(1);

    const second = await orchestrator.push();

    expect(second).toMatchObject({ created: 0, updated: 1, failed: [] });
    expect(titled("H")).toHaveLength(1);
    expect(notion.client.createPageWithMarkdown).toHaveBeenCalledTimes(2);
    expect(pageOf("notes/H.md").body).toMatch(/^# Title\n/);
    expect(db.getByPath("notes/H.md")).toMatchObject({ status: "synced" });
    expect(incompleteOps()).toEqual([]);
  });

  it("자동 발견 DB 의 새 행도 맨 앞 제목을 되살린다", async () => {
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }]),
    );
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    vault.write("Tasks/Row.md", "---\ntitle: Row\n---\n# Heading\n\nRow body\n");

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    const row = pageOf("Tasks/Row.md");
    expect(row.parent).toBe(DB_ID);
    expect(row.body).toMatch(/^# Heading\n/);
    expect(db.getByPath("Tasks/Row.md")).toMatchObject({ fileType: "db-row", status: "synced" });
    expect(await orchestrator.push()).toMatchObject(idle);
  });

  it("폴더 노트는 하위 페이지를 만들기 전에 되살린다 — 교체가 지울 자식이 없다", async () => {
    vault.write("A/A.md", "# A\n\nFolder body\n");
    vault.write("A/x.md", "# X\n");

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 2, failed: [] });
    const folderNote = pageOf("A/A.md");
    const child = pageOf("A/x.md");
    expect(child.parent).toBe(folderNote.id);
    expect(folderNote.body).toMatch(/^# A\n/);
    expect(child.body).toMatch(/^# X/);
    const replace = notion.client.replacePageMarkdown.mock;
    const create = notion.client.createPageWithMarkdown.mock;
    const restoredAt =
      replace.invocationCallOrder[replace.calls.findIndex(([id]) => id === folderNote.id)]!;
    const childCreatedAt =
      create.invocationCallOrder[
        create.calls.findIndex(([params]) => params.parentId === folderNote.id)
      ]!;
    expect(restoredAt).toBeLessThan(childCreatedAt);
  });
});
