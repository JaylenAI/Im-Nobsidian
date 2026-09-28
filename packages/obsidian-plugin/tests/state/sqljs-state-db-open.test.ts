/**
 * 저장된 상태 DB 파일로 열기 — 비었거나 잘린 파일을 빈 DB 로 열지 않고 이유를 던지는지 실제 sql.js 로 본다.
 *
 * SQLite 는 비었거나(0바이트) 앞 한 바이트만 남은 파일을 «빈 DB» 로 연다. 예전 쓰기(파일을 비우고 처음부터
 * 쓰기)는 도중에 죽으면 이런 파일을 남겼다 — 실측에서 쓰는 도중에 50번 죽이면 40번(0바이트 29 · 잘림 11).
 * 빈 DB 로 열면 노트와 Notion 페이지의 짝을 잃은 채 처음부터 시작하고, 다음 push 가 페이지를 또 만든다.
 */
import { describe, it, expect, onTestFinished, vi } from "vitest";
import initSqlJs from "sql.js";
import { SavedStateDbError, SqlJsStateDB } from "../../src/state/sqljs-state-db.js";

/** 동기화 기록 하나를 담아 저장한 파일의 내용. */
async function savedFile(): Promise<Uint8Array> {
  const db = await SqlJsStateDB.open();
  db.upsert({
    obsidianPath: "노트.md",
    notionPageId: "page-1",
    notionParentId: null,
    contentHash: "hash",
    notionLastEdited: null,
    localLastModified: "2026-09-28T00:00:00Z",
    syncDirection: "both",
    fileType: "file",
    status: "synced",
    baseSnapshot: null,
    localMtime: null,
    localFileSize: null,
  });
  const data = db.export();
  await db.close();
  return data;
}

/** 열다가 던진 것 — 던지지 않으면 시험이 실패한다. */
async function openFailure(data: Uint8Array): Promise<unknown> {
  const opened = await SqlJsStateDB.open(data).then(
    async (db) => {
      await db.close();
      return null;
    },
    (error: unknown) => ({ error }),
  );
  if (opened === null) throw new Error("열렸다 — 던져야 한다");
  return opened.error;
}

describe("저장된 상태 DB 파일로 열기", () => {
  it("저장한 파일로 다시 열면 동기화 기록이 그대로다", async () => {
    const db = await SqlJsStateDB.open(await savedFile());

    expect(db.getByPath("노트.md")?.notionPageId).toBe("page-1");
    await db.close();
  });

  it("저장한 파일이 없으면 새 DB 로 연다 — 처음 쓰는 볼트", async () => {
    const db = await SqlJsStateDB.open(null);

    expect(db.getAll()).toEqual([]);
    await db.close();
  });

  it.each([
    ["비었으면(0바이트)", 0],
    ["앞 한 바이트만 남았으면", 1],
  ])("%s 빈 DB 로 열지 않고 이유를 던진다", async (_case, length) => {
    const error = await openFailure((await savedFile()).slice(0, length));

    expect(error).toBeInstanceOf(SavedStateDbError);
    expect((error as Error).message).toBe(
      `저장된 상태 DB 파일에 동기화 기록이 없음 (${length}바이트)`,
    );
  });

  it("한 페이지 이상 잘렸으면 SQLite 가 말한 이유를 담아 던진다", async () => {
    const error = await openFailure((await savedFile()).slice(0, 4096));

    expect(error).toBeInstanceOf(SavedStateDbError);
    expect((error as Error).message).toBe(
      "저장된 상태 DB 파일을 열지 못함 (database disk image is malformed)",
    );
  });

  it("상태 DB 가 아닌 파일이면 SQLite 가 말한 이유를 담아 던진다", async () => {
    const error = await openFailure(new TextEncoder().encode("SQLite 파일이 아닌 글"));

    expect(error).toBeInstanceOf(SavedStateDbError);
    expect((error as Error).message).toBe(
      "저장된 상태 DB 파일을 열지 못함 (file is not a database)",
    );
  });

  it("열지 못한 DB 는 닫는다 — 새로고침으로 다시 해 볼 때마다 메모리에 쌓이지 않는다", async () => {
    const data = (await savedFile()).slice(0, 4096);
    // sql.js 는 모듈을 한 번만 띄운다 — 상태 DB 가 여는 DB 도 이 Database 다
    const { Database } = await initSqlJs();
    const close = vi.spyOn(Database.prototype, "close");
    onTestFinished(() => close.mockRestore());

    await openFailure(data);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("저장한 파일 없이 열다 실패하면 파일 탓으로 돌리지 않는다 — 파일을 치우라는 안내가 붙지 않게", async () => {
    const data = await savedFile();
    const migrate = vi
      .spyOn(SqlJsStateDB.prototype as unknown as { migrate: () => void }, "migrate")
      .mockImplementation(() => {
        throw new Error("엔진 오류");
      });
    onTestFinished(() => migrate.mockRestore());

    const fresh = await SqlJsStateDB.open(null).catch((error: unknown) => error);
    const saved = await openFailure(data);

    expect(fresh).not.toBeInstanceOf(SavedStateDbError);
    expect((fresh as Error).message).toBe("엔진 오류");
    // 저장한 파일로 열다 같은 곳에서 실패하면 파일 탓이다
    expect(saved).toBeInstanceOf(SavedStateDbError);
    expect((saved as Error).message).toBe("저장된 상태 DB 파일을 열지 못함 (엔진 오류)");
  });
});
