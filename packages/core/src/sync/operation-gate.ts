/**
 * 한 오케스트레이터의 작업은 한 번에 하나만 돈다(S-09).
 *
 * 오케스트레이터는 실행마다 상태를 쥔다 — 원격을 본 시각(N-05 의 `observation`) · 이번 실행이
 * 고른 새 경로(`claimedPaths`) · 준비하지 못한 폴더. 두 실행이 겹치면 뒤 실행이 앞 실행의 것을
 * 덮는다. 앞 pull 이 원격을 본 시각이 뒤로 밀려 그 사이의 Notion 편집을 본 것으로 적고(영영
 * 받지 않는다), 두 실행이 같은 새 경로를 골라 서로의 파일을 덮는다. 플러그인의 수동 · 자동 ·
 * 볼트 이벤트 sync 와 CLI `watch` 의 파일 변경 · 주기 sync 가 이렇게 겹쳤다.
 *
 * 겹친 요청은 기다리게 하지 않고 거절한다. 무엇을 할지는 부른 쪽마다 다르다 — 사용자가 누른
 * 것은 알리고, 자동 sync 는 건너뛰고, 파일 감시는 끝난 뒤 다시 돌린다. 여기서 줄을 세우면
 * 긴 sync(실볼트 pull 500초) 동안 주기 sync 가 쌓인다.
 */

/** 잠그는 작업 — 볼트 · 상태 DB · 원격을 바꾸거나 이번 실행의 기준을 정하는 것. */
export type GatedOperation = "push" | "pull" | "sync" | "status" | "fetch" | "resolve";

/** 사용자에게 보이는 이름 — 내부 코드값을 화면에 내보내지 않는다. */
const OPERATION_LABELS: Readonly<Record<GatedOperation, string>> = {
  push: "Push",
  pull: "Pull",
  sync: "Sync",
  status: "상태 확인",
  fetch: "원격 확인",
  resolve: "충돌 해결",
};

export function operationLabel(operation: GatedOperation): string {
  return OPERATION_LABELS[operation];
}

export class SyncBusyError extends Error {
  constructor(
    /** 이미 도는 작업. */
    readonly running: GatedOperation,
    /** 거절한 작업. */
    readonly requested: GatedOperation,
  ) {
    super(
      `${operationLabel(running)} 이(가) 도는 중이라 ${operationLabel(requested)} 을(를) 시작하지 않았습니다 — 끝난 뒤 다시 시도하세요`,
    );
    this.name = "SyncBusyError";
  }
}

export class OperationGate {
  private current: GatedOperation | null = null;

  /** 도는 작업 — 없으면 null. */
  get running(): GatedOperation | null {
    return this.current;
  }

  /** 도는 작업이 없을 때만 돌린다. 있으면 {@link SyncBusyError} 로 거절한다. */
  async run<T>(operation: GatedOperation, task: () => Promise<T>): Promise<T> {
    this.claim(operation);
    try {
      return await task();
    } finally {
      this.current = null;
    }
  }

  /** 동기 작업용 {@link run}. */
  runSync<T>(operation: GatedOperation, task: () => T): T {
    this.claim(operation);
    try {
      return task();
    } finally {
      this.current = null;
    }
  }

  private claim(operation: GatedOperation): void {
    if (this.current !== null) throw new SyncBusyError(this.current, operation);
    this.current = operation;
  }
}
