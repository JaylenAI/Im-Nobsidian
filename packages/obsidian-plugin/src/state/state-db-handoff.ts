/**
 * 플러그인을 다시 불러올 때(업데이트 · 끄고 켜기) 옛 인스턴스가 상태 DB 를 다 닫은 뒤에 새 인스턴스가 여는 자리.
 *
 * Obsidian 은 onunload 의 비동기 일을 기다리지 않는다. 옛 인스턴스는 도는 작업을 멈추고 DB 의 남은 쓰기를 마친
 * 뒤에 닫는데, 새 인스턴스는 그 전에 파일을 읽을 수 있다. 옛 파일을 읽은 새 인스턴스는 다음 쓰기로 옛 인스턴스의
 * 마지막 기록을 덮는다 — 만든 페이지의 기록이 사라지면 다음 push 가 같은 페이지를 또 만든다.
 *
 * 두 인스턴스는 main.js 를 따로 평가해 모듈 변수를 나누지 못한다. 창의 전역에 «닫는 중» 을 둔다 — 전역은
 * 창(볼트)마다 따로다.
 */
const CLOSING = Symbol.for("im-nobsidian/state-db-closing");

interface ClosingRegistry {
  [CLOSING]?: Promise<void>;
}

/** 상태 DB 를 닫는 일을 알린다. 닫다가 실패해도 다음 인스턴스는 그 뒤에 연다 — 실패 이유는 닫는 쪽이 알린다. */
export function announceStateDbClose(closing: Promise<void>): void {
  const registry = globalThis as ClosingRegistry;
  const earlier = registry[CLOSING] ?? Promise.resolve();
  registry[CLOSING] = Promise.allSettled([earlier, closing]).then(() => undefined);
}

/** 앞 인스턴스들이 상태 DB 를 다 닫을 때까지 기다린다 — 없으면 바로 끝난다. */
export function previousStateDbClosed(): Promise<void> {
  return (globalThis as ClosingRegistry)[CLOSING] ?? Promise.resolve();
}
