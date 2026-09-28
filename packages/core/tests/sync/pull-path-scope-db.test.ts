/**
 * 경로를 좁힌 pull(`pull --path` · 변경 패널의 항목별 받기)은 DB 행도 그 범위만 받는다.
 *
 * 예전에는 DB 행의 삭제만 범위를 따랐고, 만들기 · 고치기는 범위와 상관없이 모든 행을 받았다 —
 * 노트 하나를 받으려 해도 바뀐 행이 모두 볼트에 쓰였다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { DatabaseSyncConfig } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000a1";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("경로를 좁힌 pull 은 DB 행도 그 범위만 받는다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;
  let rowA: { id: string; path: string };
  let rowB: { id: string; path: string };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-pull-scope-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [ROW_DB] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

    const a = notion.add(ROW_DB_ID, "A", "A 처음", {});
    const b = notion.add(ROW_DB_ID, "B", "B 처음", {});
    at("10:00:20");
    expect(await orchestrator.pull()).toMatchObject({ created: 2, failed: [] });
    rowA = { id: a.id, path: db.getByNotionId(a.id)!.obsidianPath };
    rowB = { id: b.id, path: db.getByNotionId(b.id)!.obsidianPath };

    // 두 행을 Notion 에서 고치고 새 행을 하나 만든다.
    at("10:02:00");
    notion.edit(rowA.id, (page) => {
      page.body = "A 원격 편집";
    });
    notion.edit(rowB.id, (page) => {
      page.body = "B 원격 편집";
    });
    notion.add(ROW_DB_ID, "C", "C 새 행", {});
    at("10:03:00");
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const rowPaths = () => [...vault.files.keys()].filter((path) => path.endsWith(".md")).sort();

  it("행 하나를 받으면 그 행만 쓰고, 다른 행 · 새 행은 다음 pull 이 받는다", async () => {
    const before = new Map([...vault.files].map(([path, file]) => [path, file.mtime]));
    const result = await orchestrator.pull({ paths: [rowA.path] });

    expect(result).toMatchObject({ created: 0, updated: 1, failed: [] });
    // 보기(`.base`)도 다시 쓰지 않는다 — 바뀐 파일은 받은 행 하나다.
    const rewritten = [...vault.files]
      .filter(([path, file]) => before.get(path) !== file.mtime)
      .map(([path]) => path);
    expect(rewritten).toEqual([rowA.path]);
    expect(vault.read(rowA.path)).toContain("A 원격 편집");
    expect(vault.read(rowB.path)).toContain("B 처음");
    expect(rowPaths()).toEqual([rowA.path, rowB.path].sort());

    at("10:04:00");
    const full = await orchestrator.pull();

    expect(full).toMatchObject({ created: 1, updated: 1, failed: [] });
    expect(vault.read(rowB.path)).toContain("B 원격 편집");
    expect(rowPaths()).toHaveLength(3);
  });

  it("DB 폴더를 범위로 주면 새 행까지 받는다", async () => {
    const result = await orchestrator.pull({ paths: ["Tasks"] });

    expect(result).toMatchObject({ created: 1, updated: 2, failed: [] });
    expect(rowPaths()).toHaveLength(3);
  });

  it("범위가 DB 폴더 밖이면 DB 를 조회하지도 쓰지도 않는다", async () => {
    notion.client.queryAllDatabasePages.mockClear();

    const result = await orchestrator.pull({ paths: ["Notes"] });

    expect(result).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(notion.client.queryAllDatabasePages).not.toHaveBeenCalled();
    expect(vault.read(rowA.path)).toContain("A 처음");
    expect(vault.read(rowB.path)).toContain("B 처음");
  });
});
