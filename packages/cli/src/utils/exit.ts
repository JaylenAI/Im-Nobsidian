/**
 * CLI 종료 처리 — 남은 핸들 때문에 강제 종료하되, **명령이 정한 종료 코드는 보존한다**.
 *
 * better-sqlite3 핸들과 rate limiter 타이머가 이벤트 루프를 붙잡고 있어 명령이 끝나도
 * 프로세스가 자연 종료되지 않는다. 그래서 짧은 지연 뒤 강제 종료하는데, 여기서 코드를
 * 0 으로 못박으면 각 명령이 실패마다 세워 둔 `process.exitCode = 1`
 * (init·pull·push·sync·resolve·verify)이 **전부 지워진다** — 실패한 실행도 셸과 CI 에는
 * 성공으로 보이고, 종료 코드로 판정하는 스크립트는 아무것도 못 잡는다(R11-C).
 *
 * 종료 코드 결정을 이 함수 하나에 두어, "강제 종료한다"와 "성공으로 종료한다"가 다시
 * 한 줄에 섞이지 않게 한다.
 */

/** 강제 종료까지의 지연 — 마지막 stdout flush 여유. */
export const FORCED_EXIT_DELAY_MS = 100;

/**
 * {@link scheduleForcedExit} 가 쓰는 프로세스 표면(테스트 대역 주입용).
 *
 * `exitCode` 는 Node 의 `process.exitCode` 를 그대로 받는다 — 명시적으로 지운 경우
 * `null` 이 될 수 있어 그 유니온까지 포함해야 실제 `process` 를 넘길 수 있다.
 */
export interface ExitableProcess {
  exitCode?: number | string | null | undefined;
  exit(code?: number): void;
}

/** `process.exitCode` 를 종료 코드로 정규화한다. 숫자가 아니면 성공(0). */
export function resolveExitCode(exitCode: number | string | null | undefined): number {
  if (typeof exitCode === "number") return exitCode;
  if (typeof exitCode === "string") {
    const parsed = Number(exitCode);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** 지연 후 강제 종료를 예약한다 — 종료 코드는 명령이 세운 값을 그대로 쓴다. */
export function scheduleForcedExit(
  proc: ExitableProcess,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): void {
  schedule(() => proc.exit(resolveExitCode(proc.exitCode)), FORCED_EXIT_DELAY_MS);
}
