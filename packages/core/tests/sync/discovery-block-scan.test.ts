/**
 * 하위 DB 블록 스캔은 처음 한 번만 — DB 가 하나도 없는 볼트도 pull 마다 다시 훑지 않는다.
 *
 * 블록 스캔은 추적 페이지마다 요청 1회다(초당 3회 — 페이지 300개면 100초). 예전에는 «발견한 DB 캐시가
 * 비었는가» 로 스캔을 가려, DB 가 없는 볼트는 원격이 그대로여도 pull 마다 모든 페이지를 다시 훑었다.
 * 스캔 뒤에 생긴 DB 는 받은 페이지의 본문(`<database>` 태그)으로 찾고, `--force` 는 다시 훑는다.
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

const DAY = "2026-09-28";
const ROOT = "root-page-id";
const FOUND = "db000000-0000-4000-8000-0000000000c3";

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("하위 DB 블록 스캔은 처음 한 번만", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-block-scan-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseViewsConfig.mockImplementation(async (databaseId: string) => ({
      databaseId,
      lastSynced: "",
      views: [],
    }));
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, parentMode: "page", databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
    notion.add(ROOT, "A", "a 본문");
    notion.add(ROOT, "B", "b 본문");
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const scanned = () => notion.client.getChildDatabaseIds.mock.calls.length;

  it("DB 가 하나도 없어도 처음 한 번만 훑는다", async () => {
    at("10:05:00");
    expect(await orchestrator.pull()).toMatchObject({ created: 2, failed: [] });
    expect(scanned()).toBe(3);

    vi.clearAllMocks();
    at("10:10:00");
    expect(await orchestrator.pull()).toMatchObject({ failed: [] });
    expect(scanned()).toBe(0);
  });

  it("--force 는 다시 훑는다", async () => {
    at("10:05:00");
    await orchestrator.pull();

    vi.clearAllMocks();
    at("10:10:00");
    await orchestrator.pull({ force: true });
    expect(scanned()).toBe(3);
  });

  it("취소해서 훑지 못했으면 다음 pull 이 훑는다", async () => {
    const controller = new AbortController();
    const read = notion.client.getPageMarkdown.getMockImplementation()!;
    notion.client.getPageMarkdown.mockImplementation(async (id: string) => {
      controller.abort();
      return read(id);
    });
    at("10:05:00");
    await orchestrator.pull({ signal: controller.signal });
    expect(scanned()).toBe(0);

    notion.client.getPageMarkdown.mockImplementation(read);
    at("10:10:00");
    await orchestrator.pull();
    expect(notion.client.getChildDatabaseIds).toHaveBeenCalledWith(ROOT);
  });

  it("훑은 뒤에 생긴 DB 는 받은 페이지의 본문으로 찾는다 — 다시 훑지 않고", async () => {
    at("10:05:00");
    await orchestrator.pull();

    at("10:20:00");
    notion.add(FOUND, "F1", "", {});
    notion.add(
      ROOT,
      "Hub",
      `<database url="https://www.notion.so/${FOUND.replace(/-/g, "")}" inline="true">Found</database>`,
    );
    notion.client.getDatabaseSyncability.mockResolvedValue({ title: "Found", queryable: true });
    vi.clearAllMocks();
    at("10:21:00");

    const result = await orchestrator.pull();

    expect(result).toMatchObject({ failed: [] });
    expect(scanned()).toBe(0);
    expect([...vault.files.keys()].some((path) => path.endsWith("/F1.md"))).toBe(true);
  });
});
