/**
 * R9 — 재시도의 관측성과 슬롯 점유.
 *
 * 268페이지 pull 이 진행 로그가 멈춘 채 수 분씩 정지하던 원인이 여기였다. 재시도 백오프를
 * rate limit 슬롯을 **쥔 채** 기다린 탓에 불운한 요청 3건(동시성 기본값)이면 클라이언트
 * 전체가 멈췄고, 재시도는 로그를 한 줄도 남기지 않아 죽은 프로세스와 구분되지 않았다.
 *
 * 그래서 세 가지를 잠근다:
 *   1. 모든 재시도는 시도 횟수·대기시간·사유를 경고로 남긴다(운영자의 유일한 단서).
 *   2. 백오프 대기 중에는 슬롯을 반납한다 — 남의 요청을 막지 않는다.
 *   3. 단, 429 는 워크스페이스 전체 신호이므로 전역 쿨다운으로 **함께** 쉰다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { NotionClient, describeRetryCause } from "../../src/notion/client.js";
import { setLogger, type Logger } from "../../src/utils/logger.js";

/** SDK 오류 흉내 — isRetryable 은 status/code 만 본다. */
function apiError(status: number, extra?: { retryAfter?: string; code?: string }): Error {
  const error = new Error(`HTTP ${status}`) as Error & Record<string, unknown>;
  error.status = status;
  if (extra?.code) error.code = extra.code;
  if (extra?.retryAfter) error.headers = { "retry-after": extra.retryAfter };
  return error;
}

/** 페이지 ID 별로 응답을 다르게 주는 pages.retrieve 스텁을 심는다. */
function stubRetrieve(client: NotionClient, impl: (pageId: string) => Promise<unknown>) {
  const retrieve = vi.fn(({ page_id }: { page_id: string }) => impl(page_id));
  (client as unknown as { client: { pages: unknown } }).client.pages = { retrieve };
  return retrieve;
}

let warnings: string[] = [];
const captureLogger: Logger = {
  warn: (msg) => warnings.push(msg),
  error: () => {},
  info: () => {},
  debug: () => {},
};

beforeEach(() => {
  warnings = [];
  setLogger(captureLogger);
});

afterEach(() => {
  setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
});

describe("재시도 관측성 — 조용한 정지 금지", () => {
  it("재시도마다 시도 횟수·대기시간·사유를 경고로 남긴다", async () => {
    const client = new NotionClient({
      token: "ntn_test_fake_token",
      concurrency: 1,
      maxRetries: 3,
      retryBaseDelayMs: 10,
      rateLimitIntervalMs: 0,
    });
    let calls = 0;
    stubRetrieve(client, () => {
      calls += 1;
      return calls <= 2 ? Promise.reject(apiError(503)) : Promise.resolve({ id: "p1" });
    });

    await client.getPage("p1");

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("재시도 1/3");
    expect(warnings[1]).toContain("재시도 2/3");
    // 얼마나 기다리는지·왜 기다리는지가 모두 보여야 한다.
    expect(warnings[0]).toMatch(/\d+ms 대기/);
    expect(warnings[0]).toContain("status 503");
  });

  it("재시도 불가 오류는 즉시 던지고 재시도 로그를 남기지 않는다", async () => {
    const client = new NotionClient({
      token: "ntn_test_fake_token",
      concurrency: 1,
      rateLimitIntervalMs: 0,
    });
    stubRetrieve(client, () => Promise.reject(apiError(404, { code: "object_not_found" })));

    await expect(client.getPage("p1")).rejects.toThrow("HTTP 404");
    expect(warnings).toHaveLength(0);
  });

  it("재시도 한도를 넘으면 마지막 오류를 그대로 던진다", async () => {
    const client = new NotionClient({
      token: "ntn_test_fake_token",
      concurrency: 1,
      maxRetries: 2,
      retryBaseDelayMs: 5,
      rateLimitIntervalMs: 0,
    });
    const retrieve = stubRetrieve(client, () => Promise.reject(apiError(502)));

    await expect(client.getPage("p1")).rejects.toThrow("HTTP 502");
    // 최초 1회 + 재시도 2회
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(warnings).toHaveLength(2);
  });
});

describe("백오프 중 슬롯 점유 — 한 요청이 클라이언트 전체를 멈추지 않는다", () => {
  it("백오프 대기 중에는 슬롯을 반납한다 (동시성 1에서도 뒤 요청이 먼저 끝남)", async () => {
    const client = new NotionClient({
      token: "ntn_test_fake_token",
      concurrency: 1,
      maxRetries: 1,
      // Retry-After 없는 5xx → 전역 쿨다운 없이 이 요청만 100~200ms 기다린다.
      retryBaseDelayMs: 200,
      rateLimitIntervalMs: 0,
    });
    let slowCalls = 0;
    stubRetrieve(client, (pageId) => {
      if (pageId !== "slow") return Promise.resolve({ id: pageId });
      slowCalls += 1;
      return slowCalls === 1 ? Promise.reject(apiError(503)) : Promise.resolve({ id: pageId });
    });

    const order: string[] = [];
    const slow = client.getPage("slow").then(() => order.push("slow"));
    // slow 가 슬롯을 잡고 첫 실패까지 가도록 한 틱 양보한다.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fast = client.getPage("fast").then(() => order.push("fast"));

    await Promise.all([slow, fast]);

    // 슬롯을 쥔 채 기다리던 예전 구현에서는 ["slow", "fast"] 가 된다.
    expect(order).toEqual(["fast", "slow"]);
  });

  it("429 는 전역 쿨다운 — 다른 요청도 함께 쉰다 (재시도 폭풍 방지)", async () => {
    const client = new NotionClient({
      token: "ntn_test_fake_token",
      concurrency: 2,
      maxRetries: 1,
      retryBaseDelayMs: 5,
      rateLimitIntervalMs: 0,
    });
    let limitedCalls = 0;
    stubRetrieve(client, (pageId) => {
      if (pageId !== "limited") return Promise.resolve({ id: pageId });
      limitedCalls += 1;
      return limitedCalls === 1
        ? Promise.reject(apiError(429, { retryAfter: "0.5" }))
        : Promise.resolve({ id: pageId });
    });

    const startedAt = Date.now();
    await client.getPage("limited").catch(() => {});
    const limitedDoneAt = Date.now();
    // 429 직후 들어온 무관한 요청도 쿨다운이 풀릴 때까지 기다려야 한다.
    await client.getPage("other");
    const otherDoneAt = Date.now();

    expect(limitedDoneAt - startedAt).toBeGreaterThanOrEqual(400);
    // 429 요청이 끝난 시점 == 쿨다운 만료 시점이므로 뒤 요청은 곧바로 통과한다.
    expect(otherDoneAt - startedAt).toBeGreaterThanOrEqual(400);
    expect(warnings[0]).toContain("status 429");
  });
});

describe("describeRetryCause", () => {
  it("status·code·메시지를 한 줄로 합친다", () => {
    expect(describeRetryCause(apiError(429, { code: "rate_limited" }))).toBe(
      "status 429 · rate_limited · HTTP 429",
    );
  });

  it("소켓 오류처럼 status 가 없어도 code 로 식별된다", () => {
    const error = new Error("socket hang up") as Error & Record<string, unknown>;
    error.code = "ECONNRESET";
    expect(describeRetryCause(error)).toBe("ECONNRESET · socket hang up");
  });

  it("객체가 아닌 값·빈 객체도 안전하게 요약한다", () => {
    expect(describeRetryCause("boom")).toBe("boom");
    expect(describeRetryCause(null)).toBe("null");
    expect(describeRetryCause({})).toBe("알 수 없는 오류");
  });

  it("긴 메시지는 잘라 로그 한 줄을 유지한다", () => {
    const error = new Error("x".repeat(500));
    expect(describeRetryCause(error).length).toBeLessThanOrEqual(130);
  });
});
