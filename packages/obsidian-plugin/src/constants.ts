/**
 * 플러그인 전용 상수 단일 진실원(SSOT).
 *
 * 공유 내부 경로(`.im-nobsidian` 등)는 `@im-nobsidian/core`의 paths 상수를 사용하고,
 * 이 파일에는 Obsidian 플러그인 런타임에만 의미 있는 값만 둔다.
 */

/**
 * Notion 토큰을 Obsidian 키체인(SecretStorage)에 둘 때 쓰는 이름 — 예전 설정(data.json 의 글자 그대로)을
 * 옮길 때 붙인다. 키체인은 볼트마다 따로다 — 그 볼트의 키체인에 같은 이름으로 다른 토큰이 있으면 번호를 붙인다.
 */
export const TOKEN_SECRET_ID = "im-nobsidian-notion-token";

/**
 * 알림 · 상태 표시줄 글의 머리말. 연결이 여럿이면 플러그인이 이 머리말 바로 뒤에 연결 이름표를 붙인다 —
 * 글이 이것으로 시작해야 붙는다.
 */
export const NOTICE_PREFIX = "Im-Nobsidian";

/** 머리말(과 뒤의 `:` · 빈칸)을 뗀 글 — 설정 화면처럼 이미 플러그인 안에서 보이는 자리에 쓴다. */
export function withoutNoticePrefix(message: string): string {
  if (!message.startsWith(NOTICE_PREFIX)) return message;
  return message.slice(NOTICE_PREFIX.length).replace(/^:? /, "");
}

/** 자동 동기화 간격으로 고를 수 있는 값(분). 설정은 초로 적는다. */
export const AUTO_SYNC_INTERVAL_MINUTES = [1, 5, 10, 15, 30, 60] as const;

/** 원격 전체 확인 주기로 고를 수 있는 값(분). 0 은 Pull 마다. 설정은 초로 적는다 — 엔진 상한은 7일. */
export const FULL_RECONCILE_INTERVAL_MINUTES = [0, 10, 30, 60, 360, 1440, 10080] as const;
