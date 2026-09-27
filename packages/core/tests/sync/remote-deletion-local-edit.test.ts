/**
 * D — Notion 에서 지운 노트에 올리지 않은 로컬 편집이 있으면 pull 이 그 편집째 지웠다.
 *
 * 수정과 삭제가 겹친 것인데, 어느 충돌 전략이든 파일을 지웠다 — 로컬을 지키라는 local-first 도.
 * 편집은 볼트에도 Notion 에도 남지 않았다.
 *
 * 고친 뒤: remote-first 만 지운다. local-first 는 파일을 두고 추적만 놓아 이어지는 push 가 새
 * 페이지로 만든다. manual · duplicate 는 충돌로 남기고, 사용자가 «로컬 유지»(Notion 에 다시 만든다)나
 * «원격 유지»(볼트에서도 지운다)를 고른다. 편집이 없는 노트는 예전처럼 지운다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { applicableChoices } from "../../src/conflict/resolver.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { DatabaseSyncConfig } from "../../src/types/config.js";
import type { ConflictStrategy } from "../../src/types/sync.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000a1";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};
const EDITED = "원본\n\n로컬에서 더함\n";
const STRATEGIES: readonly ConflictStrategy[] = [
  "manual",
  "local-first",
  "remote-first",
  "duplicate",
];

/** 이 기기 시계를 `DAY` 의 그 시각으로 — 메모리 Notion 의 수정 시각도 이 시계를 따른다. */
function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("D 원격에서 지운 노트의 올리지 않은 로컬 편집", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  /** 플러그인과 같은 설정 — 페이지 모드 · deleteSync 켬 · 전략만 바꾼다. */
  const build = (strategy: ConflictStrategy): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [ROW_DB] },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true, conflictStrategy: strategy },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
  const trash = (id: string): void => {
    notion.edit(id, (page) => {
      page.archived = true;
    });
  };
  /** 휴지통이 아닌 페이지 가운데 이 본문을 가진 것. */
  const livePagesWith = (text: string) =>
    [...notion.pages.values()].filter((page) => !page.archived && page.body.includes(text));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-remote-deletion-"));
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

  /** 올리고 한 번 받아 둔 노트를 로컬에서 고친 뒤 Notion 에서 휴지통으로 보낸다. */
  async function editedThenTrashedNote(orchestrator: SyncOrchestrator): Promise<string> {
    vault.write("Note.md", "원본\n");
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    at("10:00:20");
    await orchestrator.pull();
    const pageId = db.getByPath("Note.md")!.notionPageId!;
    at("10:02:00");
    vault.write("Note.md", EDITED);
    trash(pageId);
    at("10:03:00");
    return pageId;
  }

  /** Notion 에 있는 행을 받아 로컬에서 고친 뒤 Notion 에서 휴지통으로 보낸다. */
  async function editedThenTrashedRow(
    orchestrator: SyncOrchestrator,
  ): Promise<{ id: string; path: string }> {
    const row = notion.add(ROW_DB_ID, "Task", "원본", {});
    at("10:00:20");
    expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
    const path = db.getByNotionId(row.id)!.obsidianPath;
    at("10:02:00");
    vault.write(path, `${vault.read(path)}\n로컬에서 더함\n`);
    trash(row.id);
    at("10:03:00");
    return { id: row.id, path };
  }

  describe("페이지", () => {
    it.each(["manual", "duplicate"] as const)(
      "%s — 지우지 않고 원격 삭제 충돌로 남긴다",
      async (strategy) => {
        const orchestrator = build(strategy);
        await editedThenTrashedNote(orchestrator);

        const result = await orchestrator.pull();

        expect(result).toMatchObject({ deleted: 0, failed: [] });
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]).toMatchObject({
          localContent: EDITED,
          remoteContent: "",
          remoteChange: { type: "deleted" },
        });
        expect(vault.read("Note.md")).toBe(EDITED);
        expect(db.getByPath("Note.md")?.status).toBe("conflict");
      },
    );

    it("충돌로 남은 노트는 이어지는 push 가 건드리지 않고, 다음 pull 도 지우지 않는다", async () => {
      const orchestrator = build("manual");
      const pageId = await editedThenTrashedNote(orchestrator);

      const first = await orchestrator.sync();
      at("10:05:00");
      const again = await orchestrator.sync();

      for (const result of [first, again]) {
        expect(result.pull).toMatchObject({ deleted: 0, failed: [] });
        expect(result.pull.conflicts).toHaveLength(1);
        expect(result.push).toMatchObject({ created: 0, updated: 0, failed: [] });
      }
      expect(vault.read("Note.md")).toBe(EDITED);
      expect(notion.pages.get(pageId)?.archived).toBe(true);
      expect(notion.pages.get(pageId)?.body).not.toContain("로컬에서 더함");
      expect(livePagesWith("로컬에서 더함")).toEqual([]);
    });

    it("local-first — 파일을 두고 이어지는 push 가 새 페이지로 만든다", async () => {
      const orchestrator = build("local-first");
      const pageId = await editedThenTrashedNote(orchestrator);

      const result = await orchestrator.sync();

      expect(result.pull).toMatchObject({ deleted: 0, conflicts: [], failed: [] });
      expect(result.push).toMatchObject({ created: 1, failed: [] });
      expect(vault.read("Note.md")).toBe(EDITED);
      const record = db.getByPath("Note.md")!;
      expect(record).toMatchObject({ status: "synced" });
      expect(record.notionPageId).not.toBe(pageId);
      expect(livePagesWith("로컬에서 더함").map((page) => page.id)).toEqual([record.notionPageId]);
      expect(notion.pages.get(pageId)?.archived).toBe(true);
    });

    it("remote-first — 예전처럼 지운다", async () => {
      const orchestrator = build("remote-first");
      await editedThenTrashedNote(orchestrator);

      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 1, conflicts: [], failed: [] });
      expect(vault.files.has("Note.md")).toBe(false);
      expect(db.getByPath("Note.md")).toBeNull();
    });

    it.each(STRATEGIES)("%s — 로컬 편집이 없으면 지운다", async (strategy) => {
      const orchestrator = build(strategy);
      vault.write("Note.md", "원본\n");
      await orchestrator.push();
      at("10:00:20");
      await orchestrator.pull();
      at("10:02:00");
      trash(db.getByPath("Note.md")!.notionPageId!);
      at("10:03:00");

      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 1, conflicts: [], failed: [] });
      expect(vault.files.has("Note.md")).toBe(false);
      expect(db.getByPath("Note.md")).toBeNull();
    });
  });

  describe("충돌 풀기", () => {
    async function deletionConflict(orchestrator: SyncOrchestrator) {
      const pageId = await editedThenTrashedNote(orchestrator);
      await orchestrator.pull();
      const conflicts = await orchestrator.listConflicts();
      expect(conflicts).toHaveLength(1);
      return { pageId, conflict: conflicts[0]! };
    }

    it("해소 목록 · 상태 미리보기가 원격 삭제로 보이고, 고를 수 있는 것은 로컬 유지 · 원격 유지뿐이다", async () => {
      const orchestrator = build("manual");
      const { conflict } = await deletionConflict(orchestrator);

      expect(conflict).toMatchObject({
        localContent: EDITED,
        remoteContent: "",
        remoteChange: { type: "deleted" },
      });
      expect(applicableChoices(conflict)).toEqual(["local", "remote"]);
      const status = await orchestrator.status();
      expect(status.conflicts.map((c) => c.remoteChange.type)).toEqual(["deleted"]);
    });

    it("로컬 유지 — Notion 에 새 페이지로 다시 만들고, 다음 동기화가 조용하다", async () => {
      const orchestrator = build("manual");
      const { pageId, conflict } = await deletionConflict(orchestrator);

      const result = await orchestrator.resolveConflict(conflict, "local");

      expect(result).toMatchObject({ choice: "local", success: true });
      const record = db.getByPath("Note.md")!;
      expect(record).toMatchObject({ status: "synced" });
      expect(record.notionPageId).not.toBe(pageId);
      expect(livePagesWith("로컬에서 더함").map((page) => page.id)).toEqual([record.notionPageId]);
      expect(notion.pages.get(pageId)?.archived).toBe(true);

      at("10:05:00");
      const next = await orchestrator.sync();
      expect(next.pull).toMatchObject({ deleted: 0, conflicts: [], failed: [] });
      expect(next.push).toMatchObject({ created: 0, updated: 0, failed: [] });
      expect(vault.read("Note.md")).toBe(EDITED);
    });

    it("원격 유지 — 볼트에서도 지우고, 다음 동기화가 조용하다", async () => {
      const orchestrator = build("manual");
      const { conflict } = await deletionConflict(orchestrator);

      const result = await orchestrator.resolveConflict(conflict, "remote");

      expect(result).toMatchObject({ choice: "remote", success: true });
      expect(vault.files.has("Note.md")).toBe(false);
      expect(db.getByPath("Note.md")).toBeNull();
      expect(await orchestrator.listConflicts()).toEqual([]);

      at("10:05:00");
      const next = await orchestrator.sync();
      expect(next.pull).toMatchObject({ created: 0, deleted: 0, conflicts: [], failed: [] });
      expect(next.push).toMatchObject({ created: 0, failed: [] });
    });

    it.each(["merge", "duplicate"] as const)(
      "%s 는 거절하고 충돌을 그대로 둔다 — 합칠 원격 본문이 없다",
      async (choice) => {
        const orchestrator = build("manual");
        const { conflict } = await deletionConflict(orchestrator);

        await expect(orchestrator.resolveConflict(conflict, choice)).rejects.toThrow(
          /병합 · 복제로 풀 수 없음/,
        );

        expect(vault.read("Note.md")).toBe(EDITED);
        expect(vault.files.has("Note.conflict.md")).toBe(false);
        expect(db.getByPath("Note.md")?.status).toBe("conflict");
      },
    );

    it("전략으로 풀면 manual 은 거절하고 duplicate 는 로컬 유지로 푼다", async () => {
      const orchestrator = build("manual");
      const { pageId, conflict } = await deletionConflict(orchestrator);

      await expect(orchestrator.resolveConflictByStrategy(conflict, "manual")).rejects.toThrow(
        /자동 병합할 수 없음/,
      );
      expect(db.getByPath("Note.md")?.status).toBe("conflict");

      const result = await orchestrator.resolveConflictByStrategy(conflict, "duplicate");

      expect(result).toMatchObject({ choice: "local", success: true });
      expect(db.getByPath("Note.md")?.notionPageId).not.toBe(pageId);
      expect(vault.files.has("Note.conflict.md")).toBe(false);
    });

    it("다시 만들지 못하면 이유를 알리고 파일을 두며, 다음 push 가 만든다", async () => {
      const orchestrator = build("manual");
      const { conflict } = await deletionConflict(orchestrator);
      notion.client.createPageWithMarkdown.mockRejectedValueOnce(new Error("일시 장애"));
      notion.client.createPage.mockRejectedValueOnce(new Error("일시 장애"));

      await expect(orchestrator.resolveConflict(conflict, "local")).rejects.toThrow(
        /Notion 에 다시 만들지 못함.*일시 장애/,
      );
      expect(vault.read("Note.md")).toBe(EDITED);
      expect(await orchestrator.listConflicts()).toEqual([]);
      expect(livePagesWith("로컬에서 더함")).toEqual([]);

      at("10:05:00");
      const push = await orchestrator.push();

      expect(push).toMatchObject({ created: 1, failed: [] });
      expect(livePagesWith("로컬에서 더함")).toHaveLength(1);
    });
  });

  describe("DB 행", () => {
    it("manual — 지우지 않고 원격 삭제 충돌로 남긴다", async () => {
      const orchestrator = build("manual");
      const row = await editedThenTrashedRow(orchestrator);

      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 0, failed: [] });
      expect(result.conflicts.map((c) => c.remoteChange)).toMatchObject([
        { pageId: row.id, type: "deleted" },
      ]);
      expect(vault.read(row.path)).toContain("로컬에서 더함");
      expect(db.getByPath(row.path)?.status).toBe("conflict");
    });

    it("local-first — 파일을 두고 이어지는 push 가 같은 DB 에 새 행으로 만든다", async () => {
      const orchestrator = build("local-first");
      const row = await editedThenTrashedRow(orchestrator);

      const result = await orchestrator.sync();

      expect(result.pull).toMatchObject({ deleted: 0, conflicts: [], failed: [] });
      expect(result.push).toMatchObject({ created: 1, failed: [] });
      const record = db.getByPath(row.path)!;
      expect(record.notionPageId).not.toBe(row.id);
      expect(notion.pages.get(record.notionPageId!)).toMatchObject({
        parent: ROW_DB_ID,
        parentType: "database",
        archived: false,
      });
    });

    it("로컬 유지로 풀면 같은 DB 에 새 행으로 다시 만든다", async () => {
      const orchestrator = build("manual");
      const row = await editedThenTrashedRow(orchestrator);
      await orchestrator.pull();
      const [conflict] = await orchestrator.listConflicts();

      await orchestrator.resolveConflict(conflict!, "local");

      const record = db.getByPath(row.path)!;
      expect(record).toMatchObject({ status: "synced" });
      expect(notion.pages.get(record.notionPageId!)).toMatchObject({
        parent: ROW_DB_ID,
        parentType: "database",
        archived: false,
      });
    });

    it("remote-first — 예전처럼 지운다", async () => {
      const orchestrator = build("remote-first");
      const row = await editedThenTrashedRow(orchestrator);

      const result = await orchestrator.pull();

      expect(result).toMatchObject({ deleted: 1, conflicts: [], failed: [] });
      expect(vault.files.has(row.path)).toBe(false);
      expect(db.getByNotionId(row.id)).toBeNull();
    });
  });
});
