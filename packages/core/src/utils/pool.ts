/**
 * 취소 신호. `AbortSignal` 과 호환되며, 테스트에서 가벼운 목 객체로도 쓸 수 있다.
 */
export interface AbortLike {
  readonly aborted: boolean;
}

export interface PoolOptions {
  /** 동시에 동작할 최대 worker 수. 1 미만이면 1로 보정한다. */
  readonly concurrency: number;
  /** 설정되면 `aborted === true` 인 순간부터 새 항목 처리를 멈춘다. */
  readonly signal?: AbortLike;
}

/**
 * 고정 크기 워커 풀로 항목들을 처리한다.
 *
 * `items.map((x) => doAsync(x))` 나 `Promise.all(tasks.map((t) => t()))` 방식은
 * 입력 개수(N)만큼의 Promise 를 한꺼번에 생성해 모두 메모리에 띄운다. 동시 실행은
 * 세마포어로 제한하더라도 "대기 중인 N개의 Promise + 클로저"가 그대로 상주하므로
 * 페이지 수가 많아질수록 메모리가 선형으로 늘어난다.
 *
 * `runPool` 은 정확히 `concurrency` 개의 worker 만 띄우고, 각 worker 가 공유 커서에서
 * 다음 인덱스를 꺼내 순차적으로 소비한다. 따라서 동시에 살아 있는 작업 Promise 가
 * 항상 `concurrency` 개로 일정하게 유지된다(백프레셔). 동시성 수준은 기존
 * 세마포어 방식과 동일하지만 메모리 사용이 입력 크기와 무관해진다.
 *
 * worker 가 throw 해도 해당 항목만 건너뛰고 풀은 계속 진행한다(한 건의 실패가
 * 전체를 중단시키지 않음). 실패 기록·재시도는 호출자(worker 내부)에서 담당한다.
 *
 * @param items   처리할 항목 (읽기 전용 — 풀이 변형하지 않는다).
 * @param worker  각 항목을 처리하는 비동기 함수. `index` 는 원본 배열에서의 위치.
 * @param options 동시성·취소 옵션.
 */
export async function runPool<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  options: PoolOptions,
): Promise<void> {
  const total = items.length;
  if (total === 0) return;

  const workerCount = Math.max(1, Math.min(Math.floor(options.concurrency) || 1, total));
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    // cursor 읽기→증가는 await 사이에서 원자적이므로(단일 스레드 이벤트 루프)
    // 두 worker 가 같은 인덱스를 가져가지 않는다.
    for (;;) {
      if (options.signal?.aborted) return;
      const index = cursor++;
      if (index >= total) return;
      try {
        await worker(items[index]!, index);
      } catch {
        // worker 내부에서 실패를 직접 기록한다. 풀은 다음 항목으로 계속 진행.
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}
