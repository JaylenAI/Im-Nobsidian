/**
 * 발견한 DB 를 읽지 못하면 pull 이 이유와 함께 실패로 싣고, 다음 pull 이 다시 본다.
 *
 * 예전에는 경고 로그만 남기고 성공으로 끝났다 — 사용자는 그 DB 를 받지 못한 줄 몰랐다. 블록 스캔은
 * 캐시가 빌 때만 하므로, 한 번 읽지 못한 페이지 아래의 DB 는 `--force` 전까지 발견되지 않았다.
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
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";
const ROOT = "root-page-id";
const ZERO_DB = "db000000-0000-4000-8000-0000000000d0";
const ONE_DB = "db000000-0000-4000-8000-0000000000d1";

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

const notFound = () =>
  Object.assign(new Error("object_not_found"), { code: "object_not_found", status: 404 });
const denied = () =>
  Object.assign(new Error("restricted_resource"), { code: "restricted_resource", status: 403 });

describe("발견한 DB 를 읽지 못하면 실패로 싣고 다음 pull 이 다시 본다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-found-db-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseSyncability.mockImplementation(async (dbId: string) => ({
      title: dbId === ZERO_DB ? "Zero" : "One",
      queryable: true,
    }));
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, parentMode: "page", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const rows = () => [...vault.files.keys()].filter((path) => /\/R\d\.md$/.test(path)).sort();

  /** 루트 아래 DB Zero, 페이지 P 아래 DB One — 행이 하나씩 있다. */
  function twoDatabases(): { page: string } {
    const page = notion.add(ROOT, "P", "p 본문");
    notion.add(ZERO_DB, "R0", "", {});
    notion.add(ONE_DB, "R1", "", {});
    return { page: page.id };
  }

  it("발견해 둔 DB 의 행을 읽지 못하면 그 폴더와 이유를 실패로 싣는다 — 다음 pull 이 받는다", async () => {
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: ONE_DB, localFolder: "Found", titleProperty: "Name" }]),
    );
    notion.add(ONE_DB, "R1", "", {});
    notion.client.queryAllDatabasePages.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });

    const first = await orchestrator.pull();

    expect(first.failed).toEqual([{ path: "Found", operation: "update", error: "socket hang up" }]);
    expect(rows()).toEqual([]);

    at("10:02:00");
    const second = await orchestrator.pull();

    expect(second).toMatchObject({ created: 1, failed: [] });
    expect(rows()).toEqual(["Found/R1.md"]);
  });

  it("하위 DB 를 확인하지 못한 페이지는 실패로 싣고, 캐시가 차도 다음 pull 이 다시 확인한다", async () => {
    const { page } = twoDatabases();
    const denyPage = notion.add(ROOT, "Q", "q 본문").id;
    let rootReads = 0;
    notion.client.getChildDatabaseIds.mockImplementation(async (parentId: string) => {
      if (parentId === ROOT) {
        rootReads++;
        if (rootReads === 1) throw new Error("ECONNRESET");
        return [ZERO_DB];
      }
      if (parentId === denyPage) throw denied();
      return parentId === page ? [ONE_DB] : [];
    });

    const first = await orchestrator.pull();

    expect(first.failed).toEqual([
      { path: "", operation: "update", error: expect.stringContaining("ECONNRESET") },
    ]);
    expect(rows()).toEqual(["P/One/R1.md"]);

    at("10:02:00");
    const second = await orchestrator.pull();

    expect(second).toMatchObject({ created: 1, failed: [] });
    expect(rows()).toEqual(["P/One/R1.md", "databases/Zero/R0.md"]);
    expect(JSON.parse(db.getMeta("discovery_retry")!)).toEqual({ parents: [], dbs: [] });
  });

  it("찾았지만 설정을 읽지 못한 DB 는 실패로 싣고, 캐시가 차도 다음 pull 이 다시 등록한다", async () => {
    const { page } = twoDatabases();
    notion.client.getChildDatabaseIds.mockImplementation(async (parentId: string) =>
      parentId === ROOT ? [ZERO_DB] : parentId === page ? [ONE_DB] : [],
    );
    const syncability = notion.client.getDatabaseSyncability.getMockImplementation()!;
    let zeroReads = 0;
    notion.client.getDatabaseSyncability.mockImplementation(async (dbId: string) => {
      if (dbId === ZERO_DB && ++zeroReads === 1) throw new Error("502 Bad Gateway");
      return syncability(dbId);
    });

    const first = await orchestrator.pull();

    expect(first.failed).toEqual([
      { path: "", operation: "create", error: expect.stringContaining("502 Bad Gateway") },
    ]);
    expect(rows()).toEqual(["P/One/R1.md"]);

    at("10:02:00");
    const second = await orchestrator.pull();

    expect(second).toMatchObject({ created: 1, failed: [] });
    expect(rows()).toEqual(["P/One/R1.md", "databases/Zero/R0.md"]);
  });

  it("연결된 보기의 원본을 읽지 못해도 실패로 싣고 다음 pull 이 원본을 등록한다", async () => {
    const LINKED_VIEW = "db000000-0000-4000-8000-0000000000e9";
    const page = notion.add(ROOT, "P", "p 본문").id;
    notion.add(ZERO_DB, "R0", "", {});
    notion.add(ONE_DB, "R1", "", {});
    notion.client.getChildDatabaseIds.mockImplementation(async (parentId: string) =>
      parentId === ROOT ? [LINKED_VIEW] : parentId === page ? [ZERO_DB] : [],
    );
    let oneReads = 0;
    notion.client.getDatabaseSyncability.mockImplementation(async (dbId: string) => {
      if (dbId === LINKED_VIEW)
        return { title: "View", queryable: true, linkedOriginalDbId: ONE_DB };
      if (dbId === ONE_DB && ++oneReads === 1) throw new Error("503 Service Unavailable");
      return { title: dbId === ZERO_DB ? "Zero" : "One", queryable: true };
    });

    const first = await orchestrator.pull();

    expect(first.failed).toEqual([
      { path: "", operation: "create", error: expect.stringContaining("503") },
    ]);
    expect(rows()).toEqual(["P/Zero/R0.md"]);

    at("10:02:00");
    const second = await orchestrator.pull();

    expect(second).toMatchObject({ created: 1, failed: [] });
    expect(rows()).toEqual(["P/Zero/R0.md", "databases/One/R1.md"]);
  });

  it("사라진 DB(404)는 실패가 아니다 — 대상에서 뺀다", async () => {
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: ONE_DB, localFolder: "Found", titleProperty: "Name" }]),
    );
    notion.client.queryAllDatabasePages.mockImplementation(async () => {
      throw notFound();
    });

    const result = await orchestrator.pull();

    expect(result.failed).toEqual([]);
    expect(JSON.parse(db.getMeta("inaccessible_dbs")!)).toEqual([ONE_DB.replace(/-/g, "")]);
  });

  it("발견이 통째로 멈추면 그 이유를 실패로 싣는다", async () => {
    const getMeta = db.getMeta.bind(db);
    vi.spyOn(db, "getMeta").mockImplementation((key: string) => {
      if (key === "discovered_dbs") throw new Error("disk I/O error");
      return getMeta(key);
    });

    const result = await orchestrator.pull();

    expect(result.failed).toEqual([
      { path: "", operation: "update", error: expect.stringContaining("disk I/O error") },
    ]);
  });
});
