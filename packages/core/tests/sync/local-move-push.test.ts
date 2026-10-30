/**
 * S-11 — 볼트에서 옮기거나 이름을 바꾼 노트 · 폴더를 Notion 에 옮겨 반영한다.
 *
 * 예전에는 이름을 바꾸면 내용이 같을 때 짝은 지어도 push 가 아무것도 하지 않아 Notion 의 제목 ·
 * 부모가 그대로였고, 내용도 바꿨으면 옛 페이지를 두고 새 페이지를 만들었다. 부모를 바꾸는
 * 요청(pages.update 의 parent)은 Notion 이 조용히 무시했다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로
 * 이어 쓴다 — 레코드를 손으로 심으면 증명하려는 상태를 가정으로 깐다(push-idempotency). DB 행만
 * pull 이 만들었을 상태를 심는다 — 행을 만드는 경로(스키마 · 행 생성)는 여기서 보지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { computeHash } from "../../src/utils/hash.js";
import { remoteBodyFingerprint } from "../../src/sync/remote-observation.js";
import { PENDING_DATABASES_META_KEY } from "../../src/sync/remote-scan.js";
import { createConfig, mockDatabaseMeta } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion, type MemoryPage } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";
const DB_ID = "dbdbdbdb-0000-4000-8000-000000000001";
const OTHER_DB_ID = "dbdbdbdb-0000-4000-8000-000000000002";

describe("로컬 이동 · 이름 변경 push (S-11)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-localmove-"));
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
  const incompleteOps = () => db.getIncompletePendingOperations();
  const writeCalls = () =>
    notion.client.createPageWithMarkdown.mock.calls.length +
    notion.client.createPage.mock.calls.length +
    notion.client.movePage.mock.calls.length +
    notion.client.updatePageProperties.mock.calls.length +
    notion.client.replacePageMarkdown.mock.calls.length +
    notion.client.archivePage.mock.calls.length;

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
    notion.client.getPage.mockClear();
  }

  /** pull 이 받아 둔 DB 행을 심는다 — 자동 발견 DB `Tasks` 의 행. */
  function seedRow(path: string, title: string, body = "Row body\n"): MemoryPage {
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }]),
    );
    const content = `---\ntitle: ${title}\nstatus: todo\n---\n${body}`;
    vault.write(path, content);
    const page = notion.add(DB_ID, title);
    const stat = vault.stat(path)!;
    db.upsert({
      obsidianPath: path,
      notionPageId: page.id,
      notionParentId: DB_ID,
      contentHash: computeHash(content),
      notionLastEdited: page.lastEdited,
      // pull 이 남기는 원격 관측 — 이 통합이 쓴 그대로이고 본문은 비었다.
      notionLastEditedBy: page.lastEditedBy,
      notionBodyFingerprint: remoteBodyFingerprint(""),
      localLastModified: stat.mtime,
      syncDirection: "both",
      fileType: "db-row",
      status: "synced",
      baseSnapshot: Buffer.from(content, "utf-8"),
      localMtime: stat.mtime,
      localFileSize: stat.size,
    });
    return page;
  }

  it("이름만 바꾸면 페이지 제목만 바꾼다 — 새 페이지를 만들지 않는다", async () => {
    await seed({ "notes/Old.md": "# Body\n\nHello\n" });
    const pageId = db.getByPath("notes/Old.md")!.notionPageId!;

    vault.rename("notes/Old.md", "notes/New.md");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 1, deleted: 0, failed: [] });
    expect(db.getByPath("notes/Old.md")).toBeNull();
    expect(db.getByPath("notes/New.md")!.notionPageId).toBe(pageId);
    expect(notion.pages.get(pageId)!.title).toBe("New");
    expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
    expect(notion.client.movePage).not.toHaveBeenCalled();
    expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
    expect(incompleteOps()).toEqual([]);

    // 반영을 마쳤으면 다음 push 는 할 일이 없다.
    const again = await orchestrator.push();
    expect(again).toMatchObject({ created: 0, updated: 0, deleted: 0, failed: [] });
  });

  it("다른 폴더로 옮기면 그 폴더의 페이지 아래로 옮긴다", async () => {
    await seed({ "A/x.md": "# X\n", "B/y.md": "# Y\n" });
    const folderB = db.getByPath("B")!.notionPageId!;

    vault.rename("A/x.md", "B/x.md");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 1, failed: [] });
    const page = pageOf("B/x.md");
    expect(notion.client.movePage).toHaveBeenCalledWith(page.id, folderB);
    expect(page.parent).toBe(folderB);
    expect(page.title).toBe("x");
    expect(db.getByPath("B/x.md")!.notionParentId).toBe(folderB);
    // 옮긴 뒤의 수정 시각을 기준으로 적는다 — 다음 pull 이 제 이동을 원격 변경으로 받지 않게.
    expect(db.getByPath("B/x.md")!.notionLastEdited).toBe(page.lastEdited);
    expect(notion.client.createPage).not.toHaveBeenCalled();
  });

  it("새 폴더로 옮기면 폴더 페이지를 먼저 만들고 그 아래로 옮긴다", async () => {
    await seed({ "A/x.md": "# X\n" });

    vault.rename("A/x.md", "C/x.md");
    const result = await orchestrator.push();

    expect(result.failed).toEqual([]);
    const folderC = db.getByPath("C")!;
    expect(notion.pages.get(folderC.notionPageId!)!.title).toBe("C");
    expect(pageOf("C/x.md").parent).toBe(folderC.notionPageId);
  });

  it("폴더 이름을 바꾸면 폴더 페이지 제목만 바꾸고, 안의 노트는 건드리지 않는다", async () => {
    await seed({ "Projects/a.md": "# A\n", "Projects/b.md": "# B\n" });
    const folderPage = db.getByPath("Projects")!.notionPageId!;

    vault.renameFolder("Projects", "Work");
    const result = await orchestrator.push();

    expect(result.failed).toEqual([]);
    expect(db.getByPath("Projects")).toBeNull();
    expect(db.getByPath("Work")!.notionPageId).toBe(folderPage);
    expect(notion.pages.get(folderPage)!.title).toBe("Work");
    expect(notion.pages.get(folderPage)!.parent).toBe(ROOT);
    expect(pageOf("Work/a.md").parent).toBe(folderPage);
    expect(notion.client.movePage).not.toHaveBeenCalled();
    expect(notion.client.createPage).not.toHaveBeenCalled();
    expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
    // 폴더 제목 1건 — 노트는 부모도 제목도 그대로라 요청하지 않는다.
    expect(notion.client.updatePageProperties).toHaveBeenCalledTimes(1);
    expect(incompleteOps()).toEqual([]);
  });

  it("이름과 내용을 함께 바꾸면 힌트로 짝을 찾아 제목을 바꾸고 본문을 갱신한다", async () => {
    await seed({ "notes/Draft.md": "# Draft\n\nfirst\n" });
    const pageId = db.getByPath("notes/Draft.md")!.notionPageId!;

    vault.rename("notes/Draft.md", "notes/Final.md");
    vault.write("notes/Final.md", "# Final\n\nsecond\n");
    orchestrator.recordLocalRename("notes/Draft.md", "notes/Final.md", "file");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 0, updated: 0, moved: 1, deleted: 0, failed: [] });
    expect(db.getByPath("notes/Final.md")!.notionPageId).toBe(pageId);
    expect(notion.pages.get(pageId)!.title).toBe("Final");
    expect(notion.client.replacePageMarkdown).toHaveBeenCalledTimes(1);
    expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
    expect(notion.pages.get(pageId)!.archived).toBe(false);
    // 쓴 힌트는 지운다.
    expect(db.getMeta("local_rename_hints")).toBe("");
  });

  it("힌트 없이 이름과 내용을 함께 바꾸면 짝을 모른다 — 새로 만들고 옛 페이지는 지우지 않는다", async () => {
    await seed({ "notes/Draft.md": "# Draft\n\nfirst\n" });

    vault.rename("notes/Draft.md", "notes/Final.md");
    vault.write("notes/Final.md", "# Final\n\nsecond\n");
    const result = await orchestrator.push();

    // deleteSync 가 꺼져 있으면 옛 페이지는 남는다 — CLI 는 이름 변경 이벤트를 받지 못한다.
    expect(result).toMatchObject({ created: 1, deleted: 0 });
  });

  it("frontmatter title 로 정한 제목은 이름을 바꿔도 그대로 둔다", async () => {
    await seed({ "notes/file-name.md": "---\ntitle: 사람이 정한 제목\n---\nBody\n" });
    const page = pageOf("notes/file-name.md");
    expect(page.title).toBe("사람이 정한 제목");

    vault.rename("notes/file-name.md", "notes/other-name.md");
    const result = await orchestrator.push();

    expect(result.failed).toEqual([]);
    expect(page.title).toBe("사람이 정한 제목");
    expect(notion.client.updatePageProperties).not.toHaveBeenCalled();
  });

  it("본문만 고치면 제목을 보내지 않는다 — 제목이 뒤집히지 않는다", async () => {
    await seed({ "notes/n.md": "---\ntitle: 정한 제목\n---\nBody\n" });

    vault.write("notes/n.md", "---\ntitle: 정한 제목\n---\nBody edited\n");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect(notion.client.updatePageProperties).not.toHaveBeenCalled();
    expect(pageOf("notes/n.md").title).toBe("정한 제목");
  });

  it("frontmatter title 을 고치면 그 제목을 보낸다", async () => {
    await seed({ "notes/n.md": "---\ntitle: 처음\n---\nBody\n" });

    vault.write("notes/n.md", "---\ntitle: 나중\n---\nBody\n");
    await orchestrator.push();

    expect(pageOf("notes/n.md").title).toBe("나중");
  });

  it("DB 행의 이름을 바꾸면 행 제목만 바꾼다 — DB 밖으로 옮기지 않는다", async () => {
    await seed({});
    const row = seedRow("Tasks/Old Row.md", "Old Row");

    vault.rename("Tasks/Old Row.md", "Tasks/New Row.md");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ updated: 0, moved: 1, failed: [] });
    expect(row.title).toBe("New Row");
    expect(row.parent).toBe(DB_ID);
    expect(notion.client.movePage).not.toHaveBeenCalled();
    expect(db.getByPath("Tasks/New Row.md")!.notionPageId).toBe(row.id);
  });

  /** DB 폴더 둘(Tasks · Other)과 그 스키마 — 메모리 Notion 의 data source 는 DB 와 같은 id 다. */
  function useDatabases(
    schemas: Record<string, Record<string, { id: string; type: string }>>,
  ): void {
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([
        { databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" },
        { databaseId: OTHER_DB_ID, localFolder: "Other", titleProperty: "Name" },
      ]),
    );
    notion.client.getDatabaseMeta.mockImplementation(async (id: string) => ({
      ...mockDatabaseMeta(id),
      dataSources: [{ id, name: "" }],
    }));
    notion.client.getDatabaseSchema.mockImplementation(async (id: string) => schemas[id] ?? {});
  }

  const TASKS_SCHEMA = {
    Name: { id: "title", type: "title" },
    status: { id: "st", type: "select" },
  };

  it("DB 행을 DB 폴더 밖으로 옮기면 Notion 에서 페이지가 된다 — 같은 페이지, 속성은 본문 YAML 로", async () => {
    await seed({ "notes/keep.md": "# Keep\n" });
    const row = seedRow("Tasks/Row.md", "Row");
    useDatabases({ [DB_ID]: TASKS_SCHEMA });

    vault.rename("Tasks/Row.md", "notes/Row.md");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ moved: 1, failed: [] });
    expect(result.placementChanges).toEqual([{ path: "notes/Row.md", becomes: "page" }]);
    const record = db.getByPath("notes/Row.md")!;
    expect(record.notionPageId).toBe(row.id);
    expect(record.fileType).toBe("file");
    expect(row.parentType).toBe("page");
    expect(row.parent).toBe(record.notionParentId);
    expect(row.parent).toBe(db.getByPath("notes")!.notionPageId);
    // 페이지는 속성이 제목뿐이다 — 나머지는 본문 첫머리 YAML 로 간다.
    expect(row.body).toContain("status: todo");
    expect(row.body).toContain("Row body");
    expect(incompleteOps()).toEqual([]);
    expect(record.contentHash).not.toBe("");
    // 행이 빠진 DB 를 다음 pull 이 조회한다.
    expect(db.getMeta(PENDING_DATABASES_META_KEY)).toContain(DB_ID.replace(/-/g, ""));

    const again = await orchestrator.push();
    expect(again).toMatchObject({ created: 0, updated: 0, moved: 0, failed: [] });
  });

  it("페이지를 DB 폴더로 옮기면 그 DB 의 행이 된다 — frontmatter 는 속성으로, YAML 블록은 본문에서 빠진다", async () => {
    await seed({ "notes/page.md": "---\nstatus: doing\n---\nPage body\n" });
    const page = pageOf("notes/page.md");
    expect(page.body).toContain("status: doing");
    useDatabases({ [DB_ID]: TASKS_SCHEMA });

    vault.rename("notes/page.md", "Tasks/page.md");
    const result = await orchestrator.push();

    expect(result).toMatchObject({ moved: 1, failed: [] });
    expect(result.placementChanges).toEqual([{ path: "Tasks/page.md", becomes: "row" }]);
    expect(notion.client.movePageToDataSource).toHaveBeenCalledWith(page.id, DB_ID);
    expect(notion.client.movePage).not.toHaveBeenCalled();
    const record = db.getByPath("Tasks/page.md")!;
    expect(record).toMatchObject({
      notionPageId: page.id,
      notionParentId: DB_ID,
      fileType: "db-row",
    });
    expect(page.parentType).toBe("database");
    expect(page.properties.status).toEqual({ type: "select", select: { name: "doing" } });
    expect(page.body).not.toContain("status: doing");
    expect(page.body).toContain("Page body");
    expect(incompleteOps()).toEqual([]);

    const again = await orchestrator.push();
    expect(again).toMatchObject({ created: 0, updated: 0, moved: 0, failed: [] });
  });

  it("행을 다른 DB 폴더로 옮기면 그 DB 의 행이 되고, 대상 DB 에 더해질 열을 알린다", async () => {
    await seed({});
    const row = seedRow("Tasks/Row.md", "Row");
    row.properties.status = { type: "select", select: { name: "todo" } };
    row.properties.empty = { type: "rich_text", rich_text: [] };
    useDatabases({
      [DB_ID]: TASKS_SCHEMA,
      [OTHER_DB_ID]: { Name: { id: "title", type: "title" } },
    });

    vault.rename("Tasks/Row.md", "Other/Row.md");
    const dry = await orchestrator.push({ dryRun: true });
    expect(dry.placementChanges).toEqual([
      { path: "Other/Row.md", becomes: "row", addedColumns: ["status"] },
    ]);
    expect(row.parent).toBe(DB_ID);

    const result = await orchestrator.push();

    expect(result).toMatchObject({ moved: 1, failed: [] });
    expect(result.placementChanges).toEqual(dry.placementChanges);
    expect(notion.client.movePageToDataSource).toHaveBeenCalledWith(row.id, OTHER_DB_ID);
    expect(db.getByPath("Other/Row.md")).toMatchObject({
      notionPageId: row.id,
      notionParentId: OTHER_DB_ID,
      fileType: "db-row",
    });
    const pending = db.getMeta(PENDING_DATABASES_META_KEY)!;
    expect(pending).toContain(DB_ID.replace(/-/g, ""));
    expect(pending).toContain(OTHER_DB_ID.replace(/-/g, ""));
  });

  it("받지 않은 Notion 편집이 있으면 행 · 페이지로 바꾸지 않는다 — 다시 보내면 그 편집을 덮는다", async () => {
    await seed({ "notes/page.md": "Page body\n" });
    const page = pageOf("notes/page.md");
    useDatabases({ [DB_ID]: TASKS_SCHEMA });
    notion.edit(page.id, (p) => (p.body = "Edited in Notion"));

    vault.rename("notes/page.md", "Tasks/page.md");
    const result = await orchestrator.push();

    expect(result.failed).toEqual([
      expect.objectContaining({
        path: "Tasks/page.md",
        operation: "move",
        error: expect.stringContaining("받지 않은 편집이 있어 옮기지 않음"),
      }),
    ]);
    expect(notion.client.movePageToDataSource).not.toHaveBeenCalled();
    expect(page.parentType).toBe("page");
    expect(page.body).toBe("Edited in Notion");
    expect(db.getByPath("Tasks/page.md")!.fileType).toBe("file");
  });

  it("행이 된 뒤 다시 보내다 끊기면 다음 push 가 확인 없이 마저 보낸다", async () => {
    await seed({ "notes/page.md": "---\nstatus: doing\n---\nPage body\n" });
    const page = pageOf("notes/page.md");
    useDatabases({ [DB_ID]: TASKS_SCHEMA });
    const replace = notion.client.replacePageMarkdown.getMockImplementation()!;
    notion.client.replacePageMarkdown.mockRejectedValue(new Error("socket hang up"));

    vault.rename("notes/page.md", "Tasks/page.md");
    const first = await orchestrator.push();

    expect(first.failed).toEqual([expect.objectContaining({ path: "Tasks/page.md" })]);
    // 자리는 바뀌었고 레코드는 «아직 맞추지 않은» 행이다.
    expect(page.parentType).toBe("database");
    expect(db.getByPath("Tasks/page.md")).toMatchObject({ fileType: "db-row", contentHash: "" });

    notion.client.replacePageMarkdown.mockImplementation(replace);
    notion.edit(page.id, () => undefined); // 끊긴 쓰기가 남긴 수정 시각 — 확인하면 거절할 것이다
    const second = await orchestrator.push();

    expect(second).toMatchObject({ updated: 1, failed: [] });
    expect(page.body).toContain("Page body");
    expect(page.body).not.toContain("status: doing");
    expect(page.properties.status).toEqual({ type: "select", select: { name: "doing" } });
  });

  it("폴더 노트는 DB 폴더로 옮기지 않는다 — 그 폴더의 하위 페이지가 둘 자리가 없다", async () => {
    await seed({ "F/F.md": "# F\n", "F/child.md": "# Child\n" });
    seedRow("Tasks/Row.md", "Row");
    const folderNote = pageOf("F/F.md");
    const parentBefore = folderNote.parent;

    vault.rename("F/F.md", "Tasks/F.md");
    const result = await orchestrator.push();

    expect(result.failed).toEqual([
      expect.objectContaining({
        path: "Tasks/F.md",
        operation: "move",
        error: expect.stringContaining("폴더 노트는 DB(Tasks)의 행으로 옮기지 않음"),
      }),
    ]);
    expect(notion.client.movePageToDataSource).not.toHaveBeenCalled();
    expect(folderNote.parent).toBe(parentBefore);
  });

  it("dry-run 은 실제 push 와 같은 수 · 같은 자리 바뀜을 보이고 아무것도 바꾸지 않는다", async () => {
    await seed({ "notes/a.md": "# A\n", "notes/page.md": "# Page\n" });
    seedRow("Tasks/Row.md", "Row");
    useDatabases({ [DB_ID]: TASKS_SCHEMA });
    vault.rename("notes/a.md", "notes/b.md");
    vault.rename("notes/page.md", "Tasks/page.md");

    const dry = await orchestrator.push({ dryRun: true });

    expect(db.getByPath("notes/a.md")).not.toBeNull();
    expect(incompleteOps()).toEqual([]);
    expect(writeCalls()).toBe(0);

    const real = await orchestrator.push();
    expect({
      created: dry.created,
      updated: dry.updated,
      deleted: dry.deleted,
      moved: dry.moved,
    }).toEqual({
      created: real.created,
      updated: real.updated,
      deleted: real.deleted,
      moved: real.moved,
    });
    expect(dry.failed.map((f) => [f.path, f.operation, f.error])).toEqual(
      real.failed.map((f) => [f.path, f.operation, f.error]),
    );
    expect(dry.placementChanges).toEqual(real.placementChanges);
    expect(real).toMatchObject({ updated: 0, moved: 2, failed: [] });
  });

  it("옮기다 끊기면 다음 push 가 같은 이동을 다시 해 마친다", async () => {
    await seed({ "A/x.md": "# X\n", "B/y.md": "# Y\n" });
    const folderB = db.getByPath("B")!.notionPageId!;
    vault.rename("A/x.md", "B/x2.md");
    notion.client.updatePageProperties.mockRejectedValue(new Error("socket hang up"));

    const first = await orchestrator.push();

    expect(first.failed).toEqual([expect.objectContaining({ path: "B/x2.md", operation: "move" })]);
    // 부모는 옮겨졌고 제목은 못 바꿨다. 레코드는 새 경로를 추적하고 이동 WAL 이 남는다.
    const page = pageOf("B/x2.md");
    expect(page.parent).toBe(folderB);
    expect(page.title).toBe("x");
    expect(incompleteOps()).toHaveLength(1);

    notion.client.updatePageProperties.mockReset();
    notion.client.updatePageProperties.mockImplementation(
      async (id: string, props: { title?: { title: Array<{ text: { content: string } }> } }) => {
        const target = notion.touch(id);
        if (props.title) target.title = props.title.title.map((t) => t.text.content).join("");
        return {
          id,
          last_edited_time: target.lastEdited,
          parent: { type: "page_id", page_id: target.parent },
          properties: {
            title: { id: "title", type: "title", title: [{ plain_text: target.title }] },
          },
        };
      },
    );
    const second = await orchestrator.push();

    expect(second).toMatchObject({ updated: 0, moved: 1, failed: [] });
    expect(page.parent).toBe(folderB);
    expect(page.title).toBe("x2");
    expect(incompleteOps()).toEqual([]);
  });

  it("반영하기 전에 원래 자리로 되돌리면 요청 없이 이동을 지운다", async () => {
    await seed({ "notes/a.md": "# A\n" });
    db.setMeta("last_pull_at", "2026-09-02T00:00:00.000Z");

    vault.rename("notes/a.md", "notes/b.md");
    await orchestrator.pull(); // 옮겨 적기만 한다 — Notion 에는 반영하지 않는다.
    expect(db.getByPath("notes/b.md")).not.toBeNull();
    expect(incompleteOps()).toHaveLength(1);

    vault.rename("notes/b.md", "notes/a.md");
    const writesBefore = writeCalls();
    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, failed: [] });
    expect(db.getByPath("notes/a.md")).not.toBeNull();
    expect(incompleteOps()).toEqual([]);
    expect(writeCalls()).toBe(writesBefore);
  });

  it("pull 은 옮긴 노트를 옛 자리에 되살리지 않고, 다음 push 가 이동을 반영한다", async () => {
    await seed({ "notes/Draft.md": "# Draft\n\nfirst\n" });
    db.setMeta("last_pull_at", "2026-09-02T00:00:00.000Z");
    const pageId = db.getByPath("notes/Draft.md")!.notionPageId!;

    // 이름과 내용을 함께 바꿨다 — 내용 비교만으로는 옮긴 것을 모른다.
    vault.rename("notes/Draft.md", "notes/Final.md");
    vault.write("notes/Final.md", "# Final\n\nsecond\n");
    orchestrator.recordLocalRename("notes/Draft.md", "notes/Final.md", "file");

    const pulled = await orchestrator.pull();

    expect(pulled.restored).toBe(0);
    expect(vault.read("notes/Draft.md")).toBeUndefined();
    expect(db.getByPath("notes/Final.md")!.notionPageId).toBe(pageId);

    // 앞선 WAL 재개(recoverInterruptedPushOps)가 이동 WAL 을 지우지 않아야 반영된다.
    const pushed = await orchestrator.push();
    expect(pushed).toMatchObject({ created: 0, updated: 0, moved: 1, failed: [] });
    expect(notion.pages.get(pageId)!.title).toBe("Final");
    expect(incompleteOps()).toEqual([]);
  });

  it("옮기고 반영하기 전에 원격이 바뀌어도 pull 은 옛 제목을 title 로 적지 않는다", async () => {
    await seed({ "notes/Old.md": "# Body\n" });
    db.setMeta("last_pull_at", "2026-09-02T00:00:00.000Z");
    const pageId = db.getByPath("notes/Old.md")!.notionPageId!;

    vault.rename("notes/Old.md", "notes/New.md");
    notion.touch(pageId); // Notion 에서 본문을 고쳤다.
    notion.client.getPageMarkdown.mockResolvedValue({
      markdown: "Remote body",
      truncated: false,
      unknown_block_ids: [],
    });

    // dry-run 도 받을 자리를 새 경로로 보인다 — 실제 pull 은 옮겨 적은 뒤 새 경로에 쓴다.
    const shown: string[] = [];
    await orchestrator.pull({ dryRun: true, onProgress: (_i, _n, item) => shown.push(item.path) });
    expect(shown).toEqual(["notes/New.md"]);
    expect(db.getByPath("notes/Old.md")).not.toBeNull();

    await orchestrator.pull();

    expect(vault.read("notes/New.md")).toContain("Remote body");
    expect(vault.read("notes/New.md")).not.toMatch(/^title:/m);

    // 적었다면 push 가 그것을 사람이 정한 제목으로 보고 이름 변경을 제목에 반영하지 않는다.
    await orchestrator.push();
    expect(notion.pages.get(pageId)!.title).toBe("New");
  });

  it("옮기면 위키링크 · 보존 마커도 새 경로로 옮겨 적는다", async () => {
    await seed({ "notes/a.md": "# A\n" });
    const pageId = db.getByPath("notes/a.md")!.notionPageId!;
    const markers = [{ id: "m1", type: "embed", original: "![[x]]", position: 0 }];
    db.storePreserveMarkers("notes/a.md", markers as never);

    vault.rename("notes/a.md", "notes/b.md");
    await orchestrator.push();

    expect(db.resolvePageId(pageId)).toMatchObject({ obsidianPath: "notes/b.md", title: "b" });
    expect(db.getPreserveMarkers("notes/b.md")).toEqual(markers);
    expect(db.getPreserveMarkers("notes/a.md")).toEqual([]);
  });

  it("지운 노트의 힌트는 버린다 — 같은 자리의 새 노트를 옛 노트로 짝짓지 않는다", async () => {
    await seed({ "notes/a.md": "# A\n" });

    orchestrator.recordLocalRename("notes/a.md", "notes/b.md", "file");
    orchestrator.recordLocalDelete("notes/b.md");

    expect(db.getMeta("local_rename_hints")).toBe("");
  });

  it("DB 폴더를 다른 DB 폴더 안으로 옮기면 DB 는 거절하고 행은 제 DB 에 둔다 — dry-run 도 같게 보인다", async () => {
    await seed({ "notes/keep.md": "# Keep\n" });
    const row = seedRow("Tasks/Row.md", "Row");
    useDatabases({ [DB_ID]: TASKS_SCHEMA, [OTHER_DB_ID]: TASKS_SCHEMA });
    vault.write("Other/o.md", "---\ntitle: o\n---\n");

    vault.renameFolder("Tasks", "Other/Tasks");
    const preview = await orchestrator.push({ dryRun: true });
    expect(preview.placementChanges).toBeUndefined();
    expect(preview.databaseMoves).toBeUndefined();
    expect(preview.failed).toEqual([
      expect.objectContaining({ path: "Other/Tasks", error: expect.stringContaining("DB 폴더") }),
    ]);

    const result = await orchestrator.push();
    expect(result.failed).toEqual([
      expect.objectContaining({ path: "Other/Tasks", error: expect.stringContaining("DB 폴더") }),
    ]);
    expect(result.placementChanges).toBeUndefined();
    expect(db.getByPath("Other/Tasks/Row.md")).toMatchObject({ fileType: "db-row" });
    expect(row.parent).toBe(DB_ID);
    expect(notion.client.updateDatabasePlacement).not.toHaveBeenCalled();

    // 거절된 이동 뒤 다시 옮기면 dry-run 은 같은 DB 의 이동을 하나로 — 처음 자리에서 새 자리로.
    vault.renameFolder("Other/Tasks", "notes/Tasks");
    const again = await orchestrator.push({ dryRun: true });
    expect(again.failed).toEqual([]);
    expect(again.databaseMoves).toEqual([{ from: "Tasks", to: "notes/Tasks" }]);

    // 되돌리면 반영할 것이 없다.
    vault.renameFolder("notes/Tasks", "Tasks");
    const back = await orchestrator.push();
    expect(back.failed).toEqual([]);
    expect(db.getMeta("db_moves_pending")).toBe("[]");
  });

  describe("이미 올린 노트 폴더를 DB 로 (ADR-047)", () => {
    const NEW_DB = "dbdbdbdb-0000-4000-8000-0000000000aa";
    const BOOKS_SCHEMA = {
      Name: { id: "title", type: "title" },
      저자: { id: "au", type: "select" },
    };

    beforeEach(() => {
      notion.client.createDatabase = vi.fn(async () => ({
        databaseId: NEW_DB,
        dataSourceId: NEW_DB,
      })) as never;
      notion.client.primaryDataSourceId = vi.fn(async (id: string) => id) as never;
      notion.client.listDatabaseViews = vi.fn(async () => []) as never;
      notion.client.getDatabaseMeta.mockImplementation(async (id: string) => ({
        ...mockDatabaseMeta(id),
        dataSources: [{ id, name: "" }],
      }));
      notion.client.getDatabaseSchema.mockImplementation(async () => BOOKS_SCHEMA);
    });

    it("push 가 DB 를 만들고 페이지를 같은 페이지째 행으로 옮긴 뒤 빈 폴더 페이지를 휴지통에 넣는다", async () => {
      await seed({
        "Books/가.md": "---\n저자: 한강\n---\n가 본문\n",
        "Books/나.md": "---\n저자: 김\n---\n나 본문\n",
        "keep.md": "# Keep\n",
      });
      const folderPage = db.getByPath("Books")!.notionPageId!;
      const pageA = db.getByPath("Books/가.md")!.notionPageId!;

      const report = await orchestrator.prepareFolderDatabase("Books");
      expect(report).toMatchObject({ rows: 2, pagesToRows: 2 });

      const preview = await orchestrator.push({ dryRun: true });
      expect(preview).toMatchObject({ createdDatabases: 1, moved: 2, updated: 0, failed: [] });
      expect(preview.placementChanges).toEqual([
        { path: "Books/가.md", becomes: "row" },
        { path: "Books/나.md", becomes: "row" },
      ]);
      expect(notion.client.createDatabase).not.toHaveBeenCalled();

      const result = await orchestrator.push();

      expect(result).toMatchObject({ moved: 2, created: 0, failed: [] });
      expect(notion.client.createDatabase).toHaveBeenCalledTimes(1);
      expect(notion.client.createDatabase.mock.calls[0]![0]).toMatchObject({ parentPageId: ROOT });
      const record = db.getByPath("Books/가.md")!;
      expect(record).toMatchObject({
        notionPageId: pageA,
        fileType: "db-row",
        notionParentId: NEW_DB,
      });
      expect(notion.pages.get(pageA)!).toMatchObject({ parent: NEW_DB, parentType: "database" });
      expect(notion.client.movePageToDataSource).toHaveBeenCalledTimes(2);
      // 다 옮겨 빈 폴더 페이지는 휴지통으로 · 준비 표시는 지운다.
      expect(notion.client.archivePage).toHaveBeenCalledWith(folderPage);
      expect(db.getByPath("Books")).toBeNull();
      expect(db.getMeta("prepared_dbs")).toBe("[]");
      expect(incompleteOps()).toEqual([]);

      const again = await orchestrator.push();
      expect(again).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0, failed: [] });
    });

    it("폴더 노트도 행이 된다 — DB 는 폴더 노트의 부모 아래에 서고, 행 아래 페이지는 행을 따라간다", async () => {
      await seed({
        "Books/Books.md": "# 책장\n",
        "Books/가.md": "# 가\n",
        "Books/가/메모.md": "# 메모\n",
      });
      const notePage = db.getByPath("Books/Books.md")!.notionPageId!;
      const memo = db.getByPath("Books/가/메모.md")!.notionPageId!;
      await orchestrator.prepareFolderDatabase("Books");

      const result = await orchestrator.push();

      expect(result).toMatchObject({ moved: 2, failed: [] });
      expect(notion.client.createDatabase.mock.calls[0]![0]).toMatchObject({ parentPageId: ROOT });
      expect(notion.pages.get(notePage)!.parent).toBe(NEW_DB);
      expect(db.getByPath("Books/Books.md")!.fileType).toBe("db-row");
      expect(notion.pages.get(memo)!.parent).toBe(db.getByPath("Books/가.md")!.notionPageId);
      expect(notion.client.archivePage).not.toHaveBeenCalled();
      expect(await orchestrator.push()).toMatchObject({
        created: 0,
        updated: 0,
        moved: 0,
        failed: [],
      });
    });

    it("옮기다 멈추면 다음 push 가 남은 페이지를 마저 옮긴다", async () => {
      await seed({ "Books/가.md": "# 가\n", "Books/나.md": "# 나\n" });
      await orchestrator.prepareFolderDatabase("Books");
      let calls = 0;
      const move = notion.client.movePageToDataSource.getMockImplementation()!;
      notion.client.movePageToDataSource.mockImplementation(async (...args: unknown[]) => {
        if (++calls === 2) throw new Error("network down");
        return (move as (...a: unknown[]) => Promise<void>)(...args);
      });

      const first = await orchestrator.push();
      expect(first.failed).toEqual([
        expect.objectContaining({ path: "Books/나.md", operation: "move" }),
      ]);
      expect(db.getByPath("Books")).not.toBeNull();
      expect(db.getMeta("prepared_dbs")).not.toBe("[]");

      const second = await orchestrator.push();
      expect(second).toMatchObject({ moved: 1, failed: [] });
      expect(db.getByPath("Books/나.md")!.fileType).toBe("db-row");
      expect(db.getByPath("Books")).toBeNull();
      expect(notion.client.createDatabase).toHaveBeenCalledTimes(1);
    });
  });
});
