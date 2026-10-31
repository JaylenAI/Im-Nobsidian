import type { Logger } from "@im-nobsidian/core";

/** 엔진이 낸 경고 · 오류 로그 한 줄. */
export interface WarningLogEntry {
  readonly at: string;
  readonly level: "warn" | "error";
  readonly message: string;
}

/** 모아 두는 줄 수 — 넘으면 오래된 것부터 버린다. */
export const WARNING_LOG_LIMIT = 100;

/**
 * 로그 한 줄을 사람이 읽는 글로 — 머리말(`[Im-Nobsidian]` · `[DB Sync]`)을 떼고, 함께 넘긴 오류는 그 사유만 붙인다. 오류
 * 객체를 통째로 적으면 응답 헤더까지 쏟아져 사유가 묻힌다.
 */
export function warningText(message: string, args: readonly unknown[]): string {
  const reasons = args.map((arg) => (arg instanceof Error ? arg.message : null)).filter(Boolean);
  const text = message.replace(/^\[[^\]]+\]\s*/, "");
  return reasons.length > 0 ? `${text} ${reasons.join(" · ")}` : text;
}

/**
 * 엔진의 경고 · 오류 로그를 `into` 에도 모으는 로거 — 콘솔(`base`)에는 그대로 낸다. CLI 는 경고를 기본으로 보이지만 플러그인은
 * 개발자 콘솔에만 남아, 올리지 · 받지 못한 첨부 · 접근할 수 없는 DB 같은 사정을 사용자가 볼 곳이 없었다. 「동기화 기록」 이 보인다.
 */
export function collectingLogger(
  base: Logger,
  into: WarningLogEntry[],
  limit = WARNING_LOG_LIMIT,
): Logger {
  const keep = (level: WarningLogEntry["level"], message: string, args: unknown[]) => {
    into.push({ at: new Date().toISOString(), level, message: warningText(message, args) });
    if (into.length > limit) into.splice(0, into.length - limit);
  };
  return {
    warn: (message, ...args) => {
      base.warn(message, ...args);
      keep("warn", message, args);
    },
    error: (message, ...args) => {
      base.error(message, ...args);
      keep("error", message, args);
    },
    info: (message, ...args) => base.info(message, ...args),
    debug: (message, ...args) => base.debug(message, ...args),
  };
}
