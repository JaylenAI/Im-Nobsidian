import { describe, it, expect, afterEach } from "vitest";
import { announceStateDbClose, previousStateDbClosed } from "../../src/state/state-db-handoff.js";

/** 다시 불러온 인스턴스가 기다리는 동안 다른 일이 끼어들 틈. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 끝낼 때를 시험이 정하는 닫기. */
function closing() {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, finish, fail };
}

/** 기다림이 끝났는지 본다. */
function watch(promise: Promise<void>): { done: boolean } {
  const state = { done: false };
  void promise.then(() => (state.done = true));
  return state;
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("im-nobsidian/state-db-closing")];
});

describe("다시 불러온 플러그인의 상태 DB 넘겨받기", () => {
  it("앞 인스턴스가 없으면 바로 연다", async () => {
    await expect(previousStateDbClosed()).resolves.toBeUndefined();
  });

  it("앞 인스턴스가 닫기를 마칠 때까지 기다린다", async () => {
    const old = closing();
    announceStateDbClose(old.promise);

    const waiting = watch(previousStateDbClosed());
    await tick();
    expect(waiting.done).toBe(false);

    old.finish();
    await tick();
    expect(waiting.done).toBe(true);
  });

  it("앞 인스턴스가 닫다가 실패해도 연다 — 실패 이유는 닫는 쪽이 알린다", async () => {
    const old = closing();
    announceStateDbClose(old.promise);
    old.fail(new Error("권한 없음"));

    await expect(previousStateDbClosed()).resolves.toBeUndefined();
  });

  it("거듭 다시 불러오면 앞 인스턴스들이 모두 닫힌 뒤에 연다", async () => {
    const first = closing();
    const second = closing();
    announceStateDbClose(first.promise);
    announceStateDbClose(second.promise);

    const waiting = watch(previousStateDbClosed());
    second.finish();
    await tick();
    expect(waiting.done).toBe(false);

    first.finish();
    await tick();
    expect(waiting.done).toBe(true);
  });
});
