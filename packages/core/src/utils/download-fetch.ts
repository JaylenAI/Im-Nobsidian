/**
 * 미디어·첨부 다운로드용 `fetch` — **반드시 시간 상한을 건다**.
 *
 * 상한이 없으면 응답이 오다 멈춘 연결(만료된 S3 프리사인 URL·중간 프록시 끊김)에서
 * `fetch` 가 영원히 매달리고, 그 자리에서 동기화 전체가 멎는다. 이때 프로세스는
 * 대기 타이머도 열린 소켓도 없이 이벤트 루프만 살아 있어 겉으로는 "그냥 안 끝나는"
 * 상태가 된다 — 재시도 루프도 예외가 나야 도는 것이라 함께 멈춘다.
 *
 * 신호는 헤더뿐 아니라 본문 스트림까지 덮으므로 `arrayBuffer()` 도중 정지도 함께 끊긴다.
 * `AbortSignal` 은 재사용할 수 없으므로 호출(재시도 포함)마다 새로 만든다.
 *
 * 다운로드 경로가 이미지·첨부 두 갈래라 각자 상한을 걸면 한쪽만 빠뜨리기 쉽다.
 * 실제로 첨부 경로가 오래 무방비였다 — 그래서 상한 로직을 여기 한 곳에 둔다.
 */

/** 기본 상한. 상한 파일 크기(기본 100MB)를 초당 340KB 로도 받아낼 수 있는 여유값. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;

/**
 * @param fetchFn   사용할 fetch 구현(테스트 주입용). 생략 시 전역 fetch.
 * @param url       다운로드 URL.
 * @param timeoutMs 상한(ms). 0 이하면 상한 없이 호출한다(테스트·특수 환경 탈출구).
 */
export function fetchForDownload(
  fetchFn: typeof globalThis.fetch,
  url: string,
  timeoutMs: number = DEFAULT_DOWNLOAD_TIMEOUT_MS,
): ReturnType<typeof globalThis.fetch> {
  if (timeoutMs <= 0) return fetchFn(url);
  return fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
}
