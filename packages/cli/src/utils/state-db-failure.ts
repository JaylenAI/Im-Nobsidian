/**
 * 상태 DB 를 쓸 수 없을 때의 CLI 출력 — 이유 뒤에 할 일을 붙인다.
 *
 * 명령은 처음에 상태 DB 를 연다(`StateDB.open`). 파일이 비었거나 잘렸거나(`SavedStateDbError`), 플러그인이 같은
 * 볼트를 쓰는 중이면(`StateDbLockedError`) 던지는데, 명령 밖으로 나오면 Node 가 코드 위치(스택)와 함께 이유만
 * 보였다 — 사용자가 할 일은 어디에도 없었다.
 */
import { StateDbUnavailableError } from "@im-nobsidian/core";
import type { ExitableProcess } from "./exit.js";

/** 실패를 보일 말 — 상태 DB 를 쓸 수 없는 것이면 할 일을 붙이고, 다른 실패는 그 말 그대로다. */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof StateDbUnavailableError)) return message;
  return `${message} — ${error.guidance("명령을 다시 실행하세요")}`;
}

/**
 * 명령 밖으로 나온 실패를 알린다. 상태 DB 를 쓸 수 없는 것은 사용자가 풀 일이라 이유와 할 일만 보이고 실패(1)로
 * 끝낸다. 다른 실패는 그대로 다시 던진다 — 지금까지처럼 Node 가 스택과 함께 보이고 1 로 끝난다.
 */
export function reportStateDbFailure(error: unknown, proc: ExitableProcess): void {
  if (!(error instanceof StateDbUnavailableError)) throw error;
  console.error(`오류: ${describeFailure(error)}`);
  proc.exitCode = 1;
}
