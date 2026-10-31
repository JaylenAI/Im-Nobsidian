import { setLogger } from "@im-nobsidian/core";

/**
 * 로그를 얼마나 보이나 — 전역 `--verbose` · `--quiet`. 예전에는 두 옵션을 받기만 하고 쓰지 않아, 엔진의 정보 로그(옮김 ·
 * 재시도 · 입양 …)가 늘 화면에 나와 명령이 정리해 보이는 결과와 같은 말을 두 번 했다(P8).
 *
 * - `normal` — 경고 · 오류만. 무엇을 했는지는 명령의 결과가 말한다
 * - `verbose` — 정보 · 디버그 로그도
 * - `quiet` — 오류만
 */
export type LogLevel = "quiet" | "normal" | "verbose";

let level: LogLevel = "normal";

const noop = (): void => {};

/** 엔진 로그를 이 수준으로 거른다. `sink` 를 주면 그곳으로 쓴다 — 기본은 콘솔(정보는 표준출력, 나머지는 표준오류). */
export function applyLogLevel(
  next: LogLevel,
  sink?: (message: string, ...args: unknown[]) => void,
): void {
  level = next;
  const out = (fallback: (message: string, ...args: unknown[]) => void) => sink ?? fallback;
  setLogger({
    error: out((message, ...args) => console.error(message, ...args)),
    warn: level === "quiet" ? noop : out((message, ...args) => console.warn(message, ...args)),
    info: level === "verbose" ? out((message, ...args) => console.info(message, ...args)) : noop,
    debug: level === "verbose" ? out((message, ...args) => console.debug(message, ...args)) : noop,
  });
}

/** 지금 수준 — `--json` 이 로그를 표준오류로 돌릴 때 수준은 그대로 둔다. */
export function currentLogLevel(): LogLevel {
  return level;
}

/** 전역 옵션에서 수준을 고른다 — 둘 다 주면 `--verbose` 가 이긴다(더 많이 보이는 쪽). */
export function logLevelOf(options: {
  readonly verbose?: boolean;
  readonly quiet?: boolean;
}): LogLevel {
  return options.verbose ? "verbose" : options.quiet ? "quiet" : "normal";
}
