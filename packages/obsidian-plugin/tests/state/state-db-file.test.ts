/**
 * 플러그인이 쥔 상태 DB 파일 — 잠금을 쥔 동안만 열고, 쓰기 전에는 파일이 이 창이 읽은 그대로인지 본다(ADR-026).
 * 실제 파일 시스템으로 본다.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PendingWalError,
  StateDbLockedError,
  StateLock,
  stateDbLockPath,
} from "@im-nobsidian/core";
import { StateDbCopyStaleError, StateDbFile } from "../../src/state/state-db-file.js";

const dirs: string[] = [];
const held: StateDbFile[] = [];

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "im-nobsidian-dbfile-"));
  dirs.push(dir);
  return join(dir, "sync.db");
}

function acquire(path: string): StateDbFile {
  const file = StateDbFile.acquire(path, "Im-Notion Sync");
  held.push(file);
  return file;
}

afterEach(() => {
  for (const file of held.splice(0)) file.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 쓰려다 멈춘 까닭 — 쓰면 시험이 실패한다. */
async function staleReason(file: StateDbFile, path: string): Promise<string> {
  const before = existsSync(path) ? [...readFileSync(path)] : null;
  try {
    await file.write(new Uint8Array([9, 9]));
  } catch (error) {
    expect(error).toBeInstanceOf(StateDbCopyStaleError);
    // 멈췄으면 파일은 그대로다
    expect(existsSync(path) ? [...readFileSync(path)] : null).toEqual(before);
    return (error as Error).message;
  }
  throw new Error("썼다 — 멈춰야 한다");
}

describe("플러그인이 쥔 상태 DB 파일", () => {
  it("잡으면 잠금 파일에 플러그인을 적고, 풀면 지운다", () => {
    const path = dbPath();

    const file = StateDbFile.acquire(path, "Im-Notion Sync");

    expect(JSON.parse(readFileSync(stateDbLockPath(path), "utf8"))).toMatchObject({
      tool: "plugin",
      label: "Im-Notion Sync",
      pid: process.pid,
    });
    file.release();
    expect(existsSync(stateDbLockPath(path))).toBe(false);
  });

  it("CLI 가 쥐고 있으면 잡지 못한다", () => {
    const path = dbPath();
    const cli = StateLock.acquire(stateDbLockPath(path), { tool: "cli" });

    expect(() => StateDbFile.acquire(path, "Im-Notion Sync")).toThrow(StateDbLockedError);
    cli.release();
  });

  it("CLI 가 남긴 기록이 WAL 에만 있으면 잠금을 풀고 던진다 — 기록을 합치러 실행한 CLI 가 막히지 않게", () => {
    const path = dbPath();
    writeFileSync(`${path}-wal`, Buffer.alloc(32));

    expect(() => StateDbFile.acquire(path, "Im-Notion Sync")).toThrow(PendingWalError);
    expect(existsSync(stateDbLockPath(path))).toBe(false);
  });

  it("처음(파일 없음)이면 쓰고, 쓴 뒤로는 제 쓰기를 바뀐 것으로 보지 않는다", async () => {
    const path = dbPath();
    const file = acquire(path);

    await file.write(new Uint8Array([1]));
    await file.write(new Uint8Array([1, 2]));

    expect([...readFileSync(path)]).toEqual([1, 2]);
  });

  it("읽은 뒤 제자리에 바뀌었으면 쓰지 않는다 — 잠금을 모르는 옛 CLI 가 더한 기록", async () => {
    const path = dbPath();
    writeFileSync(path, new Uint8Array([1, 2, 3]));
    const file = acquire(path);
    writeFileSync(path, new Uint8Array([1, 2, 3, 4]));

    expect(await staleReason(file, path)).toBe(
      "이 창이 읽은 뒤에 다른 곳이 상태 DB 파일을 바꿔 파일에 쓰지 않음",
    );
  });

  it("읽은 뒤 갈아 끼워졌으면 크기가 같아도 쓰지 않는다 — 사본으로 되돌린 파일", async () => {
    const path = dbPath();
    writeFileSync(path, new Uint8Array([1, 2, 3]));
    const file = acquire(path);
    writeFileSync(`${path}.copy`, new Uint8Array([7, 8, 9]));
    renameSync(`${path}.copy`, path);

    expect(await staleReason(file, path)).toBe(
      "이 창이 읽은 뒤에 다른 곳이 상태 DB 파일을 바꿔 파일에 쓰지 않음",
    );
  });

  it("처음이었는데 그 사이 다른 곳이 파일을 만들었으면 쓰지 않는다", async () => {
    const path = dbPath();
    const file = acquire(path);
    writeFileSync(path, new Uint8Array([5]));

    expect(await staleReason(file, path)).toBe(
      "이 창이 읽은 뒤에 다른 곳이 상태 DB 파일을 바꿔 파일에 쓰지 않음",
    );
  });

  it("CLI 가 WAL 에 쓰는 중이면 쓰지 않는다 — 갈아 끼우면 그 WAL 이 다른 파일에 붙는다", async () => {
    const path = dbPath();
    const file = acquire(path);
    writeFileSync(`${path}-wal`, Buffer.alloc(4152));

    expect(await staleReason(file, path)).toBe(
      "CLI 가 상태 DB 에 쓰는 중이라 파일에 쓰지 않음 (.im-nobsidian/sync.db-wal 4152바이트)",
    );
  });

  it("잠금 파일을 읽지 못하면 사본 탓으로 보지 않는다 — 버리지 않고 다음 쓰기가 다시 해 본다", async () => {
    const path = dbPath();
    const file = acquire(path);
    // 잠금 파일 자리에 폴더가 생겨 읽지 못한다(EISDIR)
    rmSync(stateDbLockPath(path));
    mkdirSync(stateDbLockPath(path));

    const failure = await file.write(new Uint8Array([1])).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(StateDbCopyStaleError);
    expect((failure as NodeJS.ErrnoException).code).toBe("EISDIR");
    expect(existsSync(path)).toBe(false);
    rmSync(stateDbLockPath(path), { recursive: true });
  });

  it("잠금을 넘겨받혔으면 쓰지 않고 누가 넘겨받았는지 알린다", async () => {
    const path = dbPath();
    const file = acquire(path);
    writeFileSync(
      stateDbLockPath(path),
      JSON.stringify({
        tool: "cli",
        pid: 200,
        scope: "다른 컴퓨터",
        context: "창",
        startedAt: "2026-09-28T00:00:00.000Z",
        token: "다른 곳",
      }),
    );

    expect(await staleReason(file, path)).toBe(
      "상태 DB 잠금을 다른 곳이 넘겨받아 파일에 쓰지 않음 — CLI (pid 200)",
    );
  });
});
