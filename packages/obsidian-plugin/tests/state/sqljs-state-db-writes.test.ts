/**
 * 상태 DB 를 파일에 쓰는 일 — 플러그인은 DB 를 메모리에 두고, 바뀌면 파일에 통째로 쓴다. 쓰는 사이에 바뀐 것 ·
 * 겹친 쓰기 · 닫을 때 남은 쓰기 · 못 쓴 쓰기가 파일에 가는지 실제 sql.js 로 본다.
 *
 * 격리 Obsidian 실측: 쓰는 사이에 바뀐 것이 설정을 바꾸면 5/5, 다시 불러오면 3/3 사라졌다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getLogger, setLogger } from "@im-nobsidian/core";
import { SqlJsStateDB } from "../../src/state/sqljs-state-db.js";

interface PendingWrite {
  data: Uint8Array;
  finish: () => void;
  fail: (error: Error) => void;
}

/**
 * 파일 흉내 — 쓰기를 부른 차례로 받아 두고, 언제 끝낼지는 시험이 정한다. 파일에는 마지막으로 끝난 쓰기가
 * 남는다. `autoFinish` 면 받는 대로 끝낸다.
 */
function fakeFile() {
  const file = {
    content: null as Uint8Array | null,
    pending: [] as PendingWrite[],
    autoFinish: false,
    write: vi.fn(
      (data: Uint8Array) =>
        new Promise<void>((resolve, reject) => {
          const pending: PendingWrite = {
            data,
            finish: () => {
              file.content = data;
              resolve();
            },
            fail: reject,
          };
          if (file.autoFinish) pending.finish();
          else file.pending.push(pending);
        }),
    ),
  };
  return file;
}

type FakeFile = ReturnType<typeof fakeFile>;

/** 파일에 남은 DB 의 메타 값. */
async function metaInFile(file: FakeFile, key: string): Promise<string | null> {
  if (!file.content) return null;
  const db = await SqlJsStateDB.open(file.content);
  try {
    return db.getMeta(key);
  } finally {
    await db.close();
  }
}

/** 받아 둔 쓰기가 생길 때까지 기다린다. */
async function waitForPending(file: FakeFile, count: number): Promise<void> {
  await vi.waitFor(() => expect(file.pending).toHaveLength(count));
}

/** 다른 일이 끼어들 틈을 한 번 준다. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 쓰기가 다 끝날 때까지, 받아 둔 쓰기를 늦게 부른 것부터 끝낸다 — 옛 쓰기가 가장 늦게 끝나는 나쁜 경우.
 */
async function finishNewestFirst(file: FakeFile, until: Promise<unknown>): Promise<void> {
  let settled = false;
  until.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    await tick();
    for (const write of file.pending.splice(0).reverse()) write.finish();
  }
  await until;
}

const opened: SqlJsStateDB[] = [];
async function openWith(file: FakeFile): Promise<SqlJsStateDB> {
  const db = await SqlJsStateDB.open(null, file.write);
  opened.push(db);
  return db;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const db of opened.splice(0)) {
    await db.close().catch(() => undefined);
  }
});

describe("상태 DB 파일 쓰기", () => {
  it("쓰는 사이에 바뀐 것도 다음 쓰기가 파일에 쓴다", async () => {
    const file = fakeFile();
    const db = await openWith(file);

    db.setMeta("k", "first");
    const writing = db.flush();
    await waitForPending(file, 1);
    db.setMeta("k", "second");
    file.pending.shift()!.finish();
    await writing;

    file.autoFinish = true;
    await db.flush();

    expect(await metaInFile(file, "k")).toBe("second");
  });

  it("겹친 쓰기는 차례로 — 늦게 끝난 옛 쓰기가 새 쓰기를 덮지 않는다", async () => {
    const file = fakeFile();
    const db = await openWith(file);

    db.setMeta("k", "old");
    const first = db.flush();
    await waitForPending(file, 1);
    db.setMeta("k", "new");
    const second = db.flush();
    await finishNewestFirst(file, Promise.all([first, second]));

    expect(await metaInFile(file, "k")).toBe("new");
  });

  it("닫기는 남은 쓰기가 끝난 뒤에 끝난다 — 닫은 뒤 파일을 읽으면 마지막 기록이 있다", async () => {
    const file = fakeFile();
    const db = await SqlJsStateDB.open(null, file.write);

    db.setMeta("k", "last");
    let closed = false;
    const closing = db.close().then(() => (closed = true));
    await waitForPending(file, 1);
    await tick();
    expect(closed).toBe(false);

    file.pending.shift()!.finish();
    await closing;

    expect(await metaInFile(file, "k")).toBe("last");
    expect(file.write).toHaveBeenCalledTimes(1);
  });

  it("닫기는 도는 쓰기가 끝나기를 기다린 뒤 그 사이에 바뀐 것까지 쓴다", async () => {
    const file = fakeFile();
    const db = await SqlJsStateDB.open(null, file.write);

    db.setMeta("k", "first");
    const writing = db.flush();
    await waitForPending(file, 1);
    db.setMeta("k", "second");
    const closing = db.close();
    await finishNewestFirst(file, Promise.all([writing, closing]));

    expect(await metaInFile(file, "k")).toBe("second");
  });

  it("못 쓰면 이유를 던지고, 바뀐 것은 다음 쓰기가 다시 쓴다", async () => {
    const file = fakeFile();
    const db = await openWith(file);

    db.setMeta("k", "v");
    const failing = db.flush();
    await waitForPending(file, 1);
    file.pending.shift()!.fail(new Error("디스크가 가득 참"));
    await expect(failing).rejects.toThrow("디스크가 가득 참");

    file.autoFinish = true;
    await db.flush();

    expect(file.write).toHaveBeenCalledTimes(2);
    expect(await metaInFile(file, "k")).toBe("v");
  });

  it("닫다가 못 쓰면 닫지 않고 이유를 던진다 — 다시 닫으면 쓴다", async () => {
    const file = fakeFile();
    const db = await SqlJsStateDB.open(null, file.write);

    db.setMeta("k", "v");
    const closing = db.close();
    await waitForPending(file, 1);
    file.pending.shift()!.fail(new Error("권한 없음"));
    await expect(closing).rejects.toThrow("권한 없음");
    expect(db.getMeta("k")).toBe("v");

    file.autoFinish = true;
    await db.close();

    expect(await metaInFile(file, "k")).toBe("v");
  });

  it("주기 쓰기가 실패하면 이유를 경고로 남긴다 — 바뀐 것은 닫을 때 다시 쓴다", async () => {
    const file = fakeFile();
    const db = await SqlJsStateDB.open(null, file.write);
    const previous = getLogger();
    const warn = vi.fn();
    setLogger({ ...previous, warn });
    try {
      vi.useFakeTimers();
      db.setMeta("k", "v");
      await vi.advanceTimersByTimeAsync(5000);
      file.pending.shift()!.fail(new Error("디스크가 가득 참"));
      await vi.advanceTimersByTimeAsync(0);

      expect(warn.mock.calls).toEqual([
        ["[Im-Nobsidian] 상태 DB 를 파일에 쓰지 못함: 디스크가 가득 참"],
      ]);
    } finally {
      setLogger(previous);
      vi.useRealTimers();
    }

    file.autoFinish = true;
    await db.close();
    expect(await metaInFile(file, "k")).toBe("v");
  });
});
