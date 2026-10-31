/**
 * pull --dry-run 이 충돌을 미리 알린다 (P7) — 실제 pull 은 볼트에서도 고친 노트를 받은 원격과 견주어 충돌로
 * 남기거나 합치거나 받지 않는데, dry-run 은 받지 않아 그런 노트도 모두 «고칠 것» 으로 셌고 충돌은 늘 0건이었다.
 *
 * dry-run 도 같은 판정으로 충돌 · 합칠 노트를 알리고, 받지 않을 노트는 세지 않는다. 볼트 · 상태 DB 는 그대로다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import type { ConflictStrategy } from "../../src/types/sync.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-10-31";
const BASE = "첫 줄\n\n가운데\n\n끝 줄\n";
const LOCAL = "첫 줄 로컬\n\n가운데\n\n끝 줄\n";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000f3";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

function config(strategy: ConflictStrategy): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [ROW_DB] },
    sync: { ...DEFAULT_CONFIG.sync, conflictStrategy: strategy },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

describe("pull --dry-run 이 충돌을 미리 알린다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-pull-dry-"));
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

  /** 노트를 올려 받아 두고, 로컬은 `LOCAL` 로 · Notion 은 `remote` 로 고친다. */
  async function editedBoth(strategy: ConflictStrategy, remote: (body: string) => string) {
    const orchestrator = new SyncOrchestrator(
      config(strategy),
      db,
      notion.client as never,
      vault.fs(),
    );
    vault.write("Note.md", BASE);
    await orchestrator.push();
    at("10:00:20");
    await orchestrator.pull();
    const pageId = db.getByPath("Note.md")!.notionPageId!;
    at("10:02:00");
    vault.write("Note.md", LOCAL);
    notion.edit(pageId, (page) => {
      page.body = remote(page.body);
    });
    at("10:03:00");
    return orchestrator;
  }

  /** dry-run 이 볼트 · 상태 DB 를 건드리지 않았나. */
  async function dryRunUntouched(orchestrator: SyncOrchestrator) {
    const records = JSON.stringify(db.getAll());
    const files = JSON.stringify([...vault.files.entries()]);
    const result = await orchestrator.pull({ dryRun: true });
    expect(JSON.stringify(db.getAll())).toBe(records);
    expect(JSON.stringify([...vault.files.entries()])).toBe(files);
    return result;
  }

  it("manual — 같은 줄을 고친 노트는 충돌로 알리고 세지 않는다 — 실제 pull 과 같다", async () => {
    const orchestrator = await editedBoth("manual", (body) => body.replace("첫 줄", "첫 줄 원격"));

    const preview = await dryRunUntouched(orchestrator);

    expect(preview.updated).toBe(0);
    expect(preview.conflicts.map((c) => c.syncRecord.obsidianPath)).toEqual(["Note.md"]);
    expect(preview.conflicts[0]!.remoteContent).toContain("첫 줄 원격");
    const pulled = await orchestrator.pull();
    expect(pulled.updated).toBe(preview.updated);
    expect(pulled.conflicts.map((c) => c.syncRecord.obsidianPath)).toEqual(["Note.md"]);
  });

  it("merge — 다른 줄을 고친 노트는 합칠 것으로 알린다", async () => {
    const orchestrator = await editedBoth("merge", (body) => body.replace("끝 줄", "끝 줄 원격"));

    const preview = await dryRunUntouched(orchestrator);

    expect(preview).toMatchObject({ updated: 1, conflicts: [], mergedPaths: ["Note.md"] });
    expect(await orchestrator.pull()).toMatchObject({
      updated: 1,
      conflicts: [],
      mergedPaths: ["Note.md"],
    });
  });

  it("local-first — 로컬을 지켜 받지 않는 노트는 세지 않는다", async () => {
    const orchestrator = await editedBoth("local-first", (body) =>
      body.replace("첫 줄", "첫 줄 원격"),
    );

    const preview = await dryRunUntouched(orchestrator);

    expect(preview).toMatchObject({ updated: 0, conflicts: [] });
    expect(await orchestrator.pull()).toMatchObject({ updated: 0, conflicts: [] });
  });

  it("remote-first · 로컬을 고치지 않은 노트는 예전처럼 받을 것으로 센다", async () => {
    const orchestrator = await editedBoth("remote-first", (body) =>
      body.replace("첫 줄", "첫 줄 원격"),
    );
    const other = notion.add("root-page-id", "Other", "다른 본문");
    await orchestrator.pull({ force: true });
    at("10:04:00");
    vault.write("Note.md", LOCAL.replace("로컬", "로컬 또"));
    notion.edit(db.getByPath("Note.md")!.notionPageId!, (page) => {
      page.body = page.body.replace("첫 줄 원격", "첫 줄 원격 또");
    });
    notion.edit(other.id, (page) => {
      page.body = "다른 본문 원격";
    });
    at("10:05:00");

    const preview = await dryRunUntouched(orchestrator);

    expect(preview).toMatchObject({ updated: 2, conflicts: [] });
    expect(await orchestrator.pull()).toMatchObject({ updated: 2, conflicts: [] });
  });

  it("sync --dry-run — 충돌로 남길 노트는 push 에서 빼고, 합칠 노트는 올릴 것으로 센다 — 실제 sync 와 같다", async () => {
    const conflicted = await editedBoth("manual", (body) => body.replace("첫 줄", "첫 줄 원격"));
    const preview = await conflicted.sync({ dryRun: true });
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.push).toMatchObject({ updated: 0, failed: [] });
    const synced = await conflicted.sync();
    expect(synced.conflicts).toHaveLength(1);
    expect(synced.push).toMatchObject({ updated: 0, failed: [] });
  });

  it("sync --dry-run — merge 로 합칠 노트는 push 가 올릴 것으로 센다", async () => {
    const merging = await editedBoth("merge", (body) => body.replace("끝 줄", "끝 줄 원격"));
    const preview = await merging.sync({ dryRun: true });
    expect(preview.pull).toMatchObject({ mergedPaths: ["Note.md"] });
    expect(preview.push).toMatchObject({ updated: 1, failed: [] });
    const synced = await merging.sync();
    expect(synced.push).toMatchObject({ updated: 1, failed: [] });
  });

  it("DB 행 — 로컬도 고친 행은 충돌로 알리고 세지 않는다", async () => {
    const orchestrator = new SyncOrchestrator(
      config("manual"),
      db,
      notion.client as never,
      vault.fs(),
    );
    const row = notion.add(ROW_DB_ID, "Task", "행 본문", {});
    at("10:00:20");
    await orchestrator.pull();
    const path = db.getByNotionId(row.id)!.obsidianPath;

    at("10:02:00");
    vault.write(path, vault.read(path)!.replace("행 본문", "행 본문 로컬"));
    notion.edit(row.id, (page) => {
      page.body = "행 본문 원격";
    });
    at("10:03:00");

    const preview = await dryRunUntouched(orchestrator);

    expect(preview.updated).toBe(0);
    expect(preview.conflicts.map((c) => c.syncRecord.obsidianPath)).toEqual([path]);
    const pulled = await orchestrator.pull();
    expect(pulled.updated).toBe(0);
    expect(pulled.conflicts.map((c) => c.syncRecord.obsidianPath)).toEqual([path]);
  });

  it("DB 행 — merge 는 다른 줄을 고친 행을 합칠 것으로 알린다", async () => {
    const orchestrator = new SyncOrchestrator(
      config("merge"),
      db,
      notion.client as never,
      vault.fs(),
    );
    const row = notion.add(ROW_DB_ID, "Task", "첫 줄\n\n끝 줄", {});
    at("10:00:20");
    await orchestrator.pull();
    const path = db.getByNotionId(row.id)!.obsidianPath;

    at("10:02:00");
    vault.write(path, vault.read(path)!.replace("첫 줄", "첫 줄 로컬"));
    notion.edit(row.id, (page) => {
      page.body = "첫 줄\n\n끝 줄 원격";
    });
    at("10:03:00");

    const preview = await dryRunUntouched(orchestrator);

    expect(preview).toMatchObject({ updated: 1, conflicts: [], mergedPaths: [path] });
    expect(await orchestrator.pull()).toMatchObject({ updated: 1, mergedPaths: [path] });
  });
});
