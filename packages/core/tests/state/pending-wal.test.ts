/**
 * CLI 가 남긴 기록이 아직 WAL 파일에만 있는지 — 플러그인은 본 파일만 읽으므로 그때는 열지 않는다(ADR-026).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PendingWalError,
  assertNoPendingWal,
  pendingWalBytes,
  stateDbWalPath,
} from "../../src/state/pending-wal.js";

const dirs: string[] = [];
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "im-nobsidian-wal-"));
  dirs.push(dir);
  return join(dir, "sync.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("남은 WAL", () => {
  it("WAL 파일이 없거나 비었으면 지나간다 — CLI 가 닫으면 지우거나 비운다", () => {
    const path = dbPath();
    expect(pendingWalBytes(path)).toBe(0);
    assertNoPendingWal(path);

    writeFileSync(stateDbWalPath(path), "");
    assertNoPendingWal(path);
  });

  it("WAL 에 기록이 있으면 크기와 합치는 법을 담아 던진다", () => {
    const path = dbPath();
    writeFileSync(stateDbWalPath(path), Buffer.alloc(4152));

    expect(pendingWalBytes(path)).toBe(4152);
    let thrown: unknown;
    try {
      assertNoPendingWal(path);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PendingWalError);
    const error = thrown as PendingWalError;
    expect(error.walBytes).toBe(4152);
    expect(error.message).toBe(
      "최근 동기화 기록이 아직 .im-nobsidian/sync.db-wal 에만 있음 (4152바이트) — CLI 가 쓰는 중이거나 끝까지 닫지 못함",
    );
    expect(error.guidance("명령을 다시 실행하세요")).toBe(
      "CLI 가 도는 중이면 끝난 뒤, 이미 끝났으면 볼트 폴더에서 CLI 명령 하나(예: status)를 실행해 기록을 " +
        "상태 DB 로 합친 뒤 명령을 다시 실행하세요.",
    );
  });

  it("WAL 을 보지 못한 까닭이 «없음» 이 아니면 그대로 던진다 — 없는 것으로 보고 열지 않는다", () => {
    const path = dbPath();
    // 폴더 자리에 파일이 있으면 그 아래 경로는 ENOTDIR
    const blocked = join(path, "sub", "sync.db");
    writeFileSync(path, "");

    expect(() => pendingWalBytes(blocked)).toThrow(/ENOTDIR/);
  });
});
