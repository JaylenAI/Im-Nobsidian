/**
 * 충돌 전략 merge (P7) — 노트와 Notion 이 둘 다 바뀌었어도 서로 다른 줄을 고쳤으면 지난 사본을 공통 조상으로
 * 3-way 로 합친다. 합친 글은 볼트에 쓰고 이어지는 push 가 Notion 에 올린다. 같은 줄을 다르게 고쳤으면 manual 처럼
 * 충돌로 남기고 노트에 충돌 표시를 넣지 않는다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 다음 sync 까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-10-31";
const BASE = "첫 줄\n\n가운데\n\n끝 줄\n";
const LOCAL = "첫 줄 로컬\n\n가운데\n\n끝 줄\n";
const REMOTE = "첫 줄\n\n가운데\n\n끝 줄 원격";
/** 로컬과 같은 줄(첫 줄)을 다르게 고친 원격. */
const OVERLAP = "첫 줄 원격\n\n가운데\n\n끝 줄";

const ROW_DB_ID = "db000000-0000-4000-8000-0000000000e1";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

function mergeConfig(databases: DatabaseSyncConfig[] = []): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases },
    sync: { ...DEFAULT_CONFIG.sync, conflictStrategy: "merge" },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

describe("충돌 전략 merge", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-merge-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseViewsConfig.mockResolvedValue({
      databaseId: ROW_DB_ID,
      lastSynced: "",
      views: [],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("페이지 노트", () => {
    let orchestrator: SyncOrchestrator;
    let pageId: string;

    beforeEach(async () => {
      orchestrator = new SyncOrchestrator(mergeConfig(), db, notion.client as never, vault.fs());
      vault.write("Note.md", BASE);
      await orchestrator.push();
      at("10:00:20");
      await orchestrator.pull();
      pageId = db.getByPath("Note.md")!.notionPageId!;
    });

    /** 양쪽을 고친다 — 로컬은 `local`, Notion 은 `remote`. */
    function editBoth(local: string, remote: string): void {
      at("10:02:00");
      vault.write("Note.md", local);
      notion.edit(pageId, (page) => {
        page.body = remote;
      });
      at("10:03:00");
    }

    it("sync — 다른 줄을 고쳤으면 합쳐 양쪽에 쓰고, 다음 sync 는 할 일이 없다", async () => {
      editBoth(LOCAL, REMOTE);

      const result = await orchestrator.sync();

      expect(result.conflicts).toEqual([]);
      expect(result.pull).toMatchObject({ updated: 1, mergedPaths: ["Note.md"], failed: [] });
      expect(result.push).toMatchObject({ updated: 1, failed: [] });
      const merged = vault.read("Note.md")!;
      expect(merged).toContain("첫 줄 로컬");
      expect(merged).toContain("끝 줄 원격");
      expect(merged).not.toContain("<<<<<<<");
      expect(notion.pages.get(pageId)!.body).toContain("첫 줄 로컬");
      expect(notion.pages.get(pageId)!.body).toContain("끝 줄 원격");
      expect(db.getByPath("Note.md")!.status).toBe("synced");

      at("10:05:00");
      const again = await orchestrator.sync();
      expect(again.pull).toMatchObject({ created: 0, updated: 0, conflicts: [] });
      expect(again.push).toMatchObject({ created: 0, updated: 0 });
      expect(vault.read("Note.md")).toBe(merged);
    });

    it("pull 만 하면 합친 글은 볼트에 있고 바뀐 노트로 남는다 — push 가 올린다", async () => {
      editBoth(LOCAL, REMOTE);

      const pulled = await orchestrator.pull();

      expect(pulled).toMatchObject({ updated: 1, mergedPaths: ["Note.md"], conflicts: [] });
      expect(pulled.writtenPaths).not.toContain("Note.md");
      expect(vault.read("Note.md")).toContain("첫 줄 로컬");
      expect(vault.read("Note.md")).toContain("끝 줄 원격");
      const status = await orchestrator.statusLocal();
      expect(status.localChanges.map((change) => change.path)).toEqual(["Note.md"]);

      at("10:04:00");
      const pushed = await orchestrator.push();
      expect(pushed).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(pageId)!.body).toContain("첫 줄 로컬");
    });

    it("같은 줄을 다르게 고쳤으면 충돌로 남기고 노트를 건드리지 않는다", async () => {
      editBoth(LOCAL, OVERLAP);

      const result = await orchestrator.sync();

      expect(result.conflicts).toHaveLength(1);
      expect(result.pull.mergedPaths).toBeUndefined();
      expect(vault.read("Note.md")).toBe(LOCAL);
      expect(db.getByPath("Note.md")!.status).toBe("conflict");
      expect(notion.pages.get(pageId)!.body).toBe(OVERLAP);
    });
  });

  describe("DB 행", () => {
    it("본문과 속성 줄을 다르게 고쳤으면 합쳐 양쪽에 쓴다", async () => {
      const orchestrator = new SyncOrchestrator(
        mergeConfig([ROW_DB]),
        db,
        notion.client as never,
        vault.fs(),
      );
      const row = notion.add(ROW_DB_ID, "Task", "첫 줄\n\n끝 줄", {});
      at("10:00:20");
      expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
      const path = db.getByNotionId(row.id)!.obsidianPath;
      const pulled = vault.read(path)!;

      at("10:02:00");
      vault.write(path, pulled.replace("첫 줄", "첫 줄 로컬"));
      notion.edit(row.id, (page) => {
        page.body = "첫 줄\n\n끝 줄 원격";
      });
      at("10:03:00");

      const result = await orchestrator.sync();

      expect(result.conflicts).toEqual([]);
      expect(result.pull).toMatchObject({ mergedPaths: [path], failed: [] });
      expect(result.push).toMatchObject({ failed: [] });
      expect(vault.read(path)).toContain("첫 줄 로컬");
      expect(vault.read(path)).toContain("끝 줄 원격");
      expect(notion.pages.get(row.id)!.body).toContain("첫 줄 로컬");
      expect(notion.pages.get(row.id)!.body).toContain("끝 줄 원격");

      at("10:05:00");
      const again = await orchestrator.sync();
      expect(again.pull).toMatchObject({ updated: 0, conflicts: [] });
      expect(again.push).toMatchObject({ updated: 0 });
    });
  });
});
