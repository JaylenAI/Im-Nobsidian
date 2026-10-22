/**
 * S-16 · S-17 — push 가 만든 폴더 페이지(폴더 레코드)를 pull 이 파일처럼 다뤘다.
 *
 * 폴더 노트 없이 올린 폴더는 폴더 경로 자체(`A/B`)로 추적한다. pull 은 이 레코드를 폴더 노트
 * 파일(`A/B/B.md`)처럼 봤다.
 *
 * - S-16: 그 폴더 페이지 아래에 Notion 에서 만든 페이지를 한 층 위(`A/`)에 받았다 — 폴더 노트
 *   파일 경로에서 파일 이름을 떼듯 폴더 이름을 뗐다.
 * - S-17: 폴더 페이지의 수정 시각이 바뀌면(그 아래에 페이지가 생겨도 Notion 이 올린다) 폴더
 *   경로를 파일로 읽어 «빈 로컬 파일» 과 원격 본문의 충돌로 남겼다. 로컬에서 폴더를 지우면
 *   되살리기가 확장자 없는 파일 `A/B` 를 썼다. Notion 에서 폴더 페이지를 지우면(deleteSync —
 *   플러그인은 늘 켠다) 폴더 경로를 파일처럼 지워, Obsidian 에서는 폴더째 휴지통으로 갔다.
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
import { createConfig, settledObservation } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-000000000001";

describe("push 가 만든 폴더 페이지를 pull 이 폴더로 다룬다 (S-16 · S-17)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-folderpull-"));
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

  const idle = { created: 0, updated: 0, deleted: 0, failed: [] };

  /** 폴더 노트 없는 폴더 `A/B` 를 push 로 만든다 — 폴더 레코드 `A` · `A/B` 와 노트 `x`. */
  async function seedFolder(): Promise<string> {
    vault.write("A/B/x.md", "x body\n");
    const pushed = await orchestrator.push();
    expect(pushed.failed).toEqual([]);
    // 증분 pull 의 조회 창 — 이 뒤에 바뀐 페이지만 받는다.
    db.setMeta("last_pull_at", "2026-09-02T00:00:00.000Z");
    const folder = db.getByPath("A/B");
    expect(folder).toMatchObject({ fileType: "folder-note" });
    return folder!.notionPageId!;
  }

  it("폴더 페이지 아래에 Notion 에서 만든 페이지는 그 폴더에 받는다 (S-16)", async () => {
    const folderB = await seedFolder();
    const page = notion.add(folderB, "C", "Remote C");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ created: 1, failed: [] });
    expect(vault.read("A/B/C.md")).toContain("Remote C");
    expect(vault.read("A/C.md")).toBeUndefined();
    expect(db.getByPath("A/B/C.md")!.notionPageId).toBe(page.id);
  });

  it("폴더 페이지의 수정 시각만 바뀌면 받을 것이 없다 — 충돌도 파일도 없이 시각만 맞춘다 (S-17)", async () => {
    const folderB = await seedFolder();
    // 그 아래에 페이지를 만들면 Notion 이 부모의 수정 시각을 올린다(2026-09-27 실측).
    const folderPage = notion.touch(folderB);

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ created: 0, updated: 0, failed: [], conflicts: [] });
    expect(vault.files.has("A/B")).toBe(false);
    expect(vault.read("A/B/B.md")).toBeUndefined();
    expect(db.getByPath("A/B")).toMatchObject({
      status: "synced",
      notionLastEdited: folderPage.lastEdited,
    });

    // 시각을 맞췄으니 다음 pull 은 그 페이지를 다시 읽지 않는다.
    notion.client.getPageMarkdown.mockClear();
    const again = await orchestrator.pull();
    expect(again).toMatchObject({ created: 0, updated: 0, failed: [], conflicts: [] });
    expect(notion.client.getPageMarkdown).not.toHaveBeenCalled();
  });

  it("Notion 에서 폴더 페이지에 본문을 쓰면 폴더 노트로 받는다 — 그 페이지가 곧 폴더 노트다 (S-17)", async () => {
    const folderB = await seedFolder();
    const folderPage = notion.pages.get(folderB)!;
    folderPage.body = "Remote folder body";
    notion.touch(folderB);

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ created: 0, updated: 1, failed: [], conflicts: [] });
    expect(vault.read("A/B/B.md")).toContain("Remote folder body");
    expect(vault.files.has("A/B")).toBe(false);
    expect(db.getByPath("A/B")).toBeNull();
    expect(db.getByPath("A/B/B.md")).toMatchObject({
      notionPageId: folderB,
      fileType: "folder-note",
      status: "synced",
    });

    // 폴더 노트가 이미 그 페이지다 — 다음 push 는 만들지도 보내지도 않는다.
    notion.client.createPageWithMarkdown.mockClear();
    notion.client.replacePageMarkdown.mockClear();
    const pushed = await orchestrator.push();
    expect(pushed).toMatchObject(idle);
    expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
    expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
  });

  it("올리지 않은 로컬 폴더 노트가 있는데 Notion 에서 폴더 페이지에 본문을 쓰면 폴더 노트의 충돌로 남긴다", async () => {
    const folderB = await seedFolder();
    vault.write("A/B/B.md", "Local folder body\n");
    notion.pages.get(folderB)!.body = "Remote folder body";
    notion.touch(folderB);

    const result = await orchestrator.pull();

    expect(result.failed).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.localChange.path).toBe("A/B/B.md");
    expect(result.conflicts[0]!.remoteContent).toContain("Remote folder body");
    // 로컬 편집을 덮지 않는다.
    expect(vault.read("A/B/B.md")).toBe("Local folder body\n");
    expect(db.getByPath("A/B/B.md")).toMatchObject({ notionPageId: folderB, status: "conflict" });

    // 충돌은 push 대상에서 빠진다 — 원격 본문을 로컬 폴더 노트로 덮지 않는다.
    notion.client.replacePageMarkdown.mockClear();
    await orchestrator.push();
    expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
    expect(notion.pages.get(folderB)!.body).toBe("Remote folder body");
  });

  it("로컬에서 폴더를 지우면 안의 노트만 되살린다 — 폴더 경로에 파일을 쓰지 않는다 (S-17)", async () => {
    await seedFolder();
    vault.files.delete("A/B/x.md");
    vault.folders.delete("A/B");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ restored: 1, failed: [], conflicts: [] });
    expect(vault.read("A/B/x.md")).toContain("x body");
    expect(vault.files.has("A/B")).toBe(false);
    expect(vault.files.has("A")).toBe(false);
  });

  it("pull --dry-run 은 폴더 페이지를 받을 것으로 세지만 아무것도 바꾸지 않는다", async () => {
    const folderB = await seedFolder();
    notion.pages.get(folderB)!.body = "Remote folder body";
    notion.touch(folderB);

    await orchestrator.pull({ dryRun: true });

    expect(vault.read("A/B/B.md")).toBeUndefined();
    expect(db.getByPath("A/B")).toMatchObject({ notionPageId: folderB, status: "synced" });
    expect(db.getByPath("A/B/B.md")).toBeNull();
  });

  it("로컬에서 폴더 이름을 바꾸고 올리기 전이면 본문을 받지 않고 이유를 남긴다 — push 뒤 pull 이 받는다", async () => {
    const folderB = await seedFolder();
    vault.renameFolder("A/B", "A/C");
    notion.pages.get(folderB)!.body = "Remote folder body";
    notion.touch(folderB);

    const first = await orchestrator.pull();

    expect(first.failed).toEqual([
      expect.objectContaining({
        path: "A/C",
        error: expect.stringContaining("이동을 Notion 에 반영하기 전"),
      }),
    ]);
    expect(vault.read("A/C/C.md")).toBeUndefined();

    const pushed = await orchestrator.push();
    expect(pushed.failed).toEqual([]);
    expect(notion.pages.get(folderB)!.title).toBe("C");

    // 받지 못한 변경이 기준 시각을 묶어 두었다 — 다음 pull 이 다시 보고 폴더 노트로 받는다.
    const second = await orchestrator.pull();
    expect(second).toMatchObject({ failed: [], conflicts: [] });
    expect(vault.read("A/C/C.md")).toContain("Remote folder body");
    expect(db.getByPath("A/C/C.md")!.notionPageId).toBe(folderB);
  });

  it("폴더 노트가 다른 페이지인 두 겹의 폴더는 본문을 받지 않고 이유를 남긴다 — 다음 pull 도 다시 본다", async () => {
    vault.write("Q/y.md", "y body\n");
    expect((await orchestrator.push()).failed).toEqual([]);
    db.setMeta("last_pull_at", "2026-09-02T00:00:00.000Z");
    const folderPage = db.getByPath("Q")!.notionPageId!;
    // S-15 이전 push 가 만든 모습 — 폴더 페이지 아래의 같은 이름의 폴더 노트.
    const content = "legacy note\n";
    vault.write("Q/Q.md", content);
    const note = notion.add(folderPage, "Q", "legacy note");
    const stat = vault.stat("Q/Q.md")!;
    db.upsert({
      obsidianPath: "Q/Q.md",
      notionPageId: note.id,
      notionParentId: folderPage,
      contentHash: computeHash(content),
      ...settledObservation(note.lastEdited),
      localLastModified: stat.mtime,
      syncDirection: "both",
      fileType: "folder-note",
      status: "synced",
      baseSnapshot: Buffer.from(content, "utf-8"),
      localMtime: stat.mtime,
      localFileSize: stat.size,
    });
    notion.pages.get(folderPage)!.body = "Remote folder body";
    notion.touch(folderPage);

    const first = await orchestrator.pull();

    expect(first.failed).toEqual([
      expect.objectContaining({
        path: "Q",
        error: expect.stringContaining("폴더 노트(Q/Q.md)가 다른 페이지"),
      }),
    ]);
    expect(vault.read("Q/Q.md")).toBe(content);
    expect(db.getByPath("Q")!.notionPageId).toBe(folderPage);
    expect(db.getByPath("Q/Q.md")!.notionPageId).toBe(note.id);

    const second = await orchestrator.pull();
    expect(second.failed).toEqual([expect.objectContaining({ path: "Q" })]);
  });

  it("v0.3 이 DB 폴더 자리에 만든 폴더 페이지는 DB 폴더에 아무것도 쓰지 않는다 — 본문은 Notion 에만 두고 아래 페이지는 예전 자리에 받는다", async () => {
    const folderB = await seedFolder();
    // v0.3 은 DB 폴더에도 폴더 페이지를 만들었다 — 그 폴더 `A/B` 가 자동 발견 DB 의 폴더다.
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: DB_ID, localFolder: "A/B", titleProperty: "Name" }]),
    );
    notion.pages.get(folderB)!.body = "Stray body";
    notion.add(folderB, "C", "Remote C");
    const folderPage = notion.touch(folderB);

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ created: 1, conflicts: [] });
    expect(result.failed.filter((f) => f.path.startsWith("A/"))).toEqual([]);
    // DB 폴더에는 행만 든다.
    expect(vault.read("A/B/B.md")).toBeUndefined();
    expect(vault.read("A/B/C.md")).toBeUndefined();
    expect(vault.read("A/C.md")).toContain("Remote C");
    expect(db.getByPath("A/B")).toMatchObject({
      notionPageId: folderB,
      status: "synced",
      notionLastEdited: folderPage.lastEdited,
    });
  });

  it("Notion 에서 폴더 페이지를 지우면 추적만 놓는다 — 올리지 않은 노트가 든 볼트 폴더를 지우지 않는다 (S-17)", async () => {
    orchestrator = new SyncOrchestrator(
      createConfig({
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
    const folderB = await seedFolder();
    vault.write("A/B/draft.md", "local draft\n");
    // Notion 은 부모를 휴지통에 넣으면 그 아래도 함께 넣는다.
    for (const page of notion.pages.values()) {
      if (page.id === folderB || page.parent === folderB) page.archived = true;
    }

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ deleted: 1, failed: [], conflicts: [] });
    expect(vault.read("A/B/x.md")).toBeUndefined();
    expect(vault.read("A/B/draft.md")).toBe("local draft\n");
    expect(db.getByPath("A/B")).toBeNull();
    expect(db.getByPath("A/B/x.md")).toBeNull();
  });
});
