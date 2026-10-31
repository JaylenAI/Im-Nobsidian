/**
 * 상태 DB 를 쓸 수 없을 때의 CLI 출력 — 이유 뒤에 할 일을 붙인다.
 *
 * 명령은 처음에 상태 DB 를 연다(`StateDB.open`). 파일이 비었거나 잘렸거나(`SavedStateDbError`), 플러그인이 같은
 * 볼트를 쓰는 중이면(`StateDbLockedError`) 던지는데, 명령 밖으로 나오면 Node 가 코드 위치(스택)와 함께 이유만
 * 보였다 — 사용자가 할 일은 어디에도 없었다.
 */
import {
  ConnectionBoundaryError,
  ConnectionScopeError,
  StateDbUnavailableError,
  SyncBusyError,
  UnlinkedVaultError,
} from "@im-nobsidian/core";
import type { ExitableProcess } from "./exit.js";

/** 실패를 보일 말 — 상태 DB 를 쓸 수 없는 것이면 할 일을 붙이고, 다른 실패는 그 말 그대로다. */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof StateDbUnavailableError)) return message;
  return `${message} — ${error.guidance("명령을 다시 실행하세요")}`;
}

/**
 * 사용자가 풀 실패 — 말이 할 일을 담는다. 코드 위치(스택)는 도움이 되지 않고 겁만 준다. 예전에는 상태 DB 를 쓸 수 없는 것만
 * 이랬고, 상태 기록을 잃은 볼트의 push 거절(`UnlinkedVaultError`, 「먼저 pull 하세요」)도 스택과 함께 나왔다(0.15 회귀).
 */
function isUserFailure(error: unknown): boolean {
  return (
    error instanceof StateDbUnavailableError ||
    error instanceof UnlinkedVaultError ||
    error instanceof SyncBusyError ||
    error instanceof ConnectionBoundaryError ||
    error instanceof ConnectionScopeError
  );
}

/**
 * 명령 밖으로 나온 실패를 알린다. 사용자가 풀 것({@link isUserFailure})은 이유와 할 일만 보이고 실패(1)로 끝낸다. 다른
 * 실패는 그대로 다시 던진다 — 지금까지처럼 Node 가 스택과 함께 보이고 1 로 끝난다(뜻밖의 실패는 위치가 필요하다).
 */
export function reportUserFailure(error: unknown, proc: ExitableProcess): void {
  if (!isUserFailure(error)) throw error;
  console.error(`오류: ${describeFailure(error)}`);
  proc.exitCode = 1;
}
