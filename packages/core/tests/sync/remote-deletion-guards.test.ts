/**
 * Notion 에서 지운 페이지 · 받기 전용 방향 · 「복제」 사본 — 지운 것과 쓰지 말아야 할 곳의 경계.
 *
 * - 지운 페이지에 push: 원격 삭제를 알아채는 것은 deleteSync 를 켠 pull 의 전체 대조뿐이다. 꺼 두면 지운
 *   페이지를 계속 고쳐 보내다 Notion 의 영어 오류(«This page is in the trash») 로 매번 실패했다
 *   (2026-10-12 실측). 고친 뒤: 충돌로 남기고 무엇을 고를지 알린다.
 * - 받기 전용(`direction: "pull"`) 해소: 해소가 로컬 · 병합 결과를 Notion 에 올렸다. 고친 뒤: 볼트에만 둔다.
 * - 「복제」 사본(`노트.conflict.md`): 다음 push 가 새 페이지로 올렸다. 고친 뒤: 올리지 않는다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다.
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
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

describe("지운 페이지 · 받기 전용 · 복제 사본의 경계", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (sync: Partial<Config["sync"]> = {}): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, conflictStrategy: "manual", ...sync },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-remote-guards-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 올리고 받아 둔 노트의 페이지 id. */
  async function syncedNote(orchestrator: SyncOrchestrator, path = "Note.md"): Promise<string> {
    vault.write(path, "원본\n");
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    await orchestrator.pull();
    return db.getByPath(path)!.notionPageId!;
  }

  const pageCount = () => notion.pages.size;

  describe("Notion 에서 지운 페이지에 push", () => {
    it("deleteSync 꺼짐 — 고친 노트를 보내지 않고 충돌로 남긴다", async () => {
      const orchestrator = build({ deleteSync: false });
      const pageId = await syncedNote(orchestrator);
      notion.edit(pageId, (page) => {
        page.archived = true;
      });
      vault.write("Note.md", "로컬에서 고침\n");
      notion.client.replacePageMarkdown.mockClear();

      const result = await orchestrator.push();

      expect(result.updated).toBe(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.error).toContain("Notion 에서 지운 페이지라 올리지 않음");
      expect(result.failed[0]!.error).toContain("Note.md");
      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(db.getByPath("Note.md")!.status).toBe("conflict");
      // 파일은 그대로 — 묻지 않고 지우지도 다시 만들지도 않는다.
      expect(vault.read("Note.md")).toBe("로컬에서 고침\n");
      expect(pageCount()).toBe(1);
    });

    it("충돌로 남은 뒤의 push 는 다시 시도하지 않는다 — 같은 실패를 되풀이하지 않는다", async () => {
      const orchestrator = build({ deleteSync: false });
      const pageId = await syncedNote(orchestrator);
      notion.edit(pageId, (page) => {
        page.archived = true;
      });
      vault.write("Note.md", "로컬에서 고침\n");
      await orchestrator.push();
      notion.client.getPage.mockClear();

      const again = await orchestrator.push();

      expect(again.failed).toEqual([]);
      expect(notion.client.getPage).not.toHaveBeenCalled();
    });

    it("페이지가 아예 없어도(404) 같다", async () => {
      const orchestrator = build({ deleteSync: false });
      const pageId = await syncedNote(orchestrator);
      notion.pages.delete(pageId);
      vault.write("Note.md", "로컬에서 고침\n");

      const result = await orchestrator.push();

      expect(result.failed[0]!.error).toContain("Notion 에서 지운 페이지라 올리지 않음");
      expect(db.getByPath("Note.md")!.status).toBe("conflict");
    });

    it("옮긴 노트도 — 지운 페이지를 옮기지 않고 충돌로 남긴다", async () => {
      const orchestrator = build({ deleteSync: false });
      const pageId = await syncedNote(orchestrator);
      notion.edit(pageId, (page) => {
        page.archived = true;
      });
      vault.rename("Note.md", "Renamed.md");
      notion.client.updatePageProperties.mockClear();

      const result = await orchestrator.push();

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.error).toContain("Notion 에서 지운 페이지라 올리지 않음");
      expect(notion.client.updatePageProperties).not.toHaveBeenCalled();
      expect(db.getByPath("Renamed.md")!.status).toBe("conflict");
    });

    it("충돌 해결 — 로컬 유지는 새 페이지로 다시 만들고, 원격 유지는 볼트에서 지운다", async () => {
      const orchestrator = build({ deleteSync: false });
      const keepId = await syncedNote(orchestrator, "Keep.md");
      const dropId = await syncedNote(orchestrator, "Drop.md");
      for (const id of [keepId, dropId]) {
        notion.edit(id, (page) => {
          page.archived = true;
        });
      }
      vault.write("Keep.md", "살릴 글\n");
      vault.write("Drop.md", "버릴 글\n");
      await orchestrator.push();

      const conflicts = await orchestrator.listConflicts();
      expect(conflicts.map((c) => [c.syncRecord.obsidianPath, c.remoteChange.type]).sort()).toEqual(
        [
          ["Drop.md", "deleted"],
          ["Keep.md", "deleted"],
        ],
      );
      const keep = conflicts.find((c) => c.syncRecord.obsidianPath === "Keep.md")!;
      const drop = conflicts.find((c) => c.syncRecord.obsidianPath === "Drop.md")!;

      expect(await orchestrator.resolveConflict(keep, "local")).toMatchObject({ success: true });
      expect(await orchestrator.resolveConflict(drop, "remote")).toMatchObject({ success: true });

      const recreated = db.getByPath("Keep.md")!;
      expect(recreated.status).toBe("synced");
      expect(recreated.notionPageId).not.toBe(keepId);
      expect(notion.pages.get(recreated.notionPageId!)!.body).toContain("살릴 글");
      expect(vault.read("Drop.md")).toBeUndefined();
      expect(db.getByPath("Drop.md")).toBeNull();
    });
  });

  describe("받기 전용(direction: pull) 의 충돌 해결", () => {
    /** Notion 과 볼트가 같은 줄을 따로 고쳐 충돌로 받은 노트. */
    async function conflicted(orchestrator: SyncOrchestrator, local: string): Promise<string> {
      const both = build();
      const pageId = await syncedNote(both);
      notion.edit(pageId, (page) => {
        page.body = "원본\n\n원격 줄";
      });
      vault.write("Note.md", local);
      const pulled = await orchestrator.pull();
      expect(pulled.conflicts).toHaveLength(1);
      return pageId;
    }

    it("로컬 유지 — Notion 에 쓰지 않고 볼트에만 둔다", async () => {
      const orchestrator = build({ direction: "pull" });
      const pageId = await conflicted(orchestrator, "로컬 줄\n원본\n");
      const before = notion.pages.get(pageId)!.lastEdited;
      notion.client.replacePageMarkdown.mockClear();
      const [conflict] = await orchestrator.listConflicts();

      const result = await orchestrator.resolveConflict(conflict!, "local");

      expect(result.success).toBe(true);
      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(notion.client.createPageWithMarkdown).toHaveBeenCalledTimes(1); // 처음 push 뿐
      expect(notion.pages.get(pageId)!.lastEdited).toBe(before);
      expect(vault.read("Note.md")).toBe("로컬 줄\n원본\n");
      expect(db.getByPath("Note.md")!.status).toBe("synced");
    });

    it("로컬 유지 뒤의 pull 은 같은 원격 변경으로 로컬을 덮지 않는다", async () => {
      const orchestrator = build({ direction: "pull" });
      await conflicted(orchestrator, "로컬 줄\n원본\n");
      const [conflict] = await orchestrator.listConflicts();
      await orchestrator.resolveConflict(conflict!, "local");

      const next = await orchestrator.pull();

      expect(next.conflicts).toEqual([]);
      expect(vault.read("Note.md")).toBe("로컬 줄\n원본\n");
    });

    it("병합 결과도 Notion 에 쓰지 않고, 다음 pull 이 덮지 않는다", async () => {
      const orchestrator = build({ direction: "pull" });
      await conflicted(orchestrator, "로컬 첫 줄\n원본\n");
      notion.client.replacePageMarkdown.mockClear();
      const [conflict] = await orchestrator.listConflicts();

      const result = await orchestrator.resolveConflict(conflict!, "merge");
      const merged = vault.read("Note.md")!;
      const next = await orchestrator.pull();

      expect(result.success).toBe(true);
      expect(merged).toContain("로컬 첫 줄");
      expect(merged).toContain("원격 줄");
      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(next.conflicts).toEqual([]);
      expect(vault.read("Note.md")).toBe(merged);
    });

    it("충돌을 본 뒤 Notion 이 또 바뀌었으면 그 변경은 다음 pull 이 받는다", async () => {
      const orchestrator = build({ direction: "pull" });
      const pageId = await conflicted(orchestrator, "로컬 줄\n원본\n");
      const [conflict] = await orchestrator.listConflicts();
      notion.edit(pageId, (page) => {
        page.body = "원본\n\n원격 줄\n\n나중 줄";
      });

      await orchestrator.resolveConflict(conflict!, "local");
      await orchestrator.pull();

      expect(vault.read("Note.md")).toContain("나중 줄");
    });

    it("복제도 Notion 에 쓰지 않는다", async () => {
      const orchestrator = build({ direction: "pull" });
      await conflicted(orchestrator, "원본\n\n로컬 줄\n");
      notion.client.replacePageMarkdown.mockClear();
      const [conflict] = await orchestrator.listConflicts();

      const result = await orchestrator.resolveConflict(conflict!, "duplicate");

      expect(result.success).toBe(true);
      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(vault.read("Note.conflict.md")).toBeDefined();
    });

    it("지운 페이지의 로컬 유지 — 새 페이지를 만들지 않고 파일만 둔다", async () => {
      const both = build({ deleteSync: true });
      const pageId = await syncedNote(both);
      notion.edit(pageId, (page) => {
        page.archived = true;
      });
      vault.write("Note.md", "로컬에서 고침\n");
      const orchestrator = build({ direction: "pull", deleteSync: true });
      const pulled = await orchestrator.pull({ force: true });
      expect(pulled.conflicts.map((c) => c.remoteChange.type)).toEqual(["deleted"]);
      const [conflict] = await orchestrator.listConflicts();

      expect(await orchestrator.resolveConflict(conflict!, "local")).toMatchObject({
        success: true,
      });

      expect(notion.client.createPageWithMarkdown).toHaveBeenCalledTimes(1); // 처음 push 뿐
      expect(vault.read("Note.md")).toBe("로컬에서 고침\n");
      expect(db.getByPath("Note.md")).toBeNull();
    });

    it("양방향이면 예전처럼 해소 결과를 올린다", async () => {
      const orchestrator = build();
      const pageId = await conflicted(orchestrator, "로컬 줄\n원본\n");
      const [conflict] = await orchestrator.listConflicts();

      await orchestrator.resolveConflict(conflict!, "local");

      expect(notion.pages.get(pageId)!.body).toContain("로컬 줄");
    });
  });

  describe("「복제」 사본(노트.conflict.md)", () => {
    it("다음 push 가 새 페이지로 올리지 않는다", async () => {
      const orchestrator = build();
      const pageId = await syncedNote(orchestrator);
      notion.edit(pageId, (page) => {
        page.body = "원본\n\n원격 줄";
      });
      vault.write("Note.md", "로컬 줄\n원본\n");
      await orchestrator.pull();
      const [conflict] = await orchestrator.listConflicts();
      await orchestrator.resolveConflict(conflict!, "duplicate");
      expect(vault.read("Note.conflict.md")).toBeDefined();

      const result = await orchestrator.push();

      expect(result.created).toBe(0);
      expect(result.failed).toEqual([]);
      expect(pageCount()).toBe(1);
      expect(db.getByPath("Note.conflict.md")).toBeNull();
    });

    it("이름을 바꾸면 여느 노트처럼 올린다", async () => {
      const orchestrator = build();
      await syncedNote(orchestrator);
      vault.write("Note.conflict.md", "사본\n");
      vault.rename("Note.conflict.md", "Note copy.md");

      const result = await orchestrator.push();

      expect(result.created).toBe(1);
    });
  });
});
