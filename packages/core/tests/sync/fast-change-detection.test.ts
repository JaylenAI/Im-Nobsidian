/**
 * 빠른 변경 감지 — 원격이 그대로면 DB 를 조회하지 않고, 바뀐 것이 보인 DB 만 조회한다 (ADR-027).
 *
 * 예전에는 pull 마다 동기화하는 DB 를 모두 다시 조회했고, deleteSync 가 켜져 있으면(플러그인은 늘
 * 켠다) 루트 아래도 모두 훑었다 — 실볼트(발견 DB 166개)에서 원격이 그대로인데도 재pull 이 523.5초.
 * 이제 전체 대조는 주기(`sync.fullReconcileInterval`, 기본 1시간)마다만 하고, 그 사이에는 search 로
 * 바뀐 페이지 · 행 · DB 스키마를 찾는다. 조회하지 못한 DB 는 대기로 남아 다음 pull 이 다시 조회한다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다. search 는 Notion 처럼
 * 기준 시각 뒤에 고친 것만 · 휴지통 밖의 것만 돌려준다. 설정한 DB(pullAll)와 발견한 DB 가 같은 규칙을
 * 따르는지 둘 다 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { DatabaseSyncConfig } from "../../src/types/config.js";
import {
  LAST_FULL_PULL_META_KEY,
  parsePendingDatabases,
  PENDING_DATABASES_META_KEY,
} from "../../src/sync/remote-scan.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion, type MemoryPage } from "../helpers/memory-sync.js";

const DAY = "2026-09-28";
const ROOT = "root-page-id";
const TASKS = "db000000-0000-4000-8000-0000000000a1";
const NOTES = "db000000-0000-4000-8000-0000000000b2";
const DATABASES: DatabaseSyncConfig[] = [
  { databaseId: TASKS, localFolder: "Tasks", titleProperty: "Name" },
  { databaseId: NOTES, localFolder: "Notes", titleProperty: "Name" },
];
const compact = (id: string) => id.replace(/-/g, "");
const time = (hms: string) => `${DAY}T${hms}.000Z`;

function at(hms: string): void {
  vi.setSystemTime(new Date(time(hms)));
}

describe.each([
  { source: "설정한 DB", configured: true },
  { source: "발견한 DB", configured: false },
])("빠른 변경 감지 — $source", ({ configured }) => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-fast-change-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseViewsConfig.mockImplementation(async (databaseId: string) => ({
      databaseId,
      lastSynced: "",
      views: [],
    }));
    // Notion 의 search 처럼 — 기준 시각 «뒤에» 고친 것만, 휴지통 밖의 것만.
    notion.client.searchRecentPages.mockImplementation(async (since: string) =>
      [...notion.pages.values()]
        .filter((page) => !page.archived && Date.parse(page.lastEdited) > Date.parse(since))
        .map((page) => ({
          id: page.id,
          last_edited_time: page.lastEdited,
          last_edited_by: { id: page.lastEditedBy },
          parentDatabaseId: page.parentType === "database" ? page.parent : null,
        })),
    );
    if (!configured) db.setMeta("discovered_dbs", JSON.stringify(DATABASES));
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const build = (sync: Partial<typeof DEFAULT_CONFIG.sync> = {}): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: {
          token: "ntn_test_token",
          rootPageId: ROOT,
          parentMode: "page",
          databases: configured ? DATABASES : [],
        },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true, ...sync },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  /** 조회한 DB — 요청 순서대로. */
  const queried = () =>
    notion.client.queryAllDatabasePages.mock.calls.map(([databaseId]) => databaseId as string);
  const pending = () => parsePendingDatabases(db.getMeta(PENDING_DATABASES_META_KEY));

  /** 행 둘 · 하나와 페이지 하나를 10:00 에 만들고 10:05 에 처음 받는다 — 그 뒤 요청 기록을 비운다. */
  async function synced(sync: Partial<typeof DEFAULT_CONFIG.sync> = {}) {
    const orchestrator = build(sync);
    const r1 = notion.add(TASKS, "R1", "첫 본문", {});
    const r2 = notion.add(TASKS, "R2", "", {});
    const n1 = notion.add(NOTES, "N1", "", {});
    notion.add(ROOT, "Page", "본문");
    at("10:05:00");
    expect(await orchestrator.pull()).toMatchObject({ created: 4, failed: [] });
    vi.clearAllMocks();
    return { orchestrator, r1, r2, n1 };
  }

  const editBody = (row: MemoryPage, body: string) =>
    notion.edit(row.id, (page) => {
      page.body = body;
    });

  it("처음 pull 은 모두 훑고 전체 대조를 마친 시각을 적는다", async () => {
    const orchestrator = build();
    notion.add(TASKS, "R1", "", {});
    notion.add(NOTES, "N1", "", {});
    at("10:05:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({
      created: 2,
      failed: [],
      remoteScan: {
        kind: "full",
        reason: "first",
        lastFullAt: time("10:05:00"),
        nextFullAt: null,
        deletionsDeferred: false,
        skippedDatabases: 0,
      },
    });
    expect(queried()).toEqual([TASKS, NOTES]);
    expect(db.getMeta(LAST_FULL_PULL_META_KEY)).toBe(time("10:05:00"));
  });

  it("원격이 그대로면 DB 를 하나도 조회하지 않고 루트 아래도 훑지 않는다", async () => {
    const { orchestrator } = await synced();
    at("10:10:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({
      created: 0,
      updated: 0,
      deleted: 0,
      failed: [],
      remoteScan: {
        kind: "incremental",
        lastFullAt: time("10:05:00"),
        nextFullAt: time("11:05:00"),
        // 원격 삭제를 반영하는 설정이다 — 바뀐 것만 찾았으니 지운 것은 다음 전체 대조가 반영한다.
        deletionsDeferred: true,
        skippedDatabases: 2,
      },
    });
    expect(queried()).toEqual([]);
    expect(notion.client.getChildPagesRecursive).not.toHaveBeenCalled();
    expect(db.getMeta(LAST_FULL_PULL_META_KEY)).toBe(time("10:05:00"));
  });

  it("행 하나를 고치면 그 DB 만 조회해 받는다", async () => {
    const { orchestrator, r1 } = await synced();
    at("10:20:00");
    editBody(r1, "고친 본문");
    at("10:21:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({
      updated: 1,
      failed: [],
      remoteScan: { kind: "incremental", skippedDatabases: 1 },
    });
    expect(queried()).toEqual([TASKS]);
    expect(vault.read("Tasks/R1.md")).toContain("고친 본문");
  });

  it("받은 행이 그대로면 다시 조회하지 않는다 — 같은 분 안이라 확인하지 못한 행만 한 번 더 본다", async () => {
    const { orchestrator, r1 } = await synced();
    at("10:20:00");
    editBody(r1, "고친 본문");
    at("10:21:00");
    await orchestrator.pull();

    // 10:21 에 받았으니 10:20 분의 편집을 다 봤는지 모른다(N-05) — 한 번 더 조회해 견준다.
    vi.clearAllMocks();
    at("10:25:00");
    expect(await orchestrator.pull()).toMatchObject({ updated: 0, failed: [] });
    expect(queried()).toEqual([TASKS]);

    // 이제 가라앉았다. R1 은 조회 창(10:25 − 15분)에 아직 들지만 그대로라 조회하지 않는다.
    vi.clearAllMocks();
    at("10:30:00");
    expect(await orchestrator.pull()).toMatchObject({ updated: 0, failed: [] });
    expect(queried()).toEqual([]);
  });

  it("새 행은 그 DB 조회로 받는다 — 행마다 부모를 묻지 않는다", async () => {
    const { orchestrator } = await synced();
    at("10:20:00");
    const r3 = notion.add(TASKS, "R3", "새 행", {});
    at("10:21:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ created: 1, failed: [] });
    expect(queried()).toEqual([TASKS]);
    expect(vault.read("Tasks/R3.md")).toContain("새 행");
    expect(notion.client.getPage).not.toHaveBeenCalledWith(r3.id);
  });

  it("스키마를 고친 DB 는 행이 그대로여도 조회한다", async () => {
    const { orchestrator } = await synced();
    notion.client.searchRecentDataSources.mockResolvedValueOnce([
      { id: "ds-notes", last_edited_time: time("10:20:00"), databaseId: NOTES },
    ]);
    at("10:21:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ failed: [], remoteScan: { skippedDatabases: 1 } });
    expect(queried()).toEqual([NOTES]);
    // 행과 같은 조회 창으로 찾는다 — 지난 pull(10:05) − 안전창(15분).
    expect(notion.client.searchRecentDataSources).toHaveBeenCalledWith(time("09:50:00"), undefined);
  });

  it("원격에서 지운 행은 증분이 보지 못하고 다음 전체 대조가 지운다", async () => {
    const { orchestrator, r2 } = await synced();
    at("10:20:00");
    notion.edit(r2.id, (page) => {
      page.archived = true;
    });
    at("10:21:00");

    const between = await orchestrator.pull();
    expect(between).toMatchObject({ deleted: 0, remoteScan: { kind: "incremental" } });
    expect(vault.read("Tasks/R2.md")).toBeDefined();

    // 마지막 전체 대조(10:05)에서 주기(1시간)가 지났다.
    at("11:05:00");
    const due = await orchestrator.pull();

    expect(due).toMatchObject({
      deleted: 1,
      failed: [],
      remoteScan: { kind: "full", reason: "due", lastFullAt: time("11:05:00") },
    });
    expect(vault.read("Tasks/R2.md")).toBeUndefined();
    expect(queried()).toEqual([TASKS, NOTES]);
  });

  it("--force 는 주기 안이어도 전체 대조해 원격 삭제를 반영한다", async () => {
    const { orchestrator, r2 } = await synced();
    at("10:20:00");
    notion.edit(r2.id, (page) => {
      page.archived = true;
    });
    at("10:21:00");

    const result = await orchestrator.pull({ force: true });

    expect(result).toMatchObject({ deleted: 1, remoteScan: { kind: "full", reason: "forced" } });
    expect(db.getMeta(LAST_FULL_PULL_META_KEY)).toBe(time("10:21:00"));
  });

  it("주기를 0 으로 두면 pull 마다 전체 대조한다", async () => {
    const { orchestrator } = await synced({ fullReconcileInterval: 0 });
    at("10:10:00");

    const result = await orchestrator.pull();

    expect(result.remoteScan).toMatchObject({ kind: "full", reason: "every-pull" });
    expect(queried()).toEqual([TASKS, NOTES]);
  });

  it("조회하다 실패한 DB 는 대기로 남아, 다음 pull 이 바뀐 것이 없어도 다시 조회한다", async () => {
    const { orchestrator } = await synced();
    notion.client.searchRecentDataSources.mockResolvedValueOnce([
      { id: "ds-notes", last_edited_time: time("10:20:00"), databaseId: NOTES },
    ]);
    notion.client.queryAllDatabasePages.mockRejectedValueOnce(new Error("일시 오류"));
    at("10:21:00");

    const failedRun = await orchestrator.pull();

    expect(failedRun.failed).toEqual([
      expect.objectContaining({ path: "Notes", error: expect.stringContaining("일시 오류") }),
    ]);
    expect(pending()).toEqual(new Set([compact(NOTES)]));

    vi.clearAllMocks();
    at("10:40:00");
    const retried = await orchestrator.pull();

    expect(retried).toMatchObject({ failed: [] });
    expect(queried()).toEqual([NOTES]);
    expect(pending()).toEqual(new Set());

    vi.clearAllMocks();
    at("10:45:00");
    await orchestrator.pull();
    expect(queried()).toEqual([]);
  });

  it("이제 동기화하지 않는 DB 는 대기에서 뺀다 — 들고 있으면 대기가 영영 비지 않는다", async () => {
    const { orchestrator } = await synced();
    const dropped = "db000000-0000-4000-8000-0000000000d4";
    db.setMeta(PENDING_DATABASES_META_KEY, JSON.stringify([compact(dropped), compact(NOTES)]));
    at("10:10:00");

    await orchestrator.pull();

    expect(queried()).toEqual([NOTES]);
    expect(pending()).toEqual(new Set());
  });

  it.runIf(configured)(
    "설정한 DB 를 받다 예기치 않게 멈추면 이유를 실패로 싣는다 — 경고로만 남기면 pull 이 성공으로 끝난다",
    async () => {
      const { orchestrator } = await synced();
      vi.spyOn(DatabaseSyncer.prototype, "pullAll").mockRejectedValueOnce(
        new Error("상태 DB 잠김"),
      );
      at("10:10:00");

      const result = await orchestrator.pull({ force: true });

      expect(result.failed).toEqual([
        { path: "", operation: "update", error: "설정한 DB 를 받지 못함: 상태 DB 잠김" },
      ]);
    },
  );

  it("행 하나라도 받지 못한 DB 는 대기로 남는다 — 그 행의 수정 시각은 곧 조회 창 밖이다", async () => {
    const { orchestrator, r1 } = await synced();
    at("10:20:00");
    editBody(r1, "고친 본문");
    const read = notion.client.getPageMarkdown.getMockImplementation()!;
    notion.client.getPageMarkdown.mockImplementation(async (id: string) => {
      if (id === r1.id) throw new Error("본문 읽기 실패");
      return read(id);
    });
    at("10:21:00");

    const result = await orchestrator.pull();

    expect(result.failed).toEqual([
      expect.objectContaining({ path: `Tasks/${r1.id}`, error: "본문 읽기 실패" }),
    ]);
    expect(pending()).toEqual(new Set([compact(TASKS)]));
    expect(vault.read("Tasks/R1.md")).toContain("첫 본문");
  });

  it("원격을 훑다 취소하면 받은 것 없이 끝나고 기준 시각 · 전체 대조 시각을 옮기지 않는다", async () => {
    const orchestrator = build();
    notion.add(ROOT, "Page", "본문");
    notion.add(TASKS, "R1", "", {});
    const controller = new AbortController();
    const walk = notion.client.getChildPagesRecursive.getMockImplementation()!;
    notion.client.getChildPagesRecursive.mockImplementationOnce(async (rootId: string) => {
      controller.abort();
      return walk(rootId);
    });
    at("10:05:00");

    const result = await orchestrator.pull({ signal: controller.signal });

    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, failed: [] });
    expect(result.remoteScan).toBeUndefined();
    expect(queried()).toEqual([]);
    expect(vault.files.size).toBe(0);
    expect(db.getMeta("last_pull_at")).toBeNull();
    expect(db.getMeta(LAST_FULL_PULL_META_KEY)).toBeNull();
  });

  it("DB 를 받다 취소하면 닿지 못한 DB 를 대기로 남긴다", async () => {
    const { orchestrator, r1, n1 } = await synced();
    at("10:20:00");
    editBody(r1, "고친 R1");
    editBody(n1, "고친 N1");
    const controller = new AbortController();
    const query = notion.client.queryAllDatabasePages.getMockImplementation()!;
    notion.client.queryAllDatabasePages.mockImplementationOnce(async (...args: unknown[]) => {
      controller.abort();
      return query(...(args as Parameters<typeof query>));
    });
    at("10:21:00");

    await orchestrator.pull({ signal: controller.signal });

    expect(queried()).toEqual([TASKS]);
    expect(vault.read("Tasks/R1.md")).toContain("고친 R1");
    expect(pending()).toEqual(new Set([compact(NOTES)]));
    expect(db.getMeta(LAST_FULL_PULL_META_KEY)).toBe(time("10:05:00"));

    vi.clearAllMocks();
    at("10:40:00");
    await orchestrator.pull();
    expect(queried()).toContain(NOTES);
    expect(vault.read("Notes/N1.md")).toContain("고친 N1");
    expect(pending()).toEqual(new Set());
  });

  it("전체 대조하던 pull 을 DB 조회에서 취소하면 전체 대조를 마쳤다고 적지 않는다 — 다 훑지 못했다", async () => {
    const { orchestrator, r1, n1 } = await synced();
    at("10:20:00");
    editBody(r1, "고친 R1");
    editBody(n1, "고친 N1");
    const controller = new AbortController();
    const query = notion.client.queryAllDatabasePages.getMockImplementation()!;
    notion.client.queryAllDatabasePages.mockImplementationOnce(async (...args: unknown[]) => {
      controller.abort();
      return query(...(args as Parameters<typeof query>));
    });
    at("10:21:00");

    const result = await orchestrator.pull({ force: true, signal: controller.signal });

    expect(result.remoteScan).toMatchObject({ kind: "full", reason: "forced" });
    expect(queried()).toEqual([TASKS]);
    expect(pending()).toEqual(new Set([compact(NOTES)]));
    expect(db.getMeta(LAST_FULL_PULL_META_KEY)).toBe(time("10:05:00"));
  });

  it("원격 삭제를 확인하다 취소하면 남은 페이지를 묻지 않고 아무것도 지우지 않는다", async () => {
    const orchestrator = build();
    const first = notion.add(ROOT, "First", "하나");
    const second = notion.add(ROOT, "Second", "둘");
    at("10:05:00");
    await orchestrator.pull();
    at("10:10:00");
    for (const page of [first, second]) {
      notion.edit(page.id, (trashed) => {
        trashed.archived = true;
      });
    }
    const controller = new AbortController();
    const get = notion.client.getPage.getMockImplementation()!;
    vi.clearAllMocks();
    notion.client.getPage.mockImplementation(async (id: string) => {
      controller.abort();
      return get(id);
    });
    at("10:11:00");

    const result = await orchestrator.pull({ force: true, signal: controller.signal });

    expect(result).toMatchObject({ deleted: 0, failed: [] });
    expect(notion.client.getPage).toHaveBeenCalledTimes(1);
    expect(vault.read("First.md")).toContain("하나");
    expect(vault.read("Second.md")).toContain("둘");
    expect(db.getMeta(LAST_FULL_PULL_META_KEY)).toBe(time("10:05:00"));
  });

  it("바뀐 것을 찾다 취소하면 새 페이지의 부모를 묻지 않고 끝낸다", async () => {
    const { orchestrator } = await synced();
    at("10:20:00");
    notion.add(ROOT, "Fresh", "새 본문");
    const controller = new AbortController();
    const search = notion.client.searchRecentPages.getMockImplementation()!;
    notion.client.searchRecentPages.mockImplementationOnce(async (...args: unknown[]) => {
      controller.abort();
      return search(...(args as Parameters<typeof search>));
    });
    at("10:21:00");

    const result = await orchestrator.pull({ signal: controller.signal });

    expect(result).toMatchObject({ created: 0, failed: [] });
    expect(notion.client.getPage).not.toHaveBeenCalled();
    expect(vault.read("Fresh.md")).toBeUndefined();
    expect(db.getMeta("last_pull_at")).toBe(time("10:05:00"));
  });

  it("상태 확인은 주기가 됐어도 전체 대조하지 않고 고친 행을 원격 변경으로 보인다", async () => {
    const { orchestrator, r1 } = await synced();
    at("11:10:00");
    editBody(r1, "고친 본문");
    at("11:11:00");

    const status = await orchestrator.status();

    expect(status.remoteScan).toEqual({
      kind: "incremental",
      lastFullAt: time("10:05:00"),
      nextFullAt: null,
      deletionsDeferred: true,
    });
    expect(status.lastFullScanAt).toBe(time("10:05:00"));
    expect(status.remoteChanges).toEqual([
      expect.objectContaining({ pageId: r1.id, type: "modified", path: "Tasks/R1.md" }),
    ]);
    expect(notion.client.getChildPagesRecursive).not.toHaveBeenCalled();
    expect(notion.client.searchRecentDataSources).not.toHaveBeenCalled();
    expect(queried()).toEqual([]);
  });

  it("로컬 상태 확인도 마지막 전체 대조 시각을 싣는다 — 원격을 읽지 않고, 한 번도 없으면 null", async () => {
    expect((await build().statusLocal()).lastFullScanAt).toBeNull();

    const { orchestrator } = await synced();
    at("10:30:00");
    const status = await orchestrator.statusLocal();

    expect(status.lastFullScanAt).toBe(time("10:05:00"));
    expect(status.remoteScan).toBeUndefined();
    expect(notion.client.searchRecentPages).not.toHaveBeenCalled();
  });

  it("경로를 좁힌 pull 은 주기가 됐어도 전체 대조를 마쳤다고 적지 않고 대기도 건드리지 않는다", async () => {
    const { orchestrator, r1 } = await synced();
    db.setMeta(PENDING_DATABASES_META_KEY, JSON.stringify([compact(NOTES)]));
    at("11:10:00");
    editBody(r1, "고친 본문");
    at("11:11:00");

    const result = await orchestrator.pull({ paths: ["Tasks"] });

    expect(result).toMatchObject({ updated: 1, remoteScan: { kind: "incremental" } });
    expect(queried()).toEqual([TASKS]);
    expect(db.getMeta(LAST_FULL_PULL_META_KEY)).toBe(time("10:05:00"));
    expect(db.getMeta("last_pull_at")).toBe(time("10:05:00"));
    expect(pending()).toEqual(new Set([compact(NOTES)]));
  });

  it("경로를 좁힌 pull 은 바뀐 것이 보이지 않아도 범위에 닿는 DB 를 조회한다 — search 가 늦게 색인한 행도 받는다", async () => {
    const { orchestrator, r1 } = await synced();
    at("10:20:00");
    editBody(r1, "고친 본문");
    // search 가 아직 색인하지 못했다 — 고친 행이 결과에 없다.
    notion.client.searchRecentPages.mockResolvedValueOnce([]);
    at("10:21:00");

    const result = await orchestrator.pull({ paths: ["Tasks"] });

    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect(queried()).toEqual([TASKS]);
    expect(vault.read("Tasks/R1.md")).toContain("고친 본문");
  });

  it("dry-run 은 실제 pull 이 조회할 DB 만 세고 아무것도 적지 않는다", async () => {
    const { orchestrator, r1 } = await synced();
    at("10:20:00");
    editBody(r1, "고친 본문");
    at("10:21:00");

    const plan = await orchestrator.pull({ dryRun: true });

    expect(plan).toMatchObject({
      updated: 1,
      failed: [],
      remoteScan: { kind: "incremental", skippedDatabases: 1 },
    });
    expect(queried()).toEqual([TASKS]);
    expect(vault.read("Tasks/R1.md")).toContain("첫 본문");
    expect(db.getMeta("last_pull_at")).toBe(time("10:05:00"));
    expect(db.getMeta(PENDING_DATABASES_META_KEY)).toBeNull();
  });

  it("deleteSync 가 꺼져 있으면 볼트에서 지운 행을 그 DB 만 조회해 되살린다", async () => {
    const { orchestrator } = await synced({ deleteSync: false });
    vault.files.delete("Tasks/R1.md");
    at("10:10:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ restored: 1, failed: [] });
    expect(queried()).toEqual([TASKS]);
    expect(vault.read("Tasks/R1.md")).toContain("첫 본문");
    // 원격 삭제를 볼트에 반영하지 않는 설정이다 — 바뀐 것만 찾았어도 미룬 삭제는 없다.
    expect(result.remoteScan).toMatchObject({ kind: "incremental", deletionsDeferred: false });
  });

  it("deleteSync 가 켜져 있으면 볼트에서 지운 행 때문에 DB 를 조회하지 않는다 — 지운 것은 push 가 올린다", async () => {
    const { orchestrator } = await synced();
    vault.files.delete("Tasks/R1.md");
    at("10:10:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ restored: 0, failed: [] });
    expect(queried()).toEqual([]);
    expect(vault.read("Tasks/R1.md")).toBeUndefined();
  });
});

describe("빠른 변경 감지 — 새로 발견한 DB", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  const FOUND = "db000000-0000-4000-8000-0000000000c3";

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-fast-found-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseViewsConfig.mockImplementation(async (databaseId: string) => ({
      databaseId,
      lastSynced: "",
      views: [],
    }));
    notion.client.searchRecentPages.mockImplementation(async (since: string) =>
      [...notion.pages.values()]
        .filter((page) => !page.archived && Date.parse(page.lastEdited) > Date.parse(since))
        .map((page) => ({
          id: page.id,
          last_edited_time: page.lastEdited,
          last_edited_by: { id: page.lastEditedBy },
          parentDatabaseId: page.parentType === "database" ? page.parent : null,
        })),
    );
    db.setMeta("discovered_dbs", JSON.stringify([DATABASES[0]]));
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const build = () =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, parentMode: "page", databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
  const pending = () => parsePendingDatabases(db.getMeta(PENDING_DATABASES_META_KEY));
  const inlineDb = (id: string, title: string) =>
    `<database url="https://www.notion.so/${compact(id)}" inline="true">${title}</database>`;

  it("증분 pull 이 새 페이지에서 발견한 DB 는 바뀐 것이 보이지 않아도 조회한다 — 받은 적이 없다", async () => {
    const orchestrator = build();
    notion.add(TASKS, "R1", "", {});
    at("10:05:00");
    await orchestrator.pull();

    // 발견한 DB 의 행은 조회 창(기준 시각 − 15분) 밖에서 만들어졌다 — search 로는 그 DB 가 바뀐 것이
    // 보이지 않는다. 기준 시각을 옮기는 pull 을 한 번 더 돌려 창을 지나게 한다.
    notion.add(FOUND, "F1", "", {});
    at("10:30:00");
    await orchestrator.pull();
    at("10:40:00");
    notion.add(ROOT, "Hub", inlineDb(FOUND, "Found"));
    notion.client.getDatabaseSyncability.mockResolvedValue({ title: "Found", queryable: true });
    vi.clearAllMocks();
    at("10:41:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ failed: [], remoteScan: { kind: "incremental" } });
    expect(notion.client.queryAllDatabasePages.mock.calls.map(([id]) => id)).toEqual([FOUND]);
    expect([...vault.files.keys()].some((path) => path.endsWith("/F1.md"))).toBe(true);
  });

  it("중첩 DB 발견 라운드 한도에 걸린 DB 는 대기로 남아 다음 pull 이 받는다 — 바뀐 것이 보이지 않아도", async () => {
    // 행 본문에 DB 가 한 층씩 들어 있다 — TASKS 행 → B 행 → C 행 → D 행 → E. 한 pull 은 네 라운드까지만 판다.
    const [B, C, D, E] = ["b", "c", "d", "e"].map(
      (tail) => `db000000-0000-4000-8000-00000000000${tail}`,
    );
    const chain = [TASKS, B, C, D, E];
    chain.forEach((dbId, level) => {
      const next = chain[level + 1];
      notion.add(dbId, `L${level}`, next ? inlineDb(next, `DB${level + 1}`) : "맨 아래", {});
    });
    notion.client.getDatabaseSyncability.mockImplementation(async (id: string) => ({
      title: `DB ${compact(id).slice(-1)}`,
      queryable: true,
    }));
    const orchestrator = build();
    at("10:05:00");

    await orchestrator.pull();

    expect(notion.client.queryAllDatabasePages.mock.calls.map(([id]) => id)).toEqual([
      TASKS,
      B,
      C,
      D,
    ]);
    expect(pending()).toEqual(new Set([compact(E)]));
    expect([...vault.files.keys()].some((path) => path.endsWith("/L4.md"))).toBe(false);

    // 다음 pull 은 증분이다 — E 의 행은 조회 창에 들지만, 대기가 없으면 E 는 새로 등록한 DB 도 아니다.
    vi.clearAllMocks();
    notion.client.searchRecentPages.mockResolvedValueOnce([]);
    at("10:30:00");
    const next = await orchestrator.pull();

    expect(next).toMatchObject({ failed: [], remoteScan: { kind: "incremental" } });
    expect(notion.client.queryAllDatabasePages.mock.calls.map(([id]) => id)).toEqual([E]);
    expect([...vault.files.keys()].some((path) => path.endsWith("/L4.md"))).toBe(true);
    expect(pending()).toEqual(new Set());
  });
});
