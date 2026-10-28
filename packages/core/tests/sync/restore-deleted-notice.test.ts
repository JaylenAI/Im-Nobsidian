/**
 * 거절한 로컬 삭제를 되살리기 전에 알린다(D8).
 *
 * `sync.deleteSync` 가 꺼져 있으면 볼트에서 지운 노트는 Notion 에서 지우지 않고, 다음 pull 이 Notion 에서 되살린다.
 * 예전에는 push 가 대기로 적기만 하고 아무 말이 없었고, pull 은 「N restored」 수만 알려 어느 파일이 돌아왔는지
 * 몰랐다 — 지운 파일이 말없이 돌아왔다. 이제 push 는 되살아날 노트를, pull 은 되살린 노트를 경로로 알린다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { DatabaseSyncConfig } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000a1";
const TASKS: DatabaseSyncConfig = {
  databaseId: DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

describe("deleteSync 가 꺼진 볼트의 로컬 삭제", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (deleteSync = false): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [TASKS] },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-restore-notice-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 노트 하나 · 행 하나를 받고, 둘 다 볼트에서 지운다. */
  async function deletedLocally(orchestrator: SyncOrchestrator): Promise<string[]> {
    notion.add("root-page-id", "지운 노트", "본문");
    const row = notion.add(DB_ID, "지운 행", "", { properties: {} });
    expect(await orchestrator.pull()).toMatchObject({ created: 2, failed: [] });
    const paths = ["지운 노트.md", db.getByNotionId(row.id)!.obsidianPath];
    for (const path of paths) vault.files.delete(path);
    return paths;
  }

  it("push 는 Notion 에서 지우지 않은 노트를 경로로 알린다 — dry-run 도", async () => {
    const orchestrator = build();
    const paths = await deletedLocally(orchestrator);

    const planned = await orchestrator.push({ dryRun: true });
    expect(planned).toMatchObject({ deleted: 0 });
    expect([...(planned.unsentDeletions ?? [])].sort()).toEqual([...paths].sort());

    const pushed = await orchestrator.push();
    expect(pushed).toMatchObject({ deleted: 0, failed: [] });
    expect([...(pushed.unsentDeletions ?? [])].sort()).toEqual([...paths].sort());
    expect(notion.client.archivePage).not.toHaveBeenCalled();
  });

  it("pull 은 되살린 노트 · 행을 경로로 알린다 — dry-run 은 되살릴 것을", async () => {
    const orchestrator = build();
    const paths = await deletedLocally(orchestrator);

    const planned = await orchestrator.pull({ dryRun: true });
    expect(planned).toMatchObject({ restored: 2 });
    expect([...(planned.restoredPaths ?? [])].sort()).toEqual([...paths].sort());
    for (const path of paths) expect(vault.read(path)).toBeUndefined();

    const pulled = await orchestrator.pull();
    expect(pulled).toMatchObject({ restored: 2, failed: [] });
    expect([...(pulled.restoredPaths ?? [])].sort()).toEqual([...paths].sort());
    for (const path of paths) expect(vault.read(path)).toBeDefined();

    // 되살린 뒤에는 알릴 것이 없다.
    const again = await orchestrator.pull();
    expect(again.restoredPaths).toBeUndefined();
  });

  it("deleteSync 가 켜져 있으면 Notion 에서도 지우므로 알릴 것이 없다", async () => {
    const orchestrator = build(true);
    await deletedLocally(orchestrator);

    const pushed = await orchestrator.push();
    expect(pushed).toMatchObject({ deleted: 2, failed: [] });
    expect(pushed.unsentDeletions).toBeUndefined();
  });
});
