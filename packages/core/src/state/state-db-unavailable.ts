/**
 * 상태 DB 를 지금 쓸 수 없다 — 사용자가 풀 수 있는 실패다. 파일이 깨졌거나({@link SavedStateDbError}), 다른 곳이
 * 쓰는 중이거나({@link StateDbLockedError}), CLI 가 남긴 기록이 아직 WAL 파일에만 있다({@link PendingWalError}).
 *
 * 할 일(`guidance`)을 같이 싣는다. 엔진을 띄우지 못한 것 같은 다른 실패와 가른다 — 거기에 할 일을 붙이면 멀쩡한
 * 기록을 치우게 된다. 화면(CLI · 플러그인)은 이 종류인지만 보고, 다시 해 보는 법만 넘긴다.
 *
 * @see ./saved-state-db-error.ts
 * @see ./state-lock.ts
 */
export abstract class StateDbUnavailableError extends Error {
  /** 할 일 — 화면마다 다시 해 보는 법(`retry`, 예: 「명령을 다시 실행하세요」)만 다르다. */
  abstract guidance(retry: string): string;
}
