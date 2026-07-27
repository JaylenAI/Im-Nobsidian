/**
 * R11-C 회귀 잠금 — CLI 강제 종료가 명령의 종료 코드를 삼키지 않는다.
 *
 * 결함: `index.ts` 가 parseAsync 후 `process.exit(0)` 을 무조건 호출했다. 각 명령
 * (init·pull·push·sync·resolve)이 실패마다 `process.exitCode = 1` 을 세워 두는데,
 * 인자 0 이 그걸 전부 덮어써 **모든 실패가 종료 코드 0 으로 나갔다** — 셸도 CI 도
 * 실패를 감지할 수 없었다(node 프로브로 실측 확인).
 *
 * 가드 유효성: `proc.exit(0)` 로 되돌리면 첫 두 테스트가 실패한다.
 */
import { describe, it, expect, vi } from "vitest";
import {
  resolveExitCode,
  scheduleForcedExit,
  FORCED_EXIT_DELAY_MS,
  type ExitableProcess,
} from "../../src/utils/exit.js";

/** schedule 을 즉시 실행으로 대체해 타이머 없이 종료 인자를 관찰한다. */
function runNow(proc: ExitableProcess): void {
  scheduleForcedExit(proc, (fn) => fn());
}

describe("R11-C — 강제 종료 시 종료 코드 보존", () => {
  it("명령이 실패를 세워 두면 그 코드로 종료한다", () => {
    const exit = vi.fn();
    runNow({ exitCode: 1, exit });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("0 이 아닌 임의 실패 코드도 그대로 전달한다", () => {
    const exit = vi.fn();
    runNow({ exitCode: 3, exit });
    expect(exit).toHaveBeenCalledWith(3);
  });

  it("코드가 없으면 성공(0)으로 종료한다", () => {
    const exit = vi.fn();
    runNow({ exitCode: undefined, exit });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("지연 후 예약한다 — 마지막 출력 flush 여유", () => {
    const schedule = vi.fn();
    scheduleForcedExit({ exitCode: 1, exit: vi.fn() }, schedule);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), FORCED_EXIT_DELAY_MS);
  });

  describe("resolveExitCode", () => {
    it("숫자는 그대로", () => {
      expect(resolveExitCode(2)).toBe(2);
      expect(resolveExitCode(0)).toBe(0);
    });

    it("숫자 문자열은 숫자로", () => {
      expect(resolveExitCode("1")).toBe(1);
    });

    it("숫자가 아니면 성공(0)", () => {
      expect(resolveExitCode(undefined)).toBe(0);
      expect(resolveExitCode("nope")).toBe(0);
    });
  });
});
