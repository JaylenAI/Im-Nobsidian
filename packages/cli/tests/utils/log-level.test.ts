/**
 * 전역 `--verbose` · `--quiet` (P8) — 예전에는 받기만 하고 쓰지 않아, 엔진의 정보 로그가 늘 화면에 나와 명령의 결과와 같은 말을
 * 두 번 했다(실측: 「[Im-Nobsidian] DB 의 행으로 옮김: …」 과 「✓ Notion 에서 DB 의 행으로 옮겼습니다 — …」).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getLogger, setLogger } from "@im-nobsidian/core";
import { applyLogLevel, currentLogLevel, logLevelOf } from "../../src/utils/log-level.js";

const original = getLogger();

afterEach(() => {
  setLogger(original);
  applyLogLevel("normal");
  vi.restoreAllMocks();
});

/** 지금 로거로 네 수준을 한 번씩 쓰고, 콘솔에 나간 수준을 돌려준다. */
function emitted(): string[] {
  const seen: string[] = [];
  for (const method of ["error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(() => seen.push(method));
  }
  const logger = getLogger();
  logger.error("e");
  logger.warn("w");
  logger.info("i");
  logger.debug("d");
  return seen;
}

describe("applyLogLevel", () => {
  it("기본은 경고 · 오류만 — 무엇을 했는지는 명령의 결과가 말한다", () => {
    applyLogLevel("normal");
    expect(emitted()).toEqual(["error", "warn"]);
  });

  it("--verbose 는 정보 · 디버그 로그도", () => {
    applyLogLevel("verbose");
    expect(emitted()).toEqual(["error", "warn", "info", "debug"]);
  });

  it("--quiet 는 오류만", () => {
    applyLogLevel("quiet");
    expect(emitted()).toEqual(["error"]);
  });

  it("sink 를 주면 수준은 지키고 그곳으로 쓴다 — --json 이 로그를 표준오류로 돌릴 때", () => {
    applyLogLevel("normal");
    const sink = vi.fn();
    applyLogLevel(currentLogLevel(), sink);
    const logger = getLogger();
    logger.warn("w");
    logger.info("i");
    expect(sink.mock.calls).toEqual([["w"]]);
    expect(currentLogLevel()).toBe("normal");
  });
});

describe("logLevelOf", () => {
  it("둘 다 주면 더 많이 보이는 --verbose 가 이긴다", () => {
    expect(logLevelOf({})).toBe("normal");
    expect(logLevelOf({ quiet: true })).toBe("quiet");
    expect(logLevelOf({ verbose: true, quiet: true })).toBe("verbose");
  });
});
