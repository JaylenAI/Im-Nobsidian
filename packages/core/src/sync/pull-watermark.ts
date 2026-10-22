/**
 * 증분 pull 의 기준 시각(`last_pull_at`) — 다음 조회를 어디서부터 하고, pull 뒤에 무엇을 적나.
 *
 * 증분 감지는 「기준 시각 − 안전창」 이후에 고친 페이지만 search 로 받는다. 그러므로 기준 시각은
 * «이보다 앞의 원격 변경은 모두 볼트에 받았다» 는 약속이어야 한다. 예전에는 pull 이 «끝난»
 * 시각을 적어, 이번 실행이 받지 못한 변경(재시도까지 실패 · 중단으로 건너뜀)과 긴 pull 도중의
 * 편집이 다음 조회 창 밖으로 밀려 원격에서 다시 고치기 전까지 영영 빠졌다.
 */
import type { RemoteChange } from "../types/sync.js";

/**
 * 증분 조회 안전창(F20). Notion search 는 인덱싱 지연이 있어 생성 직후 페이지가 결과에 안
 * 잡히는데, 기준 시각을 그대로 쓰면 다음 pull 부터 last_edited < since 로 영원히 제외된다
 * (실측 재현: 신규 하위 페이지가 편집 전까지 3회 연속 미발견). 이 창만큼 되돌려 조회하면
 * 지연 인덱싱분을 다음 pull 이 회수한다.
 */
const INCREMENTAL_SAFETY_WINDOW_MS = 15 * 60_000;

/** 증분 조회를 시작할 시각 — 기준 시각에서 안전창만큼 되돌린다. 읽을 수 없는 값은 그대로 쓴다. */
export function incrementalSearchSince(watermark: string): string {
  const ms = Date.parse(watermark);
  return Number.isFinite(ms)
    ? new Date(ms - INCREMENTAL_SAFETY_WINDOW_MS).toISOString()
    : watermark;
}

/**
 * pull 이 끝난 뒤 적을 기준 시각.
 *
 * - pull 을 **시작한** 시각이 기본이다. 조회가 끝난 뒤 고친 페이지는 다음 조회가 받는다.
 * - 이번 실행이 받지 못한 변경이 있으면 그중 가장 이른 수정 시각으로 묶어 둔다 — 다음 조회
 *   창이 그 변경을 다시 보도록. 받을 때까지 매번 다시 시도하고 매번 실패로 보고된다.
 * - 삭제는 묶지 않는다. 증분 조회는 휴지통 페이지를 보지 못해 삭제는 전체 대조로만 잡힌다.
 */
export function nextPullWatermark(startedAt: string, unapplied: readonly RemoteChange[]): string {
  let earliest = Date.parse(startedAt);
  for (const change of unapplied) {
    if (change.type === "deleted") continue;
    const edited = Date.parse(change.lastEdited);
    if (Number.isFinite(edited) && edited < earliest) earliest = edited;
  }
  return new Date(earliest).toISOString();
}
