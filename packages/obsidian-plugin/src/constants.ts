/**
 * 플러그인 전용 상수 단일 진실원(SSOT).
 *
 * 공유 내부 경로(`.im-nobsidian` 등)는 `@im-nobsidian/core`의 paths 상수를 사용하고,
 * 이 파일에는 Obsidian 플러그인 런타임에만 의미 있는 값만 둔다.
 */

/**
 * Notion 토큰을 Obsidian 키체인(SecretStorage)에 둘 때 쓰는 이름 — 예전 설정(data.json 의 글자 그대로)을
 * 옮길 때 붙인다. 키체인은 이 기기의 모든 볼트가 함께 쓰므로, 같은 이름에 다른 토큰이 있으면 번호를 붙인다.
 */
export const TOKEN_SECRET_ID = "im-nobsidian-notion-token";

/** 자동 동기화 간격으로 고를 수 있는 값(분). 설정은 초로 적는다. */
export const AUTO_SYNC_INTERVAL_MINUTES = [1, 5, 10, 15, 30, 60] as const;
