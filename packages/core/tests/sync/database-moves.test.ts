/**
 * ADR-047 — 볼트에서 옮기거나 이름을 바꾼 DB 폴더를 Notion 의 DB 에도 반영한다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DB_MOVES_META_KEY,
  DatabaseMover,
  loadDatabaseMoves,
  recordDatabaseMoves,
  type DatabaseMoveTarget,
} from "../../src/sync/database-moves.js";
import type { IStateDB } from "../../src/state/state-db-interface.js";
import type { FailedOperation } from "../../src/types/sync.js";
import { PENDING_DATABASES_META_KEY } from "../../src/sync/remote-scan.js";

const ROOT = "root0000000000000000000000000000";
const DB = "dbdb0000000000000000000000000001";
const PAGE_A = "aaaa0000000000000000000000000001";
const PAGE_B = "bbbb0000000000000000000000000001";
const ELSEWHERE = "eeee0000000000000000000000000001";

function memoryState(tracked: string[] = []): IStateDB {
  const meta = new Map<string, string>();
  return {
    getMeta: (key: string) => meta.get(key) ?? null,
    setMeta: (key: string, value: string) => void meta.set(key, value),
    getByNotionId: (id: string) => (tracked.includes(id) ? { notionPageId: id } : null),
  } as unknown as IStateDB;
}

describe("recordDatabaseMoves", () => {
  it("반영하지 못한 이동의 출발 폴더를 지키고, 그 자리로 돌아오면 지운다", () => {
    const state = memoryState();
    recordDatabaseMoves(state, [{ databaseId: DB, from: "A/T", to: "B/T" }]);
    recordDatabaseMoves(state, [{ databaseId: DB, from: "B/T", to: "C/T" }]);
    expect(loadDatabaseMoves(state)).toEqual([{ databaseId: DB, from: "A/T", to: "C/T" }]);

    recordDatabaseMoves(state, [{ databaseId: DB, from: "C/T", to: "A/T" }]);
    expect(loadDatabaseMoves(state)).toEqual([]);
  });

  it("깨진 메타는 빈 목록이다", () => {
    const state = memoryState();
    state.setMeta(DB_MOVES_META_KEY, "{not json");
    expect(loadDatabaseMoves(state)).toEqual([]);
  });
});

describe("DatabaseMover", () => {
  let client: {
    getDatabasePlacement: ReturnType<typeof vi.fn>;
    updateDatabasePlacement: ReturnType<typeof vi.fn>;
  };
  let databaseAt: Map<string, string>;
  let pages: Map<string, string>;
  let target: DatabaseMoveTarget;

  beforeEach(() => {
    client = {
      getDatabasePlacement: vi.fn(async () => ({
        parentType: "page_id",
        pageId: PAGE_A,
        title: "T",
      })),
      updateDatabasePlacement: vi.fn(async () => undefined),
    };
    databaseAt = new Map();
    pages = new Map([
      ["A", PAGE_A],
      ["B", PAGE_B],
    ]);
    target = {
      rootPageId: ROOT,
      ensureFolderPage: vi.fn(async (folder: string) => {
        if (!pages.has(folder) && folder !== "Rows") pages.set(folder, `new-${folder}`);
      }),
      folderLookup: () => ({
        databaseAt: (folder) => databaseAt.get(folder) ?? null,
        pageIdAt: (path) => pages.get(path) ?? null,
      }),
      folderMoveRefusal: (folder) =>
        folder.startsWith("Rows/") ? "폴더를 DB 폴더(Rows) 안으로 옮기지 않음" : null,
    };
  });

  function mover(state: IStateDB, from: string, to: string): DatabaseMover {
    databaseAt.set(to, DB);
    recordDatabaseMoves(state, [{ databaseId: DB, from, to }]);
    return new DatabaseMover(state, client, target);
  }

  it("새 부모 폴더의 페이지 아래로 옮기고 다음 pull 이 그 DB 를 다시 받게 한다", async () => {
    const state = memoryState([PAGE_A]);
    const failed: FailedOperation[] = [];

    const applied = await mover(state, "A/T", "B/T").apply(() => true, failed);

    expect(failed).toEqual([]);
    expect(applied).toEqual([{ from: "A/T", to: "B/T", inNotion: true }]);
    expect(client.updateDatabasePlacement).toHaveBeenCalledWith(DB, { parentPageId: PAGE_B });
    expect(loadDatabaseMoves(state)).toEqual([]);
    expect(state.getMeta(PENDING_DATABASES_META_KEY)).toContain(DB);
  });

  it("폴더 이름을 바꾸면 DB 제목도 — 제목이 폴더 이름을 따르던 때만", async () => {
    const state = memoryState([PAGE_A]);
    await mover(state, "A/T", "A/U").apply(() => true, []);
    expect(client.updateDatabasePlacement).toHaveBeenCalledWith(DB, { title: "U" });

    client.updateDatabasePlacement.mockClear();
    client.getDatabasePlacement.mockResolvedValueOnce({
      parentType: "page_id",
      pageId: PAGE_A,
      title: "다른 제목",
    });
    await mover(state, "A/U", "A/V").apply(() => true, []);
    expect(client.updateDatabasePlacement).not.toHaveBeenCalled();
  });

  it("맨 위 · databases 선반으로 옮기면 루트 아래로", async () => {
    const state = memoryState([PAGE_A]);
    await mover(state, "A/T", "databases/T").apply(() => true, []);
    expect(client.updateDatabasePlacement).toHaveBeenCalledWith(DB, { parentPageId: ROOT });
  });

  it("볼트가 받지 않는 곳(추적하지 않는 페이지 · 블록 안)의 DB 는 Notion 에서 옮기지 않는다", async () => {
    const state = memoryState([PAGE_A]);
    client.getDatabasePlacement.mockResolvedValueOnce({
      parentType: "page_id",
      pageId: ELSEWHERE,
      title: "T",
    });
    const first = await mover(state, "databases/T", "B/T").apply(() => true, []);
    expect(first).toEqual([{ from: "databases/T", to: "B/T", inNotion: false }]);

    client.getDatabasePlacement.mockResolvedValueOnce({
      parentType: "block_id",
      pageId: null,
      title: "T",
    });
    await mover(state, "B/T", "A/T").apply(() => true, []);
    expect(client.updateDatabasePlacement).not.toHaveBeenCalled();
    expect(loadDatabaseMoves(state)).toEqual([]);
  });

  it("DB 폴더 안으로는 옮기지 않고 까닭을 남긴다 — 다음 push 가 다시 본다", async () => {
    const state = memoryState([PAGE_A]);
    const failed: FailedOperation[] = [];
    await mover(state, "A/T", "Rows/T").apply(() => true, failed);
    expect(failed).toEqual([
      expect.objectContaining({
        path: "Rows/T",
        operation: "move",
        error: expect.stringContaining("DB 폴더"),
      }),
    ]);
    expect(loadDatabaseMoves(state)).toHaveLength(1);
  });

  it("요청이 실패하면 남겨 두고 다음 push 가 마저 옮긴다 · 범위 밖은 두고 · 그 사이 놓은 DB 는 버린다", async () => {
    const state = memoryState([PAGE_A]);
    client.updateDatabasePlacement.mockRejectedValueOnce(new Error("502"));
    const m = mover(state, "A/T", "B/T");
    const failed: FailedOperation[] = [];
    await m.apply(() => true, failed);
    expect(failed).toHaveLength(1);
    expect(loadDatabaseMoves(state)).toHaveLength(1);

    expect(await m.apply((folder) => folder.startsWith("A/"), [])).toEqual([]);
    expect(loadDatabaseMoves(state)).toHaveLength(1);

    await m.apply(() => true, []);
    expect(loadDatabaseMoves(state)).toEqual([]);

    databaseAt.clear();
    recordDatabaseMoves(state, [{ databaseId: DB, from: "B/T", to: "C/T" }]);
    expect(await m.apply(() => true, [])).toEqual([]);
    expect(loadDatabaseMoves(state)).toEqual([]);
  });
});
