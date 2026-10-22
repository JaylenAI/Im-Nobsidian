/**
 * 상태 DB 잠금 — 한 볼트의 상태 DB 는 한 곳(CLI 한 개 또는 플러그인 한 개)만 연다.
 *
 * CLI(better-sqlite3 · WAL)와 플러그인(sql.js 메모리 사본 · 파일째 갈아 끼우기)은 같은 파일
 * (`.im-nobsidian/sync.db`)을 쓴다. 함께 열면:
 * - 플러그인은 CLI 가 쓴 기록을 모른 채 메모리 사본을 파일째 써서 그 기록을 지운다. 기록을 잃은 노트는 다음 push 가
 *   페이지를 또 만든다.
 * - CLI 가 도는 동안 최근 기록은 `-wal` 에만 있어, 본 파일만 읽는 플러그인은 옛 기록(또는 빈 DB)을 연다.
 * - 플러그인이 파일을 갈아 끼우면 CLI 의 WAL 이 다른 파일에 붙는다.
 *
 * 잠금 파일을 `wx`(있으면 실패)로 만들어 잡는다. 주인(도구 · PID · PID 공간 · 표)을 적고, 쥔 동안 수정 시각을 새로
 * 적어 살아 있다는 신호를 보낸다. 주인이 끝나지 않고 죽었으면(강제 종료 · 충돌) 넘겨받는다.
 *
 * @see docs/02-architecture/adr/026-one-state-db-owner.md
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { STATE_DB_PATH } from "../constants/paths.js";
import { getLogger } from "../utils/logger.js";
import { StateDbUnavailableError } from "./state-db-unavailable.js";

/** 쥔 동안 이 간격으로 잠금 파일의 수정 시각을 새로 적는다 — 살아 있다는 신호. */
export const STATE_LOCK_HEARTBEAT_MS = 30_000;

/**
 * PID 로 살았는지 물을 수 없는 주인(다른 컴퓨터 · 컨테이너 · flatpak)은 신호가 이만큼 끊기면 끝난 것으로 본다. 신호
 * 간격의 네 배 — 바쁜 이벤트 루프가 신호 몇 번을 늦춰도 산 주인의 잠금을 뺏지 않는다.
 */
export const STATE_LOCK_STALE_MS = STATE_LOCK_HEARTBEAT_MS * 4;

/** 상태 DB 파일 옆의 잠금 파일. */
export function stateDbLockPath(dbPath: string): string {
  return `${dbPath}.lock`;
}

/** 상태 DB 를 여는 도구. */
export type StateDbTool = "cli" | "plugin";

/** 잠금을 잡는 쪽 — 화면에 보일 이름(`label`, 예: 플러그인 이름)은 있으면 적는다. */
export interface StateLockClaim {
  readonly tool: StateDbTool;
  readonly label?: string;
}

/** 잠금 파일에 적는 주인. */
export interface StateLockOwner extends StateLockClaim {
  readonly pid: number;
  /** PID 가 같은 뜻을 갖는 범위 — {@link processScope}. */
  readonly scope: string;
  /** 잠금을 잡은 실행 환경 — 같은 PID 의 옛 환경이 남긴 잠금을 가른다({@link processContext}). */
  readonly context: string;
  readonly startedAt: string;
  /** 잠금마다 새로 만드는 표 — 넘겨받힌 뒤 남의 잠금을 지우지 않도록 내 것인지 가른다. */
  readonly token: string;
}

/** 잠금이 보는 바깥 — 시험이 갈아 끼운다. */
export interface StateLockEnv {
  readonly pid: number;
  readonly scope: string;
  readonly context: string;
  now(): number;
  isAlive(pid: number): boolean;
}

/** 이 프로세스의 바깥. */
export function processLockEnv(): StateLockEnv {
  return {
    pid: process.pid,
    scope: processScope(),
    context: processContext(),
    now: () => Date.now(),
    isAlive: processAlive,
  };
}

/**
 * PID 가 같은 뜻을 갖는 범위. 같은 컴퓨터라도 flatpak · snap · 컨테이너 · WSL 은 PID 공간이 달라, 그 안의 PID 로
 * 밖의 프로세스를 물으면 엉뚱한 답이 나온다. 리눅스는 PID 네임스페이스로, 다른 플랫폼은 호스트 · 플랫폼으로 가른다.
 */
function processScope(): string {
  let namespace = "";
  try {
    namespace = readlinkSync("/proc/self/ns/pid");
  } catch {
    // 리눅스가 아니다 — PID 네임스페이스가 없다
  }
  return [hostname(), process.platform, namespace].join("|");
}

const CONTEXT = Symbol.for("im-nobsidian/state-lock-context");

/**
 * 이 프로세스 안의 실행 환경(JS 전역) 표. Obsidian 이 창을 새로 불러오면(Ctrl+R) 프로세스는 그대로라, 옛 창의
 * 플러그인이 풀지 못한 잠금의 PID 가 산 채로 남는다 — 전역마다 새로 만드는 이 표로 그 잠금을 가른다. 플러그인만
 * 다시 불러오면(끄고 켜기 · 업데이트) 창의 전역이 그대로라 표도 같다 — 새 인스턴스는 옛 인스턴스가 풀기를 기다린다.
 */
function processContext(): string {
  const registry = globalThis as { [CONTEXT]?: string };
  return (registry[CONTEXT] ??= randomUUID());
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — 있지만 신호를 보낼 권한이 없다(다른 사용자의 프로세스)
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 잠금 파일에서 읽은 것 — 주인을 읽지 못했으면(쓰는 중 · 깨짐) `owner` 가 null 이다. */
interface HeldLock {
  readonly owner: StateLockOwner | null;
  readonly raw: string;
  /** 마지막 신호 — 잠금 파일의 수정 시각. */
  readonly mtimeMs: number;
}

/** 잡으려다 다른 곳과 엇갈려도(막 풀림 · 막 넘겨받음) 이만큼은 다시 해 본다. */
const ACQUIRE_ATTEMPTS = 5;

export class StateLock {
  private heartbeat: ReturnType<typeof setInterval> | null;

  private constructor(
    private readonly path: string,
    readonly owner: StateLockOwner,
    private readonly env: StateLockEnv,
  ) {
    this.heartbeat = setInterval(() => this.beat(), STATE_LOCK_HEARTBEAT_MS);
    // 신호 때문에 CLI 프로세스가 끝나지 못하는 일은 없게 한다
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  /**
   * 잠금을 잡는다. 다른 곳이 쥐고 있으면 {@link StateDbLockedError} 를 던진다. 주인이 끝나지 않고 죽었으면 넘겨받는다
   * — 같은 PID 공간이면 PID 가 없거나 이 프로세스의 옛 실행 환경일 때, 아니면 신호가
   * {@link STATE_LOCK_STALE_MS} 넘게 끊겼을 때다({@link isAbandoned}).
   */
  static acquire(
    path: string,
    claim: StateLockClaim,
    env: StateLockEnv = processLockEnv(),
  ): StateLock {
    const owner: StateLockOwner = {
      ...claim,
      pid: env.pid,
      scope: env.scope,
      context: env.context,
      startedAt: new Date(env.now()).toISOString(),
      token: randomUUID(),
    };
    mkdirSync(dirname(path), { recursive: true });
    // 죽은 주인의 잠금은 본 그대로일 때만 치우고 다시 잡는다 — 보는 사이 다른 곳이 먼저 잡았으면 그 잠금은 두고
    // 다시 본다. 엇갈림이 거듭되면 몇 번 뒤 멈춘다.
    let held: HeldLock | null = null;
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
      if (createLockFile(path, owner)) return new StateLock(path, owner, env);
      held = readHeld(path);
      if (held === null) continue; // 읽기 전에 풀렸다 — 다시 잡는다
      const signalAgeMs = env.now() - held.mtimeMs;
      if (!isAbandoned(held, signalAgeMs, env)) {
        throw StateDbLockedError.held(held.owner, signalAgeMs);
      }
      if (removeIfUnchanged(path, held)) {
        getLogger().warn(
          `[Im-Nobsidian] 끝나지 않고 멈춘 곳의 상태 DB 잠금을 넘겨받음 — ${describeHolder(held.owner, signalAgeMs)}`,
        );
      }
    }
    throw StateDbLockedError.held(held?.owner ?? null, held ? env.now() - held.mtimeMs : 0);
  }

  /** 아직 내 잠금인가 — 잠금 파일에 내 표가 적혀 있다. */
  isOwned(): boolean {
    return readHeld(this.path)?.owner?.token === this.owner.token;
  }

  /**
   * 내 잠금이 아니면 던진다 — 파일에 쓰기 전에 부른다. 멈춘 줄 알고 다른 곳이 넘겨받았는데 옛 사본을 쓰면 그쪽
   * 기록을 지운다.
   */
  assertOwned(): void {
    if (this.isOwned()) return;
    throw StateDbLockedError.lost(readHeld(this.path)?.owner ?? null);
  }

  /**
   * 잠금을 푼다 — 내 잠금일 때만 파일을 지운다. 여러 번 불러도 된다. 풀지 못해도 던지지 않는다 — 할 일은 이미
   * 끝났고, 남은 잠금은 이 프로세스가 끝나면 다음에 여는 곳이 넘겨받는다.
   */
  release(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      if (this.isOwned()) unlinkSync(this.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn(`[Im-Nobsidian] 상태 DB 잠금을 풀지 못함 (${this.path}): ${message}`);
    }
  }

  private beat(): void {
    if (!this.isOwned()) {
      if (this.heartbeat !== null) clearInterval(this.heartbeat);
      this.heartbeat = null;
      getLogger().warn(`[Im-Nobsidian] 상태 DB 잠금을 다른 곳이 넘겨받음 (${this.path})`);
      return;
    }
    const now = new Date(this.env.now());
    try {
      utimesSync(this.path, now, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().warn(`[Im-Nobsidian] 상태 DB 잠금에 신호를 적지 못함: ${message}`);
    }
  }
}

/** 잠금 파일을 새로 만들어 주인을 적는다 — 이미 있으면 false. */
function createLockFile(path: string, owner: StateLockOwner): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(owner));
  } catch (error) {
    // 주인을 적지 못한 잠금은 남기지 않는다 — 남으면 읽을 수 없는 잠금이 신호가 끊길 때까지 막는다
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
  closeSync(fd);
  return true;
}

function readHeld(path: string): HeldLock | null {
  try {
    const raw = readFileSync(path, "utf8");
    const { mtimeMs } = statSync(path);
    return { owner: parseOwner(raw), raw, mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseOwner(raw: string): StateLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<StateLockOwner>;
    const valid =
      (value.tool === "cli" || value.tool === "plugin") &&
      typeof value.pid === "number" &&
      typeof value.scope === "string" &&
      typeof value.context === "string" &&
      typeof value.startedAt === "string" &&
      typeof value.token === "string";
    return valid ? (value as StateLockOwner) : null;
  } catch {
    return null;
  }
}

/**
 * 주인이 끝나지 않고 죽었나. 같은 PID 공간이면 PID 로 본다 — 잠들었던 컴퓨터가 깨어난 직후처럼 신호가 늦어도 산
 * 주인의 잠금을 뺏지 않는다. PID 가 이 프로세스인데 실행 환경이 다르면 새로 불러온 창의 옛 환경이 남긴 것이다 —
 * 한 프로세스에서 상태 DB 를 여는 환경은 하나뿐이다(워커 스레드에서 열면 이 가정이 깨진다). 다른 PID 공간이거나
 * 주인을 읽지 못했으면 신호가 끊긴 시간으로 본다.
 */
function isAbandoned(held: HeldLock, signalAgeMs: number, env: StateLockEnv): boolean {
  const owner = held.owner;
  if (owner === null || owner.scope !== env.scope) return signalAgeMs > STATE_LOCK_STALE_MS;
  if (owner.pid === env.pid) return owner.context !== env.context;
  return !env.isAlive(owner.pid);
}

/**
 * 죽은 것으로 본 그 잠금일 때만 지운다 — 보는 사이 다른 곳이 넘겨받아 새로 잡았으면 그대로 둔다.
 *
 * @returns 지웠나
 */
function removeIfUnchanged(path: string, held: HeldLock): boolean {
  const now = readHeld(path);
  if (now === null || now.raw !== held.raw || now.mtimeMs !== held.mtimeMs) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

function describeHolder(holder: StateLockOwner | null, signalAgeMs: number | null): string {
  if (holder === null) return "잠금 파일의 주인을 읽지 못함";
  const who =
    holder.tool === "plugin"
      ? `Obsidian 플러그인${holder.label ? ` ${holder.label}` : ""}`
      : `CLI${holder.label ? ` ${holder.label}` : ""}`;
  const signal =
    signalAgeMs === null ? "" : `, 마지막 신호 ${Math.max(0, Math.round(signalAgeMs / 1000))}초 전`;
  return `${who} (pid ${holder.pid}${signal})`;
}

/**
 * 상태 DB 를 다른 곳이 쓰는 중이다 — 기다렸다가 다시 하면 된다. 쓰는 곳이 없는데도 계속 막히면(PID 를 다른
 * 프로세스가 물려받음) 잠금 파일을 지우는 법까지 알린다.
 */
export class StateDbLockedError extends StateDbUnavailableError {
  private constructor(
    message: string,
    readonly holder: StateLockOwner | null,
  ) {
    super(message);
    this.name = "StateDbLockedError";
  }

  /** 다른 곳이 잠금을 쥐고 있다. */
  static held(holder: StateLockOwner | null, signalAgeMs: number): StateDbLockedError {
    return new StateDbLockedError(
      `이 볼트의 상태 DB 를 다른 곳이 쓰는 중 — ${describeHolder(holder, signalAgeMs)}`,
      holder,
    );
  }

  /** 쥐고 있던 잠금을 다른 곳이 넘겨받았다 — 멈춘 것으로 보였다. 옛 사본을 파일에 쓰지 않는다. */
  static lost(holder: StateLockOwner | null): StateDbLockedError {
    return new StateDbLockedError(
      `상태 DB 잠금을 다른 곳이 넘겨받아 파일에 쓰지 않음 — ${describeHolder(holder, null)}`,
      holder,
    );
  }

  guidance(retry: string): string {
    const wait =
      this.holder?.tool === "plugin"
        ? "Obsidian 을 닫거나 그 볼트의 플러그인을 끈 뒤"
        : this.holder?.tool === "cli"
          ? "CLI 가 끝난 뒤"
          : "쓰는 곳이 끝난 뒤";
    return (
      `${wait} ${retry}. 쓰는 곳이 없는데도 이 말이 계속 나오면 볼트 폴더의 ` +
      `${stateDbLockPath(STATE_DB_PATH)} 을 지운 뒤 ${retry}.`
    );
  }
}
