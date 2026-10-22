/**
 * 실제 pull 이 DB 행도 진행 항목으로 알린다 — 페이지와 한 목록 · 한 수로.
 *
 * 예전에는 페이지만 알렸다. 행은 DB 를 조회해야 몇 개인지 알아 진행 수(전체)에 넣지 않았고 항목도
 * 알리지 않았다 — 행이 대부분인 볼트(실측 887 파일 중 629 가 행)는 pull 내내 진행 표시가 멈춰
 * 보였고, dry-run 이 보인 행 목록을 실제 pull 은 하나도 보이지 않았다.
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
import type { ProgressItem } from "../../src/types/sync.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";
const ROOT = "root-page-id";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000a1";
const FOUND_DB_ID = "db000000-0000-4000-8000-0000000000f1";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("실제 pull 이 DB 행도 진행 항목으로 알린다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-row-progress-"));
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

  const build = (databases: DatabaseSyncConfig[] = [ROW_DB]): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, parentMode: "page", databases },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  /** 진행 콜백이 받은 항목과 (현재, 전체). */
  function collect() {
    const items: ProgressItem[] = [];
    const counts: Array<[number, number]> = [];
    return {
      items,
      counts,
      onProgress: (current: number, total: number, item: ProgressItem) => {
        items.push(item);
        counts.push([current, total]);
      },
    };
  }
  const shown = (items: readonly ProgressItem[]) =>
    items.map((item) => `${item.operation} ${item.path}`).sort();

  /** 현재 수는 하나씩 오르고 전체를 넘지 않는다. 전체는 행을 조회한 뒤 늘 수는 있어도 줄지 않는다. */
  function expectSteady(counts: ReadonlyArray<[number, number]>): void {
    counts.forEach(([current, total], index) => {
      expect(current).toBe(index + 1);
      expect(current).toBeLessThanOrEqual(total);
      if (index > 0) expect(total).toBeGreaterThanOrEqual(counts[index - 1]![1]);
    });
    const [current, total] = counts.at(-1)!;
    expect(current).toBe(total);
  }

  it("페이지와 설정 DB 의 행을 한 목록 · 한 수로 알린다 — dry-run 이 보인 행과 같다", async () => {
    notion.add(ROOT, "Page", "본문");
    notion.add(ROW_DB_ID, "R1", "", {});
    notion.add(ROW_DB_ID, "R2", "", {});
    at("10:00:20");
    const orchestrator = build();

    const dry = collect();
    await orchestrator.pull({ dryRun: true, onProgress: dry.onProgress });
    const real = collect();
    const result = await orchestrator.pull({ onProgress: real.onProgress });

    expect(result).toMatchObject({ created: 3, failed: [] });
    expect(shown(real.items)).toEqual([
      "create Page.md",
      "create Tasks/R1.md",
      "create Tasks/R2.md",
    ]);
    // 새 페이지는 받기 전에는 자리를 몰라 dry-run 이 Notion 제목으로 보인다 — 내부 id 가 아니다.
    expect(shown(dry.items)).toEqual(["create Page", "create Tasks/R1.md", "create Tasks/R2.md"]);
    expectSteady(real.counts);
  });

  it("페이지 변경이 없어도 받은 행 · 지운 행을 알린다", async () => {
    const orchestrator = build();
    const r1 = notion.add(ROW_DB_ID, "R1", "", {});
    const r2 = notion.add(ROW_DB_ID, "R2", "", {});
    at("10:00:20");
    expect(await orchestrator.pull()).toMatchObject({ created: 2, failed: [] });

    at("10:05:00");
    notion.edit(r1.id, (page) => {
      page.body = "고친 본문";
    });
    notion.edit(r2.id, (page) => {
      page.archived = true;
    });
    at("10:06:00");
    const run = collect();
    const result = await orchestrator.pull({ onProgress: run.onProgress });

    expect(result).toMatchObject({ updated: 1, deleted: 1, failed: [] });
    expect(shown(run.items)).toEqual(["delete Tasks/R2.md", "update Tasks/R1.md"]);
    expectSteady(run.counts);
  });

  it.each([
    { pages: [], expected: ["create Found/R9.md"] },
    { pages: ["Page"], expected: ["create Found/R9.md", "create Page.md"] },
  ])("발견한 DB 의 행도 알린다 — 받을 페이지 $pages", async ({ pages, expected }) => {
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: FOUND_DB_ID, localFolder: "Found", titleProperty: "Name" }]),
    );
    for (const title of pages) notion.add(ROOT, title, "본문");
    notion.add(FOUND_DB_ID, "R9", "", {});
    at("10:00:20");
    const run = collect();

    const result = await build([]).pull({ onProgress: run.onProgress });

    expect(result).toMatchObject({ created: expected.length, failed: [] });
    expect(shown(run.items)).toEqual(expected);
    expectSteady(run.counts);
  });

  it("sync 는 행에도 받기를 적는다", async () => {
    notion.add(ROW_DB_ID, "R1", "", {});
    at("10:00:20");
    const run = collect();

    await build().sync({ onProgress: run.onProgress });

    expect(run.items).toContainEqual({
      path: "Tasks/R1.md",
      operation: "create",
      direction: "pull",
    });
  });
});
