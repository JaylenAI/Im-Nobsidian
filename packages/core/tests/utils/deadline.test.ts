/**
 * R9b — 항목 단위 시간 상한.
 *
 * 한 페이지 처리에 걸린 해결되지 않는 프로미스 하나가 워커 슬롯을 영구히 묶으면,
 * 슬롯이 다 묶히는 순간 진행 로그까지 멈춘 채 프로세스만 살아 있게 된다. 여기서는
 * 그 무한대가 **유한한 실패**로 바뀌는지, 그리고 나머지 항목이 계속 진행되는지를 잠근다.
 */
import { describe, it, expect, vi } from "vitest";

import { withDeadline, DeadlineExceededError } from "../../src/utils/deadline.js";
import { runPool } from "../../src/utils/pool.js";

/** 절대 끝나지 않는 작업 — 상한이 없으면 테스트 자체가 hang 으로 드러난다. */
const never = () => new Promise<never>(() => {});

describe("withDeadline", () => {
  it("상한 안에 끝나면 결과를 그대로 돌려준다", async () => {
    await expect(withDeadline(() => Promise.resolve("ok"), 1000, "작업")).resolves.toBe("ok");
  });

  it("작업이 던진 오류는 그대로 전파한다 (상한이 오류를 삼키지 않음)", async () => {
    await expect(
      withDeadline(() => Promise.reject(new Error("원래 오류")), 1000, "작업"),
    ).rejects.toThrow("원래 오류");
  });

  it("끝나지 않는 작업은 상한에서 DeadlineExceededError 로 끊는다", async () => {
    const error = await withDeadline(never, 30, "pull 어떤 페이지.md").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeadlineExceededError);
    // 멈춘 지점을 알려주는 라벨이 메시지에 남아야 한다 — 이게 유일한 단서다.
    expect((error as Error).message).toContain("pull 어떤 페이지.md");
    expect((error as Error).message).toContain("시간 상한 초과");
  });

  it("상한 0 이하는 상한 없음 — 작업을 그대로 실행한다", async () => {
    await expect(withDeadline(() => Promise.resolve(1), 0, "작업")).resolves.toBe(1);
    await expect(withDeadline(() => Promise.resolve(2), -1, "작업")).resolves.toBe(2);
  });

  it("작업이 먼저 끝나면 타이머를 남기지 않는다", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await withDeadline(() => Promise.resolve("ok"), 60_000, "작업");
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe("runPool + withDeadline — 한 건이 전체를 멈춰 세우지 않는다", () => {
  it("멈춘 항목은 실패로 기록되고 나머지는 모두 처리된다", async () => {
    const done: string[] = [];
    const failed: string[] = [];
    const items = ["a", "STUCK", "c", "d"];

    await runPool(
      items,
      async (item) => {
        try {
          await withDeadline(
            () => (item === "STUCK" ? never() : Promise.resolve()),
            30,
            `pull ${item}`,
          );
          done.push(item);
        } catch (error) {
          failed.push((error as Error).message);
        }
      },
      { concurrency: 2 },
    );

    expect(done).toEqual(["a", "c", "d"]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("pull STUCK");
  });

  it("모든 슬롯이 멈춰도 풀은 끝난다 (동시성 전부 소진 시나리오)", async () => {
    const failed: string[] = [];

    await runPool(
      ["x", "y"],
      async (item) => {
        try {
          await withDeadline(never, 30, `pull ${item}`);
        } catch (error) {
          failed.push((error as Error).message);
        }
      },
      { concurrency: 2 },
    );

    expect(failed).toHaveLength(2);
  });
});
