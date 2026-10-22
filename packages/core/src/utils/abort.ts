/**
 * 사용자가 취소한 작업을 멈춘다 — 실패가 아니다.
 *
 * 원격을 훑는 동안(페이지 순회 · search) 취소를 보지 않으면, 취소한 뒤에도 그 훑기가 끝날 때까지 —
 * 실볼트에서 분 단위 — 요청을 계속 보낸다. 훑는 쪽은 {@link throwIfAborted} 로 멈추고, 부른 쪽이
 * {@link OperationAbortedError} 를 받아 그때까지 한 것만 남기고 조용히 끝낸다.
 */
import type { AbortLike } from "./pool.js";

export class OperationAbortedError extends Error {
  constructor() {
    super("취소됨");
    this.name = "OperationAbortedError";
  }
}

/** 취소됐으면 {@link OperationAbortedError} 를 던진다. */
export function throwIfAborted(signal: AbortLike | undefined): void {
  if (signal?.aborted) throw new OperationAbortedError();
}
