/**
 * 엔진 경고 모으기(P8) — 플러그인은 엔진 로그를 개발자 콘솔에만 남겨, 올리지 · 받지 못한 첨부 같은 사정을 볼 곳이 없었다.
 */
import { describe, it, expect, vi } from "vitest";
import { collectingLogger, warningText, type WarningLogEntry } from "../../src/sync/warning-log.js";

function baseLogger() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe("warningText", () => {
  it("머리말을 떼고, 함께 넘긴 오류는 사유만 붙인다", () => {
    expect(warningText("[Im-Nobsidian] 파일 업로드 중 오류:", [new Error("Notion 400")])).toBe(
      "파일 업로드 중 오류: Notion 400",
    );
    expect(warningText("머리말 없음", [{ headers: "긴 응답" }])).toBe("머리말 없음");
  });
});

describe("collectingLogger", () => {
  it("경고 · 오류만 모으고 모두 원래 로거로도 보낸다", () => {
    const base = baseLogger();
    const into: WarningLogEntry[] = [];
    const logger = collectingLogger(base, into);
    logger.warn("[Im-Nobsidian] 경고", 1);
    logger.error("오류");
    logger.info("정보");
    logger.debug("디버그");

    expect(into.map(({ level, message }) => [level, message])).toEqual([
      ["warn", "경고"],
      ["error", "오류"],
    ]);
    expect(base.warn).toHaveBeenCalledWith("[Im-Nobsidian] 경고", 1);
    expect(base.info).toHaveBeenCalledWith("정보");
    expect(base.debug).toHaveBeenCalledWith("디버그");
  });

  it("상한을 넘으면 오래된 것부터 버린다", () => {
    const into: WarningLogEntry[] = [];
    const logger = collectingLogger(baseLogger(), into, 2);
    for (const n of [1, 2, 3]) logger.warn(`경고 ${n}`);
    expect(into.map((e) => e.message)).toEqual(["경고 2", "경고 3"]);
  });
});
