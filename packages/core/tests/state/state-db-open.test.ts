/**
 * 저장된 상태 DB 파일로 열기(CLI · better-sqlite3) — 비었거나 잘린 파일을 빈 DB 로 열지 않고, 파일을 건드리지 않은
 * 채 이유를 던지는지 실제 파일로 본다.
 *
 * 예전에는 0 · 1바이트 파일을 알림 없이 빈 DB 로 열고, 닫을 때 빈 DB(110,592 B)로 덮었다. 이런 파일은 플러그인의
 * 예전 쓰기(파일을 비우고 처음부터 쓰기)가 도중에 끊기면 남는다.
 */
import { describe, it, expect, afterEach, onTestFinished, vi } from "vitest";
import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDB } from "../../src/state/state-db.js";
import { SavedStateDbError } from "../../src/state/saved-state-db-error.js";
import { StateDbLockedError, stateDbLockPath } from "../../src/state/state-lock.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "im-nobsidian-open-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = {
  obsidianPath: "노트.md",
  notionPageId: "page-1",
  notionParentId: null,
  contentHash: "hash",
  localLastModified: "2026-09-28T00:00:00Z",
  syncDirection: "both",
  fileType: "file",
  status: "synced",
} as const;

/** 동기화 기록 하나를 담아 닫은 상태 DB 파일. */
function savedFile(): string {
  const path = join(tempDir(), "sync.db");
  const db = StateDB.open(path);
  db.upsert(record);
  db.close();
  return path;
}

/** 열다가 던진 것 — 던지지 않으면 시험이 실패한다. */
function openFailure(path: string): Error {
  let db: StateDB;
  try {
    db = StateDB.open(path);
  } catch (error) {
    return error as Error;
  }
  db.close();
  throw new Error("열렸다 — 던져야 한다");
}

describe("저장된 상태 DB 파일로 열기 (CLI)", () => {
  it("저장한 파일로 다시 열면 동기화 기록이 그대로다", () => {
    const db = StateDB.open(savedFile());

    expect(db.getByPath("노트.md")?.notionPageId).toBe("page-1");
    db.close();
  });

  it("파일이 없으면 새로 만든다 — 처음 쓰는 볼트", () => {
    const db = StateDB.open(join(tempDir(), "sync.db"));

    expect(db.getAll()).toEqual([]);
    db.close();
  });

  it.each([
    ["비었으면(0바이트)", 0],
    ["앞 한 바이트만 남았으면", 1],
  ])("%s 빈 DB 로 열지 않고 파일을 덮지 않는다", (_case, length) => {
    const path = savedFile();
    const damaged = readFileSync(path).subarray(0, length);
    writeFileSync(path, damaged);

    const error = openFailure(path);

    expect(error).toBeInstanceOf(SavedStateDbError);
    expect(error.message).toBe(`저장된 상태 DB 파일에 동기화 기록이 없음 (${length}바이트)`);
    expect(readFileSync(path)).toEqual(damaged);
  });

  it("0바이트 파일 옆의 WAL 파일을 지우지 않는다 — SQLite 는 0바이트 파일을 읽을 때 지운다", () => {
    const path = join(tempDir(), "sync.db");
    writeFileSync(path, "");
    writeFileSync(`${path}-wal`, "쓰다 만 기록");

    expect(openFailure(path)).toBeInstanceOf(SavedStateDbError);
    expect(readFileSync(`${path}-wal`, "utf8")).toBe("쓰다 만 기록");
  });

  it("한 페이지 이상 잘렸으면 SQLite 가 말한 이유를 담아 던지고 파일을 덮지 않는다", () => {
    const path = savedFile();
    const damaged = readFileSync(path).subarray(0, 4096);
    writeFileSync(path, damaged);

    const error = openFailure(path);

    expect(error).toBeInstanceOf(SavedStateDbError);
    expect(error.message).toBe(
      "저장된 상태 DB 파일을 열지 못함 (database disk image is malformed)",
    );
    expect(readFileSync(path)).toEqual(damaged);
  });

  it("상태 DB 가 아닌 파일이면 SQLite 가 말한 이유를 담아 던진다", () => {
    const path = join(tempDir(), "sync.db");
    writeFileSync(path, "SQLite 파일이 아닌 글");

    const error = openFailure(path);

    expect(error).toBeInstanceOf(SavedStateDbError);
    expect(error.message).toBe("저장된 상태 DB 파일을 열지 못함 (file is not a database)");
  });

  it("열지 못한 DB 는 닫는다 — 파일 핸들과 WAL 파일을 남기지 않는다", () => {
    const path = savedFile();
    writeFileSync(path, readFileSync(path).subarray(0, 4096));
    const close = vi.spyOn(Database.prototype, "close");
    onTestFinished(() => close.mockRestore());

    openFailure(path);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("저장한 파일 없이 열다 실패하면 파일 탓으로 돌리지 않는다 — 파일을 치우라는 안내가 붙지 않게", () => {
    const saved = savedFile();
    const migrate = vi
      .spyOn(StateDB.prototype as unknown as { migrate: () => void }, "migrate")
      .mockImplementation(() => {
        throw new Error("엔진 오류");
      });
    onTestFinished(() => migrate.mockRestore());

    const fresh = openFailure(join(tempDir(), "sync.db"));

    expect(fresh).not.toBeInstanceOf(SavedStateDbError);
    expect(fresh.message).toBe("엔진 오류");
    // 저장한 파일로 열다 같은 곳에서 실패하면 파일 탓이다
    const error = openFailure(saved);
    expect(error).toBeInstanceOf(SavedStateDbError);
    expect(error.message).toBe("저장된 상태 DB 파일을 열지 못함 (엔진 오류)");
  });

  it("열 수 없는 자리면 그 이유를 그대로 던진다 — 파일 탓으로 돌려 치우라고 하지 않는다", () => {
    const path = join(tempDir(), "sync.db");
    mkdirSync(path);

    const error = openFailure(path);

    expect(error).not.toBeInstanceOf(SavedStateDbError);
  });

  it("열린 동안 다른 곳이 같은 상태 DB 를 열지 못한다 — 닫으면 연다(ADR-026)", () => {
    const path = savedFile();
    const first = StateDB.open(path);

    const error = openFailure(path);
    expect(error).toBeInstanceOf(StateDbLockedError);
    expect(error.message).toContain("이 볼트의 상태 DB 를 다른 곳이 쓰는 중 — CLI (pid ");

    first.close();
    expect(existsSync(stateDbLockPath(path))).toBe(false);
    StateDB.open(path).close();
  });

  it("열다 실패하면 잠금을 푼다 — 깨진 파일을 치운 뒤 바로 다시 열 수 있다", () => {
    const path = join(tempDir(), "sync.db");
    writeFileSync(path, "");

    expect(openFailure(path)).toBeInstanceOf(SavedStateDbError);

    expect(existsSync(stateDbLockPath(path))).toBe(false);
    rmSync(path);
    StateDB.open(path).close();
  });

  it("체크포인트 전에 끝난 CLI 의 기록은 WAL 에서 읽는다 — 깨진 파일로 보지 않는다", () => {
    const dir = tempDir();
    const path = join(dir, "sync.db");
    const running = StateDB.open(path);
    running.upsert(record);
    // 닫지 않은 채 — 기록은 아직 WAL 에만 있다. 그대로 복사해 죽은 뒤의 파일을 만든다.
    const copy = join(dir, "copy.db");
    copyFileSync(path, copy);
    copyFileSync(`${path}-wal`, `${copy}-wal`);
    running.close();

    const db = StateDB.open(copy);

    expect(db.getByPath("노트.md")?.notionPageId).toBe("page-1");
    db.close();
  });
});
