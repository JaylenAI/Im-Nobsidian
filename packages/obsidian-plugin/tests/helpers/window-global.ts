/**
 * Obsidian 에서 플러그인 코드의 `window` 는 그 창의 전역(`globalThis`)이다. 플러그인은 팝아웃 창 호환을 위해
 * 타이머 · 전역을 `window` 로 부른다(디렉터리 리뷰 규칙). node 시험 환경에는 `window` 가 없어 같은 전역을 잇는다 —
 * 가짜 타이머(`vi.useFakeTimers`)가 바꾼 함수도 그대로 보인다.
 */
(globalThis as { window?: unknown }).window ??= globalThis;
