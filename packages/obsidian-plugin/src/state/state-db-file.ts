/**
 * 플러그인이 쥔 상태 DB 파일 — 잠금을 쥔 동안만 열고(ADR-026), 쓰기 전에는 파일이 이 창이 읽은 그대로인지 본다.
 *
 * 플러그인(sql.js)은 파일을 메모리 사본으로 읽고, 바뀐 사본을 파일째 갈아 끼운다. 사본을 읽은 뒤에 다른 곳이
 * 파일에 썼으면, 사본을 쓰는 순간 그곳의 기록이 지워진다 — 기록을 잃은 노트는 다음 push 가 페이지를 또 만든다.
 * 잠금이 CLI 를 막지만 막지 못하는 곳이 있다:
 * - 멈춘 줄 알고 잠금을 넘겨받은 곳 — 다른 컴퓨터 · 컨테이너처럼 PID 로 살았는지 물을 수 없을 때
 * - 잠금을 모르는 옛 CLI
 * - 파일을 사본으로 되돌린 사용자 · 파일을 옮겨 온 클라우드 동기화
 */
import { statSync } from "node:fs";
import {
  STATE_DB_PATH,
  StateDbLockedError,
  StateLock,
  assertNoPendingWal,
  pendingWalBytes,
  stateDbLockPath,
  stateDbWalPath,
} from "@im-nobsidian/core";
import { writeFileAtomically } from "./atomic-write.js";

/**
 * 파일을 알아보는 표 — 갈아 끼우면(이름 바꾸기) inode 가, 제자리에 쓰면 크기나 수정 시각이 바뀐다. 파일이 없으면
 * null.
 */
type FileStamp = { readonly ino: number; readonly size: number; readonly mtimeMs: number } | null;

function stampOf(path: string): FileStamp {
  try {
    const { ino, size, mtimeMs } = statSync(path);
    return { ino, size, mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * 이 창의 사본을 쓰면 다른 곳의 기록을 지운다 — 쓰지 않았다. 다시 해도 쓸 수 없으므로 사본을 버리고 파일에서 다시
 * 연다.
 */
export class StateDbCopyStaleError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StateDbCopyStaleError";
  }
}

export class StateDbFile {
  private constructor(
    private readonly path: string,
    private readonly lock: StateLock,
    /** 이 창이 마지막으로 읽거나 쓴 파일. */
    private seen: FileStamp,
  ) {}

  /**
   * 잠금을 잡는다 — 다른 곳이 쥐고 있으면 `StateDbLockedError`. CLI 가 남긴 기록이 WAL 에만 있으면 풀고
   * `PendingWalError` 를 던진다 — 플러그인은 본 파일만 읽는다. 파일은 이 뒤에 읽는다.
   */
  static acquire(path: string, label: string): StateDbFile {
    const lock = StateLock.acquire(stateDbLockPath(path), { tool: "plugin", label });
    try {
      assertNoPendingWal(path);
      // 읽기 «전» 에 적는다 — 적은 뒤 읽기 전에 누가 바꾸면 다음 쓰기가 바뀐 것으로 보고 멈춘다(놓치지 않는다)
      return new StateDbFile(path, lock, stampOf(path));
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  /**
   * 사본을 파일에 쓴다 — 파일이 이 창이 마지막으로 읽거나 쓴 그대로일 때만. 아니면
   * {@link StateDbCopyStaleError}.
   */
  async write(data: Uint8Array): Promise<void> {
    this.assertCurrent();
    await writeFileAtomically(this.path, data);
    this.seen = stampOf(this.path);
  }

  /** 잠금을 푼다 — 넘겨받힌 잠금은 그대로 둔다. */
  release(): void {
    this.lock.release();
  }

  private assertCurrent(): void {
    try {
      this.lock.assertOwned();
    } catch (error) {
      // 잠금 파일을 읽지 못한 것 같은 다른 실패는 사본 탓이 아니다 — 다음 쓰기가 다시 해 본다
      if (error instanceof StateDbLockedError) throw new StateDbCopyStaleError(error.message);
      throw error;
    }
    const walBytes = pendingWalBytes(this.path);
    if (walBytes > 0) {
      throw new StateDbCopyStaleError(
        `CLI 가 상태 DB 에 쓰는 중이라 파일에 쓰지 않음 (${stateDbWalPath(STATE_DB_PATH)} ${walBytes}바이트)`,
      );
    }
    if (!sameStamp(stampOf(this.path), this.seen)) {
      throw new StateDbCopyStaleError(
        "이 창이 읽은 뒤에 다른 곳이 상태 DB 파일을 바꿔 파일에 쓰지 않음",
      );
    }
  }
}
