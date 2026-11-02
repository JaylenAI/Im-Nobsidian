/**
 * dry-run 이 이번 pull 이 새로 찾을 DB 의 행도 센다 — 루트 바로 아래 DB(처음 받는 볼트 · 상태 DB 를 잃은 볼트 · 루트가
 * 바뀐 볼트)와 미리 보며 본문을 읽은 페이지 안의 DB. 예전에는 세지 않고 «미리 세지 않았습니다» 만 알려, 상태 DB 를 잃은
 * 볼트에서 미리 보기 5 · 실제 8 처럼 어긋났다(0.19.0 smoke). 새 페이지의 본문도 읽어 센다(0.21) — 0.21 은 100개까지만
 * 읽었다. 이제 모두 읽고, 실제 pull 처럼 Markdown API 가 실패하면 블록으로 읽는다. 둘 다 읽지 못한 새 페이지 안의 DB 만 알린다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 돈다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  DISCOVERED_DBS_META_KEY,
  DISCOVERY_SCANNED_META_KEY,
} from "../../src/sync/discovered-databases.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-11-02";
const ROOT = "root-page-id";
const FOUND = "db000000-0000-4000-8000-0000000000d1";

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("dry-run 이 새로 찾을 DB 의 행", () => {
  let tempDir: string;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let dbs = 0;
  let opened: StateDB[] = [];

  const open = () => {
    const db = StateDB.open(join(tempDir, `state-${++dbs}.db`));
    opened.push(db);
    return {
      db,
      orchestrator: new SyncOrchestrator(
        createConfig({
          notion: { token: "ntn_test_token", rootPageId: ROOT, parentMode: "page", databases: [] },
          sync: { ...DEFAULT_CONFIG.sync },
          advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
        }),
        db,
        notion.client as never,
        vault.fs(),
      ),
    };
  };
  const rowsUnder = (paths: readonly string[]) =>
    paths.filter((path) => path.endsWith("/F1.md") || path.endsWith("/F2.md")).sort();

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-dry-new-db-"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseViewsConfig.mockImplementation(async (databaseId: string) => ({
      databaseId,
      lastSynced: "",
      views: [],
    }));
    notion.client.getDatabaseSyncability.mockResolvedValue({ title: "Found", queryable: true });
    notion.client.getChildDatabaseIds.mockImplementation(async (id: string) =>
      id === ROOT ? [FOUND] : [],
    );
    notion.add(FOUND, "F1", "행 하나", {});
    notion.add(FOUND, "F2", "행 둘", {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // 시험이 이미 닫았다
      }
    }
    opened = [];
    await rm(tempDir, { recursive: true, force: true });
  });

  it("처음 받는 볼트 — 루트 아래 DB 의 행을 세고, 새 페이지의 본문을 읽어 알리지 않는다 · 아무것도 적지 않는다", async () => {
    notion.add(ROOT, "A", "a 본문");
    const { db, orchestrator } = open();

    const planned = await orchestrator.pull({ dryRun: true });
    expect(planned.created).toBe(3);
    expect(planned.undiscoveredDatabases).toBeUndefined();
    expect(vault.files.size).toBe(0);
    expect(db.getMeta(DISCOVERED_DBS_META_KEY)).toBeNull();
    expect(db.getMeta(DISCOVERY_SCANNED_META_KEY)).toBeNull();

    const real = await orchestrator.pull();
    expect(real.created).toBe(planned.created);
    expect(rowsUnder([...vault.files.keys()])).toHaveLength(2);
  });

  it("상태 DB 를 잃은 볼트 — 루트 아래 DB 의 행도 다시 이을 것으로 실제 pull 과 같이 센다 · 알리지 않는다", async () => {
    notion.add(ROOT, "A", "a 본문");
    const first = open();
    await first.orchestrator.pull();
    first.db.close();
    at("10:03:00");
    const { orchestrator } = open();

    const planned = await orchestrator.pull({ dryRun: true });
    expect(planned.created).toBe(0);
    expect(planned.undiscoveredDatabases).toBeUndefined();
    const plannedPaths = [...(planned.relinkedPaths ?? [])].sort();
    expect(plannedPaths).toContain("A.md");
    expect(rowsUnder(plannedPaths)).toHaveLength(2);

    const real = await orchestrator.pull();
    expect(real.created).toBe(0);
    expect([...(real.relinkedPaths ?? [])].sort()).toEqual(plannedPaths);
  });

  it("루트가 바뀌어 그 아래 새로 생긴 DB — 행을 센다", async () => {
    notion.client.getChildDatabaseIds.mockResolvedValue([]);
    const { orchestrator } = open();
    await orchestrator.pull();
    at("10:20:00");
    notion.client.getChildDatabaseIds.mockImplementation(async (id: string) =>
      id === ROOT ? [FOUND] : [],
    );
    const search = notion.client.searchRecentPages.getMockImplementation()!;
    notion.client.searchRecentPages.mockImplementation(async (...args: unknown[]) => [
      ...(await (search as (...a: unknown[]) => Promise<unknown[]>)(...args)),
      {
        id: ROOT,
        last_edited_time: `${DAY}T10:20:00.000Z`,
        last_edited_by: { id: "user" },
        parentDatabaseId: null,
        parent: { type: "workspace", workspace: true },
        title: "Root",
      },
    ]);
    at("10:21:00");

    const planned = await orchestrator.pull({ dryRun: true });
    expect(planned.created).toBe(2);
    expect(planned.undiscoveredDatabases).toBeUndefined();
    const real = await orchestrator.pull();
    expect(real.created).toBe(2);
  });

  it("다시 이을 노트의 본문 안 DB — 그 노트 옆 폴더의 행으로 센다", async () => {
    const INNER = "db000000-0000-4000-8000-0000000000d2";
    notion.client.getChildDatabaseIds.mockResolvedValue([]);
    notion.add(INNER, "I1", "안의 행", {});
    notion.add(
      ROOT,
      "Hub",
      `허브\n\n<database url="https://www.notion.so/${INNER.replace(/-/g, "")}" inline="true">Inner</database>`,
    );
    notion.client.getDatabaseSyncability.mockResolvedValue({ title: "Inner", queryable: true });
    const first = open();
    await first.orchestrator.pull();
    first.db.close();
    const innerRow = [...vault.files.keys()].find((path) => path.endsWith("/I1.md"));
    expect(innerRow).toBeDefined();
    at("10:03:00");
    const { orchestrator } = open();

    const planned = await orchestrator.pull({ dryRun: true });
    expect(planned.created).toBe(0);
    expect(planned.relinkedPaths).toContain(innerRow);
    const real = await orchestrator.pull();
    expect([...(real.relinkedPaths ?? [])].sort()).toEqual(
      [...(planned.relinkedPaths ?? [])].sort(),
    );
  });

  it("새 페이지 안의 DB — 본문을 읽어 그 행을 실제 pull 과 같이 센다", async () => {
    const INNER = "db000000-0000-4000-8000-0000000000d3";
    notion.client.getChildDatabaseIds.mockResolvedValue([]);
    notion.add(INNER, "I1", "안의 행", {});
    notion.add(INNER, "I2", "안의 행 둘", {});
    notion.add(
      ROOT,
      "New",
      `새 페이지\n\n<database url="https://www.notion.so/${INNER.replace(/-/g, "")}" inline="true">Inner</database>`,
    );
    notion.client.getDatabaseSyncability.mockResolvedValue({ title: "Inner", queryable: true });
    const { orchestrator } = open();

    const planned = await orchestrator.pull({ dryRun: true });
    expect(planned.undiscoveredDatabases).toBeUndefined();
    const real = await orchestrator.pull();
    expect(planned.created).toBe(real.created);
    expect(planned.created).toBe(3);
  });

  it("새 페이지 안의 DB 행은 실제 pull 이 받을 자리(새 페이지 옆)로 보인다 — databases/ 아래가 아니다", async () => {
    const INNER = "db000000-0000-4000-8000-0000000000d5";
    notion.client.getChildDatabaseIds.mockResolvedValue([]);
    notion.add(INNER, "I1", "안의 행", {});
    const hub = notion.add(ROOT, "Hub", "허브").id;
    notion.add(
      hub,
      "Inside",
      `안쪽\n\n<database url="https://www.notion.so/${INNER.replace(/-/g, "")}" inline="true">Inner</database>`,
    );
    notion.client.getDatabaseSyncability.mockResolvedValue({ title: "Inner", queryable: true });
    const { orchestrator } = open();
    const shown: string[] = [];

    await orchestrator.pull({
      dryRun: true,
      onProgress: (_current, _total, item) => shown.push(item.path),
    });
    await orchestrator.pull();
    const row = [...vault.files.keys()].find((path) => path.endsWith("/I1.md"));
    expect(row).toBeDefined();
    expect(row!.startsWith("Hub/")).toBe(true);
    expect(shown).toContain(row);
  });

  it("새 페이지가 많아도(150) 모두 읽어 그 안의 DB 행을 실제 pull 과 같이 센다 · 알리지 않는다", async () => {
    const INNER = "db000000-0000-4000-8000-0000000000d4";
    notion.client.getChildDatabaseIds.mockResolvedValue([]);
    notion.add(INNER, "I1", "안의 행", {});
    for (let i = 0; i < 149; i++) notion.add(ROOT, `P${i}`, "본문");
    notion.add(
      ROOT,
      "Last",
      `맨 끝\n\n<database url="https://www.notion.so/${INNER.replace(/-/g, "")}" inline="true">Inner</database>`,
    );
    notion.client.getDatabaseSyncability.mockResolvedValue({ title: "Inner", queryable: true });
    const { orchestrator } = open();
    const read = vi.spyOn(notion.client, "getPageMarkdown");

    const planned = await orchestrator.pull({ dryRun: true });
    expect(read).toHaveBeenCalledTimes(150);
    expect(planned.undiscoveredDatabases).toBeUndefined();
    const real = await orchestrator.pull();
    expect(planned.created).toBe(real.created);
    expect(planned.created).toBe(151);
  });

  it("Markdown API 로 읽지 못한 새 페이지는 실제 pull 처럼 블록으로 읽는다 — 둘 다 못 읽으면 알린다", async () => {
    notion.client.getChildDatabaseIds.mockResolvedValue([]);
    notion.add(ROOT, "A", "a 본문");
    notion.client.getPageMarkdown.mockRejectedValueOnce(new Error("일시 오류"));
    const tree = vi.spyOn(notion.client, "getBlockTree");
    const first = open();
    expect((await first.orchestrator.pull({ dryRun: true })).undiscoveredDatabases).toBeUndefined();
    expect(tree).toHaveBeenCalled();

    notion.client.getPageMarkdown.mockRejectedValueOnce(new Error("일시 오류"));
    notion.client.getBlockTree.mockRejectedValueOnce(new Error("일시 오류"));
    const second = open();
    expect((await second.orchestrator.pull({ dryRun: true })).undiscoveredDatabases).toBe(true);
  });
});
