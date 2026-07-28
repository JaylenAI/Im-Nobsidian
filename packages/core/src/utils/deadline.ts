/**
 * 항목 1건의 시간 상한 — 동기화 전체가 한 건 때문에 멎지 않게 한다.
 *
 * 개별 네트워크 호출에는 이미 상한이 걸려 있지만(SDK `timeoutMs`, 다운로드
 * `mediaDownloadTimeoutMs`), 한 페이지를 처리하는 경로는 그 호출 수십 개와 변환·파일 IO 가
 * 얽힌 합성 작업이다. 그중 **어느 하나라도** 해결되지 않는 프로미스를 남기면 워커 슬롯이
 * 영구히 묶이고, 슬롯이 다 묶이면 진행 로그조차 멈춘 채 프로세스가 살아만 있게 된다.
 * 이 상태는 겉으로 "동기화가 안 끝난다"로만 보이고, 어느 페이지에서 멎었는지도 알 수 없다.
 *
 * 여기서 하는 일은 그 무한대를 **유한한 실패**로 바꾸는 것뿐이다. 상한을 넘기면 해당 항목만
 * 오류로 끊어 기존 재시도·실패 보고 경로에 태우고, 나머지 항목은 계속 진행한다.
 *
 * 한계는 정직하게 적어 둔다: `Promise.race` 는 느린 작업을 **취소하지 못한다**. 상한을 넘긴
 * 작업은 뒤에서 계속 살아 있거나 영영 끝나지 않고, 그 메모리는 프로세스 종료까지 남는다.
 * 무한 정지 대신 한도가 정해진 누수를 택한 것이며, 그래서 기본값은 정상 작업이 절대 닿지
 * 않을 만큼 넉넉해야 한다(정상 페이지는 초 단위, 기본 상한은 분 단위).
 */

/**
 * 항목 1건 처리의 기본 상한(30분). 설정(`advanced.itemTimeoutMs`)이 전달되지 않는 경로의
 * 폴백이며, 정상 항목이 절대 닿지 않을 만큼 넉넉하게 잡는다 — 상한은 무한 정지를 끊는
 * 안전망이지 성능 SLA 가 아니다.
 */
export const DEFAULT_ITEM_TIMEOUT_MS = 1_800_000;

export class DeadlineExceededError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`시간 상한 초과(${Math.round(timeoutMs / 1000)}초): ${label}`);
    this.name = "DeadlineExceededError";
  }
}

/**
 * @param task      실행할 작업. 상한 계산은 호출 시점부터 시작한다.
 * @param timeoutMs 상한(ms). 0 이하면 상한 없이 그대로 실행한다.
 * @param label     실패 메시지에 실을 식별자(경로·페이지 ID 등) — "어디서 멎었나"의 유일한 단서다.
 */
export async function withDeadline<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    // 작업이 먼저 끝난 경우 타이머를 남기면 그 자체가 프로세스를 붙잡는다.
    if (timer !== undefined) clearTimeout(timer);
  }
}
