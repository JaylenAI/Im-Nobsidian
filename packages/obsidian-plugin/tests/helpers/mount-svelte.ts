import { mount, unmount, flushSync } from "svelte";
import type { Component } from "svelte";

/**
 * happy-dom 환경에서 Svelte 5 컴포넌트를 실제 마운트하는 테스트 헬퍼.
 *
 * I9(UIUX) 불변식 검증용 — 동기화 데이터가 컴포넌트를 통해 충실하게 DOM 으로
 * 렌더되는지, 상태(진행률/에러/충돌) 표시가 일관적인지를 실제 렌더 결과로 단언한다.
 * `flush()` 는 `$state`/`$derived` 갱신을 동기 적용해 인터랙션 후 DOM 을 즉시 검증하게 한다.
 */
export interface Mounted {
  /** 컴포넌트가 마운트된 컨테이너. querySelector 로 DOM 을 단언한다. */
  readonly target: HTMLElement;
  /** $state/$derived 반영을 동기 flush. 클릭 등 인터랙션 후 호출. */
  flush(): void;
  /** 마운트 해제(테스트 종료 정리). */
  destroy(): void;
}

export function renderComponent<P extends Record<string, unknown>>(
  component: Component<any> | unknown,
  props: P,
): Mounted {
  const target = document.createElement("div");
  document.body.appendChild(target);

  const instance = mount(component as Component<P>, { target, props });
  flushSync();

  return {
    target,
    flush: () => flushSync(),
    destroy: () => {
      unmount(instance);
      target.remove();
    },
  };
}

/** 텍스트 정규화(공백 압축) — 마크업 들여쓰기/개행에 둔감하게 단언. */
export function normText(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}
