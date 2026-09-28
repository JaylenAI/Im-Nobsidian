/**
 * CLI 가 남긴 기록이 아직 WAL 파일에만 있는지 — 플러그인(sql.js)은 본 파일만 읽는다.
 *
 * CLI(better-sqlite3)는 상태 DB 를 WAL 모드로 쓴다. 쓰는 동안 기록은 옆 `-wal` 파일에 쌓이고, 닫을 때 본 파일로
 * 합쳐진 뒤 지워진다. 끝나지 않고 죽으면 `-wal` 이 남는다. 그때 플러그인이 본 파일만 읽으면 마지막 기록이 빠진
 * DB(체크포인트 전이면 표도 없는 빈 DB)를 열고, 파일째 갈아 끼우면서 남은 WAL 과 짝이 맞지 않는 파일을 만든다.
 * 잠금(ADR-026)을 모르는 옛 CLI 가 도는 중에도 WAL 이 차 있다.
 */
import { statSync } from "node:fs";
import { STATE_DB_PATH } from "../constants/paths.js";
import { StateDbUnavailableError } from "./state-db-unavailable.js";

/** SQLite 가 WAL 모드에서 쓰는 옆 파일 — 이름은 SQLite 가 정한다. */
export function stateDbWalPath(dbPath: string): string {
  return `${dbPath}-wal`;
}

/**
 * 최근 기록이 아직 WAL 파일에만 있다 — CLI 가 쓰는 중이거나 끝까지 닫지 못했다. CLI 가 닫으면(끝났으면 명령 하나를
 * 다시 실행하면) 본 파일로 합쳐진다.
 */
export class PendingWalError extends StateDbUnavailableError {
  constructor(readonly walBytes: number) {
    super(
      `최근 동기화 기록이 아직 ${stateDbWalPath(STATE_DB_PATH)} 에만 있음 (${walBytes}바이트) — ` +
        "CLI 가 쓰는 중이거나 끝까지 닫지 못함",
    );
    this.name = "PendingWalError";
  }

  guidance(retry: string): string {
    return (
      "CLI 가 도는 중이면 끝난 뒤, 이미 끝났으면 볼트 폴더에서 CLI 명령 하나(예: status)를 실행해 기록을 " +
      `상태 DB 로 합친 뒤 ${retry}.`
    );
  }
}

/** WAL 파일에 쌓인 바이트 — 파일이 없으면 0. */
export function pendingWalBytes(dbPath: string): number {
  try {
    return statSync(stateDbWalPath(dbPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * WAL 파일에 기록이 남았으면 던진다. 잠금을 잡은 뒤에 부른다 — 지금 CLI 는 잠금이 먼저 막으므로, 여기서 본 WAL 은
 * 끝나지 않고 죽은 CLI 나 잠금을 모르는 옛 CLI 의 것이다.
 */
export function assertNoPendingWal(dbPath: string): void {
  const bytes = pendingWalBytes(dbPath);
  if (bytes > 0) throw new PendingWalError(bytes);
}
