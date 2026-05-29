import { describe, it, expect } from "vitest";
import { runPool } from "../../src/utils/pool.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("runPool", () => {
  it("모든 항목을 정확히 한 번씩 처리한다", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];

    await runPool(
      items,
      async (item) => {
        await tick();
        seen.push(item);
      },
      { concurrency: 4 },
    );

    expect(seen).toHaveLength(50);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("동시 실행 수가 concurrency 를 넘지 않는다(백프레셔)", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    let active = 0;
    let peak = 0;

    await runPool(
      items,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      },
      { concurrency: 5 },
    );

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1); // 실제로 병렬 실행되었는지 확인
  });

  it("worker 가 throw 해도 나머지 항목을 계속 처리한다", async () => {
    const items = [0, 1, 2, 3, 4];
    const done: number[] = [];

    await runPool(
      items,
      async (item) => {
        if (item === 2) throw new Error("boom");
        done.push(item);
      },
      { concurrency: 2 },
    );

    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 3, 4]);
  });

  it("signal.aborted 가 되면 새 항목 처리를 멈춘다", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const signal = { aborted: false };
    let processed = 0;

    await runPool(
      items,
      async () => {
        processed++;
        if (processed >= 6) signal.aborted = true;
        await tick();
      },
      { concurrency: 3, signal },
    );

    // 정확한 수는 스케줄링에 따라 다르지만, 전체를 다 돌지는 않아야 한다.
    expect(processed).toBeLessThan(items.length);
    expect(processed).toBeGreaterThanOrEqual(6);
  });

  it("빈 입력은 아무 일도 하지 않는다", async () => {
    let called = 0;
    await runPool(
      [],
      async () => {
        called++;
      },
      { concurrency: 4 },
    );
    expect(called).toBe(0);
  });

  it("concurrency 가 항목 수보다 크면 항목 수만큼만 worker 를 띄운다", async () => {
    const items = [0, 1, 2];
    let peak = 0;
    let active = 0;
    await runPool(
      items,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      },
      { concurrency: 10 },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("concurrency 가 0/음수여도 최소 1 worker 로 동작한다", async () => {
    const items = [0, 1, 2];
    const done: number[] = [];
    await runPool(
      items,
      async (item) => {
        done.push(item);
      },
      { concurrency: 0 },
    );
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("worker 에 원본 인덱스를 전달한다", async () => {
    const items = ["a", "b", "c"];
    const pairs: Array<[string, number]> = [];
    await runPool(
      items,
      async (item, index) => {
        pairs.push([item, index]);
      },
      { concurrency: 1 },
    );
    expect(pairs).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });
});
