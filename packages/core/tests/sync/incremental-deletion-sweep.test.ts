/**
 * 증분 pull 의 삭제 확인(P2) — Notion 은 지운 것을 목록으로 주지 않는다.
 *
 * search 는 휴지통 페이지를 돌려주지 않고 거르지도 못한다(`in_trash` 400, 실측 2026-10-28). 그래서 증분 pull 은
 * 삭제를 보지 못했고, 다른 볼트에는 전체 대조(기본 1시간)가 돌 때까지 지운 노트가 남았다. 조회 필터를 단 DB 의
 * 행은 전체 대조도 가르지 않아 영영 남았다.
 *
 * 고친 뒤: pull 마다 추적 중인 페이지 · 행을 차례로 몇 개씩 원격에 묻는다. 지워진 페이지 아래는 함께 묻는다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { DatabaseSyncConfig } from "../../src/types/config.js";
import {
  DELETION_SWEEP_BUDGET,
  DELETION_SWEEP_CURSOR_META_KEY,
} from "../../src/sync/deletion-sweep.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000a1";

describe("증분 pull 의 삭제 확인", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  /** 플러그인과 같다 — deleteSync 켬 · 전체 대조는 한 시간마다(기본값). */
  const build = (
    sync: Partial<typeof DEFAULT_CONFIG.sync> = {},
    databases: DatabaseSyncConfig[] = [],
  ): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true, ...sync },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
  /** Notion 에서 사람이 휴지통에 넣는다. */
  const trash = (...ids: string[]): void => {
    for (const id of ids) {
      notion.edit(id, (page) => {
        page.archived = true;
      });
    }
  };
  const pathOf = (id: string): string => db.getByNotionId(id)!.obsidianPath;
  /**
   * 지난 pull 뒤 아무것도 고치지 않은 워크스페이스 — 메모리 search 는 기준 시각을 보지 않고 살아 있는 페이지를
   * 모두 돌려준다. 그대로면 살아 있다고 본 것은 묻지 않아 차례가 보이지 않는다.
   */
  const quietSearch = (): void => {
    notion.client.searchRecentPages.mockResolvedValue([]);
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-deletion-sweep-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("Notion 휴지통에 넣은 페이지를 다음 증분 pull 이 지운다", async () => {
    const orchestrator = build();
    const gone = notion.add("root-page-id", "지울 노트", "본문");
    notion.add("root-page-id", "남길 노트", "본문");
    expect(await orchestrator.pull()).toMatchObject({ created: 2, failed: [] });
    const path = pathOf(gone.id);

    trash(gone.id);
    const result = await orchestrator.pull();

    expect(result.remoteScan).toMatchObject({ kind: "incremental" });
    expect(result).toMatchObject({ deleted: 1, failed: [] });
    expect(vault.read(path)).toBeUndefined();
    expect(db.getByNotionId(gone.id)).toBeNull();
    expect(vault.read("남길 노트.md")).toBeDefined();
  });

  it("큰 볼트는 pull 마다 몇 개씩 차례로 묻고 다음 pull 이 이어서 묻는다", async () => {
    const orchestrator = build();
    const notes = Array.from({ length: DELETION_SWEEP_BUDGET + 5 }, (_, i) =>
      notion.add("root-page-id", `노트 ${String(i).padStart(2, "0")}`, "본문"),
    );
    await orchestrator.pull();
    const last = notes[notes.length - 1]!;
    const path = pathOf(last.id);
    trash(last.id);

    quietSearch();
    notion.client.getPage.mockClear();
    // 다 묻지 못했다 — 화면이 「Notion 에서 지운 것은 다음 전체 대조 때」 라고 알린다.
    expect(await orchestrator.pull()).toMatchObject({
      deleted: 0,
      remoteScan: { kind: "incremental", deletionsDeferred: true },
    });
    // 묻는 수는 예산만큼이다 — 증분이 전체 대조만큼 비싸지지 않게.
    expect(notion.client.getPage.mock.calls.length).toBeLessThanOrEqual(DELETION_SWEEP_BUDGET);
    expect(vault.read(path)).toBeDefined();

    expect(await orchestrator.pull()).toMatchObject({ deleted: 1 });
    expect(vault.read(path)).toBeUndefined();
  });

  it("폴더 페이지를 지우면 그 아래 노트도 같은 pull 이 지운다", async () => {
    const orchestrator = build();
    const parent = notion.add("root-page-id", "상위", "본문");
    for (let i = 0; i < DELETION_SWEEP_BUDGET; i++) notion.add("root-page-id", `채움 ${i}`, "");
    const child = notion.add(parent.id, "하위", "본문");
    const grandchild = notion.add(child.id, "손자", "본문");
    await orchestrator.pull();
    const paths = [parent, child, grandchild].map((page) => pathOf(page.id));

    // Notion 은 부모를 휴지통에 넣으면 그 아래도 휴지통이다(실측 2026-10-28).
    trash(parent.id, child.id, grandchild.id);
    quietSearch();
    expect(await orchestrator.pull()).toMatchObject({ deleted: 3, failed: [] });
    for (const path of paths) expect(vault.read(path)).toBeUndefined();
  });

  it("조회 필터를 단 DB 의 휴지통 행을 지운다 — 전체 대조에서도", async () => {
    const rowsDb: DatabaseSyncConfig = {
      databaseId: DB_ID,
      localFolder: "Tasks",
      titleProperty: "Name",
      pullFilter: { property: "Name", title: { equals: "할 일" } },
    };
    const orchestrator = build({ fullReconcileInterval: 0 }, [rowsDb]);
    const row = notion.add(DB_ID, "할 일", "", { properties: {} });
    await orchestrator.pull();
    const path = pathOf(row.id);
    expect(vault.read(path)).toBeDefined();

    trash(row.id);
    const result = await orchestrator.pull();

    expect(result.remoteScan).toMatchObject({ kind: "full" });
    expect(result).toMatchObject({ deleted: 1, failed: [] });
    expect(vault.read(path)).toBeUndefined();
  });

  it("살아 있는 노트는 지우지 않고, dry-run 은 차례를 옮기지 않는다", async () => {
    const orchestrator = build();
    notion.add("root-page-id", "그대로", "본문");
    await orchestrator.pull();
    const cursor = db.getMeta(DELETION_SWEEP_CURSOR_META_KEY);

    expect(await orchestrator.pull({ dryRun: true })).toMatchObject({ deleted: 0 });
    expect(await orchestrator.pull()).toMatchObject({ deleted: 0 });
    expect(vault.read("그대로.md")).toBeDefined();
    expect(db.getMeta(DELETION_SWEEP_CURSOR_META_KEY)).not.toBe(cursor);

    const saved = db.getMeta(DELETION_SWEEP_CURSOR_META_KEY);
    await orchestrator.pull({ dryRun: true });
    expect(db.getMeta(DELETION_SWEEP_CURSOR_META_KEY)).toBe(saved);
  });

  it("deleteSync 가 꺼져 있으면 묻지도 지우지도 않는다", async () => {
    const orchestrator = build({ deleteSync: false });
    const gone = notion.add("root-page-id", "지울 노트", "본문");
    await orchestrator.pull();
    trash(gone.id);

    notion.client.getPage.mockClear();
    expect(await orchestrator.pull()).toMatchObject({ deleted: 0 });
    expect(notion.client.getPage).not.toHaveBeenCalled();
    expect(vault.read("지울 노트.md")).toBeDefined();
  });
});
