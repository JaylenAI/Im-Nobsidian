/**
 * 저장된 상태 DB 파일이 깨졌을 때의 CLI 출력 — 이유 뒤에 치우는 법을 붙이고, 다른 실패는 건드리지 않는다.
 *
 * 예전에는 명령 밖으로 나온 `SavedStateDbError` 를 Node 가 스택과 함께 이유만 보였다 — 무엇을 해야 하는지는
 * 어디에도 없었다. 사용자가 보는 문구를 그대로 본다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { SavedStateDbError } from "@im-nobsidian/core";
import { describeFailure, reportStateDbFailure } from "../../src/utils/state-db-failure.js";

const GUIDED =
  "저장된 상태 DB 파일에 동기화 기록이 없음 (0바이트) — 볼트 폴더의 .im-nobsidian/sync.db 를 사본으로 바꾸거나 " +
  "다른 곳으로 옮긴 뒤 명령을 다시 실행하세요. 옮기면 처음부터 시작합니다 — 노트와 Notion 페이지의 짝을 잃어 " +
  "다음 push 가 페이지를 새로 만듭니다.";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeFailure", () => {
  it("저장된 상태 DB 파일 탓이면 이유 뒤에 치우는 법을 붙인다", () => {
    expect(describeFailure(SavedStateDbError.noTables(0))).toBe(GUIDED);
  });

  it("다른 실패는 그 말 그대로다 — 파일을 치우라고 하지 않는다", () => {
    expect(describeFailure(new Error("설정 파일이 없음"))).toBe("설정 파일이 없음");
    expect(describeFailure("문자열로 던진 실패")).toBe("문자열로 던진 실패");
  });
});

describe("reportStateDbFailure", () => {
  it("저장된 상태 DB 파일 탓이면 이유와 치우는 법만 보이고 1 로 끝낸다", () => {
    const print = vi.spyOn(console, "error").mockImplementation(() => {});
    const proc = { exitCode: undefined as number | undefined, exit: vi.fn() };

    reportStateDbFailure(SavedStateDbError.noTables(0), proc);

    expect(print.mock.calls).toEqual([[`오류: ${GUIDED}`]]);
    expect(proc.exitCode).toBe(1);
  });

  it("다른 실패는 그대로 다시 던진다 — 지금까지처럼 Node 가 보이고 1 로 끝난다", () => {
    const print = vi.spyOn(console, "error").mockImplementation(() => {});
    const proc = { exitCode: undefined as number | undefined, exit: vi.fn() };
    const failure = new Error("설정 파일이 없음");

    const thrown = (() => {
      try {
        reportStateDbFailure(failure, proc);
      } catch (error) {
        return error;
      }
      return "던지지 않음";
    })();

    // 같은 객체다 — 감싸면 Node 가 보이는 스택이 이 함수 자리로 바뀐다
    expect(thrown).toBe(failure);
    expect(print).not.toHaveBeenCalled();
    expect(proc.exitCode).toBeUndefined();
  });
});
