/**
 * 상태 DB 잠금 — 한 볼트의 상태 DB 는 한 곳만 연다(ADR-026). 실제 파일로 잡고 · 막고 · 넘겨받는지 본다.
 *
 * 바깥(PID · PID 공간 · 시계 · 프로세스가 살았는지)은 갈아 끼운다. 잠금 파일의 수정 시각은 실제 파일 시스템의 것이라,
 * 시계는 그 시각을 기준으로 옮긴다.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StateLock,
  StateDbLockedError,
  STATE_LOCK_HEARTBEAT_MS,
  STATE_LOCK_STALE_MS,
  processLockEnv,
  stateDbLockPath,
  type StateLockEnv,
} from "../../src/state/state-lock.js";
import { getLogger, setLogger } from "../../src/utils/logger.js";

const dirs: string[] = [];
function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "im-nobsidian-lock-"));
  dirs.push(dir);
  return stateDbLockPath(join(dir, "sync.db"));
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOST = "host|linux|pid:[4026531836]";
const alive = new Set<number>();

/** 바깥 — 시계는 `at` 이 돌려주는 값이다. 실행 환경은 따로 주지 않으면 PID 마다 하나다. */
function env(
  pid: number,
  at: () => number = () => Date.now(),
  scope = HOST,
  context = `창 ${pid}`,
): StateLockEnv {
  alive.add(pid);
  return { pid, scope, context, now: at, isAlive: (p) => alive.has(p) };
}

/** 잡다가 던진 것 — 잡히면 시험이 실패한다. */
function acquireFailure(path: string, lockEnv: StateLockEnv): StateDbLockedError {
  try {
    StateLock.acquire(path, { tool: "cli" }, lockEnv).release();
  } catch (error) {
    expect(error).toBeInstanceOf(StateDbLockedError);
    return error as StateDbLockedError;
  }
  throw new Error("잡혔다 — 막혀야 한다");
}

const owner = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const signalAt = (path: string) => statSync(path).mtimeMs;

describe("상태 DB 잠금", () => {
  it("잡으면 잠금 파일에 주인을 적고, 풀면 지운다", () => {
    const path = lockPath();

    const lock = StateLock.acquire(path, { tool: "plugin", label: "Im-Notion Sync" }, env(100));

    expect(owner(path)).toMatchObject({
      tool: "plugin",
      label: "Im-Notion Sync",
      pid: 100,
      scope: HOST,
      context: "창 100",
      token: lock.owner.token,
    });
    lock.release();
    expect(existsSync(path)).toBe(false);
    lock.release(); // 두 번 불러도 된다
  });

  it("폴더가 없으면 만든다 — 처음 쓰는 볼트", () => {
    const path = join(lockPath(), "..", "새 볼트", ".im-nobsidian", "sync.db.lock");

    StateLock.acquire(path, { tool: "cli" }, env(100)).release();
  });

  it("다른 곳이 쥐고 있으면 누가 쥐었는지 담아 던지고 그 잠금을 건드리지 않는다", () => {
    const path = lockPath();
    const held = StateLock.acquire(path, { tool: "plugin", label: "Im-Notion Sync" }, env(100));
    const before = readFileSync(path, "utf8");

    const error = acquireFailure(path, env(200));

    expect(error.message).toBe(
      "이 볼트의 상태 DB 를 다른 곳이 쓰는 중 — Obsidian 플러그인 Im-Notion Sync (pid 100, 마지막 신호 0초 전)",
    );
    expect(error.holder?.tool).toBe("plugin");
    expect(readFileSync(path, "utf8")).toBe(before);
    held.release();
  });

  it("같은 프로세스가 한 번 더 잡아도 막는다 — 닫지 못한 옛 인스턴스의 사본을 새 인스턴스가 모르고 열지 않게", () => {
    const path = lockPath();
    const held = StateLock.acquire(path, { tool: "cli" }, env(100));

    expect(acquireFailure(path, env(100)).holder?.pid).toBe(100);
    held.release();
  });

  it("같은 PID 라도 실행 환경이 다르면 바로 넘겨받는다 — 창을 새로 불러와 옛 창의 플러그인이 풀지 못한 잠금", () => {
    const path = lockPath();
    const old = StateLock.acquire(path, { tool: "plugin" }, env(100, undefined, HOST, "옛 창"));

    const next = StateLock.acquire(path, { tool: "plugin" }, env(100, undefined, HOST, "새 창"));

    expect(owner(path)).toMatchObject({ pid: 100, context: "새 창", token: next.owner.token });
    old.release();
    expect(owner(path)).toMatchObject({ context: "새 창" });
    next.release();
  });

  it("같은 PID 공간에서 주인이 끝나지 않고 죽었으면 바로 넘겨받는다 — 강제 종료된 CLI", () => {
    const path = lockPath();
    const dead = StateLock.acquire(path, { tool: "cli" }, env(100));
    alive.delete(100);

    const next = StateLock.acquire(path, { tool: "plugin" }, env(200));

    expect(owner(path)).toMatchObject({ pid: 200, token: next.owner.token });
    // 죽은 쪽이 뒤늦게 풀어도 넘겨받은 잠금은 그대로다
    dead.release();
    expect(owner(path)).toMatchObject({ pid: 200 });
    next.release();
  });

  it("치우는 사이 다른 곳이 먼저 잡았으면 그 잠금은 두고, 그곳을 주인으로 알린다", () => {
    const path = lockPath();
    StateLock.acquire(path, { tool: "cli" }, env(100));
    alive.delete(100);
    const winner = {
      tool: "plugin",
      pid: 300,
      scope: HOST,
      context: "창 300",
      startedAt: "2026-09-28T00:00:00.000Z",
      token: "먼저 잡은 곳",
    };
    alive.add(300);
    // 죽은 주인인지 묻는 사이에 다른 곳이 죽은 잠금을 치우고 제 잠금을 잡았다
    const racing: StateLockEnv = {
      ...env(200),
      isAlive: (pid) => {
        if (pid === 100) writeFileSync(path, JSON.stringify(winner));
        return alive.has(pid);
      },
    };

    const previous = getLogger();
    const warn = vi.fn();
    setLogger({ ...previous, warn });

    try {
      expect(acquireFailure(path, racing).holder).toEqual(winner);
    } finally {
      setLogger(previous);
    }
    expect(owner(path)).toEqual(winner);
    // 치우지 않았으니 넘겨받았다고 알리지 않는다
    expect(warn).not.toHaveBeenCalled();
  });

  it("죽은 잠금이 치워도 거듭 생기면 몇 번 뒤 멈춘다 — 끝없이 돌지 않는다", () => {
    const path = lockPath();
    const dead = JSON.stringify({
      tool: "cli",
      pid: 100,
      scope: HOST,
      context: "창 100",
      startedAt: "2026-09-28T00:00:00.000Z",
      token: "죽은 곳",
    });
    writeFileSync(path, dead);
    alive.delete(100);
    const previous = getLogger();
    // 넘겨받았다고 알리는 사이에 같은 죽은 잠금이 다시 생긴다
    const warn = vi.fn(() => writeFileSync(path, dead));
    setLogger({ ...previous, warn });

    try {
      expect(acquireFailure(path, env(200)).holder?.pid).toBe(100);
    } finally {
      setLogger(previous);
    }
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("같은 PID 공간에서 주인이 살아 있으면 신호가 오래 끊겨도 뺏지 않는다 — 잠들었다 깬 컴퓨터", () => {
    const path = lockPath();
    const held = StateLock.acquire(path, { tool: "plugin" }, env(100));
    const anHourLater = signalAt(path) + 60 * 60 * 1000;

    const error = acquireFailure(
      path,
      env(200, () => anHourLater),
    );

    expect(error.message).toContain("마지막 신호 3600초 전");
    held.release();
  });

  it("다른 PID 공간(다른 컴퓨터 · flatpak)이면 신호가 끊긴 지 한참 지나야 넘겨받는다 — PID 로는 물을 수 없다", () => {
    const path = lockPath();
    StateLock.acquire(path, { tool: "plugin" }, env(100, undefined, "flatpak|linux|pid:[1]"));
    // 이쪽에서 보면 그 PID 는 없다 — 그래도 신호가 살아 있으면 막는다
    alive.delete(100);
    const t0 = signalAt(path);

    acquireFailure(
      path,
      env(200, () => t0 + STATE_LOCK_STALE_MS - 1000),
    );
    const next = StateLock.acquire(
      path,
      { tool: "cli" },
      env(200, () => t0 + STATE_LOCK_STALE_MS + 1000),
    );

    expect(owner(path)).toMatchObject({ pid: 200, scope: HOST });
    next.release();
  });

  it("주인을 읽지 못한 잠금(적다 멈춤)은 신호가 끊긴 지 한참 지나야 넘겨받는다", () => {
    const path = lockPath();
    StateLock.acquire(path, { tool: "cli" }, env(300)).release();
    writeFileSync(path, "");
    const t0 = signalAt(path);

    const error = acquireFailure(
      path,
      env(200, () => t0 + 1000),
    );
    expect(error.message).toBe(
      "이 볼트의 상태 DB 를 다른 곳이 쓰는 중 — 잠금 파일의 주인을 읽지 못함",
    );
    expect(error.holder).toBeNull();

    StateLock.acquire(
      path,
      { tool: "cli" },
      env(200, () => t0 + STATE_LOCK_STALE_MS + 1000),
    ).release();
  });

  it("쥔 동안 신호를 보낸다 — 잠금 파일의 수정 시각을 새로 적는다", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const path = lockPath();
    let clock = Date.now();
    const lock = StateLock.acquire(
      path,
      { tool: "plugin" },
      env(100, () => clock),
    );
    const first = signalAt(path);

    clock = first + STATE_LOCK_HEARTBEAT_MS;
    vi.advanceTimersByTime(STATE_LOCK_HEARTBEAT_MS);

    expect(Math.abs(signalAt(path) - clock)).toBeLessThan(1000);
    lock.release();
  });

  it("넘겨받힌 잠금은 쓰기 전 확인에서 던지고, 신호를 멈추고, 풀어도 그 잠금을 지우지 않는다", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const path = lockPath();
    const lost = StateLock.acquire(path, { tool: "plugin" }, env(100));
    lost.assertOwned();
    // 멈춘 줄 알고 다른 곳이 넘겨받았다 — 그곳의 신호가 섞이지 않게 잠금 파일만 바꿔 둔다
    const taker = {
      tool: "cli",
      pid: 200,
      scope: HOST,
      context: "창 200",
      startedAt: "2026-09-28T00:00:00Z",
      token: "다른 곳",
    };
    writeFileSync(path, JSON.stringify(taker));
    const takenAt = signalAt(path);

    expect(() => lost.assertOwned()).toThrow(
      "상태 DB 잠금을 다른 곳이 넘겨받아 파일에 쓰지 않음 — CLI (pid 200)",
    );
    vi.advanceTimersByTime(STATE_LOCK_HEARTBEAT_MS * 3);
    lost.release();

    expect(owner(path)).toEqual(taker);
    expect(signalAt(path)).toBe(takenAt);
  });

  it("할 일은 쥔 곳에 따라 다르고, 쓰는 곳이 없는데도 막히면 잠금 파일을 지우는 법까지 알린다", () => {
    const path = lockPath();
    const retry = "명령을 다시 실행하세요";
    const blockedBy = (tool: "cli" | "plugin") => {
      const held = StateLock.acquire(path, { tool }, env(100));
      const error = acquireFailure(path, env(200));
      held.release();
      return error.guidance(retry);
    };
    const escape =
      "쓰는 곳이 없는데도 이 말이 계속 나오면 볼트 폴더의 .im-nobsidian/sync.db.lock 을 지운 뒤 명령을 다시 실행하세요.";

    expect(blockedBy("plugin")).toBe(
      `Obsidian 을 닫거나 그 볼트의 플러그인을 끈 뒤 명령을 다시 실행하세요. ${escape}`,
    );
    expect(blockedBy("cli")).toBe(`CLI 가 끝난 뒤 명령을 다시 실행하세요. ${escape}`);
  });
});

describe("이 프로세스의 바깥", () => {
  it("PID 공간은 호스트 · 플랫폼으로 가른다 — 리눅스는 PID 네임스페이스까지", () => {
    const { scope, pid } = processLockEnv();

    expect(pid).toBe(process.pid);
    expect(scope).toContain(process.platform);
    if (process.platform === "linux") expect(scope).toMatch(/pid:\[\d+\]$/);
  });

  it("실행 환경 표는 전역마다 하나다 — 같은 전역에서 다시 물어도 같다", () => {
    expect(processLockEnv().context).toBe(processLockEnv().context);
    expect(processLockEnv().context).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("살았는지는 신호 0 으로 묻는다 — 권한이 없어도(EPERM) 있는 것이다", () => {
    const { isAlive } = processLockEnv();
    const ended = spawnSync(process.execPath, ["-e", "0"]).pid;

    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(ended)).toBe(false);
    if (process.platform !== "win32" && process.getuid?.() !== 0) expect(isAlive(1)).toBe(true);
  });
});
