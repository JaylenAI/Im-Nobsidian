/**
 * DB 마다 실제로 기록한 `.base` — 상태 DB 에 남아 다음 실행도 읽는다 (ADR-027).
 *
 * 바뀐 DB 만 조회하면 이번에 조회하지 않은 DB 의 `.base` 경로를 이번 실행은 모른다. 모르면 인라인 DB
 * 자리표시를 폴더로 추측한 경로로 바꿔 깨진 임베드가 된다(F22).
 */
import { describe, it, expect, vi } from "vitest";
import { DB_BASE_FILES_META_KEY, DbBaseFiles } from "../../src/sync/db-base-files.js";

const DB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPACT = DB_ID.replace(/-/g, "");
const INFO = { basePath: "Projects/Tasks v2/Tasks v2.base", title: "Tasks v2" };

/** 메타 한 칸만 가진 상태 DB. */
function memoryMeta(initial: Record<string, string> = {}) {
  const meta = new Map(Object.entries(initial));
  return {
    meta,
    getMeta: vi.fn((key: string) => meta.get(key) ?? null),
    setMeta: vi.fn((key: string, value: string) => void meta.set(key, value)),
  };
}

describe("DbBaseFiles", () => {
  it("적은 것을 다음 실행이 읽는다 — id 의 하이픈과 무관하게", () => {
    const store = memoryMeta();
    new DbBaseFiles(store).set(DB_ID, INFO);

    const next = new DbBaseFiles(store);
    expect(next.get(COMPACT)).toEqual(INFO);
    expect(next.get(DB_ID.toUpperCase())).toEqual(INFO);
  });

  it("값이 그대로면 다시 쓰지 않는다 — 전체 대조는 DB 마다 부른다", () => {
    const store = memoryMeta();
    const files = new DbBaseFiles(store);
    files.set(DB_ID, INFO);
    files.set(COMPACT, { ...INFO });
    expect(store.setMeta).toHaveBeenCalledTimes(1);

    files.set(DB_ID, { ...INFO, title: "Tasks v3" });
    expect(store.setMeta).toHaveBeenCalledTimes(2);
    expect(new DbBaseFiles(store).get(DB_ID)).toEqual({ ...INFO, title: "Tasks v3" });
  });

  it("상태 메타는 처음 한 번만 읽는다", () => {
    const store = memoryMeta();
    const files = new DbBaseFiles(store);
    files.get(DB_ID);
    files.get(DB_ID);
    files.set(DB_ID, INFO);
    expect(store.getMeta).toHaveBeenCalledTimes(1);
  });

  it.each(["not json", "[]", "null", "42"])(
    "깨진 값(%s)은 빈 것으로 읽고 이번에 적는 것부터 다시 쌓는다",
    (raw) => {
      const store = memoryMeta({ [DB_BASE_FILES_META_KEY]: raw });
      const files = new DbBaseFiles(store);
      expect(files.get(DB_ID)).toBeUndefined();

      files.set(DB_ID, INFO);
      expect(JSON.parse(store.meta.get(DB_BASE_FILES_META_KEY)!)).toEqual({ [COMPACT]: INFO });
    },
  );

  it("모양이 틀린 항목만 버리고 나머지는 읽는다", () => {
    const store = memoryMeta({
      [DB_BASE_FILES_META_KEY]: JSON.stringify({
        [DB_ID]: INFO,
        bad1: { basePath: 1, title: "x" },
        bad2: null,
        bad3: { basePath: "a.base" },
      }),
    });
    const files = new DbBaseFiles(store);
    expect(files.get(COMPACT)).toEqual(INFO);
    expect(files.get("bad1")).toBeUndefined();
    expect(files.get("bad2")).toBeUndefined();
    expect(files.get("bad3")).toBeUndefined();
  });

  it("적는 값에 딸린 다른 필드는 남기지 않는다", () => {
    const store = memoryMeta();
    new DbBaseFiles(store).set(DB_ID, { ...INFO, extra: "x" } as typeof INFO);
    expect(JSON.parse(store.meta.get(DB_BASE_FILES_META_KEY)!)).toEqual({ [COMPACT]: INFO });
  });
});
