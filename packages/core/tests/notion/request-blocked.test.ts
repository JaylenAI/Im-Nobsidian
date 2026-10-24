/**
 * 막힌 연결의 429 는 다시 보내지 않는다.
 *
 * request-limits 문서(2026-09-24 changelog): `rate_limit_reason: "public_api_request_blocked"` 는 Notion 이 이
 * 연결의 API 접근을 막은 것이라 쉬어도 풀리지 않는다 — 재시도하지 말고 지원팀에 문의한다. 예전에는 다른 429 처럼
 * 대기를 다 채운 뒤에야 실패해 멈춘 것처럼 보였다.
 */
import { describe, it, expect, vi } from "vitest";
import { NotionClient, isRequestBlocked } from "../../src/notion/client.js";

function rateLimited(reason: string): Error {
  const error = new Error("rate limited") as Error & Record<string, unknown>;
  error.status = 429;
  error.code = "rate_limited";
  error.headers = new Headers({ "Retry-After": "1" });
  error.additional_data = { retry_after: "1", rate_limit_reason: reason };
  return error;
}

function clientWith(retrieve: ReturnType<typeof vi.fn>): NotionClient {
  const client = new NotionClient({
    token: "ntn_test_fake_token",
    concurrency: 1,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    rateLimitIntervalMs: 0,
  });
  (client as unknown as { client: { pages: unknown } }).client.pages = { retrieve };
  return client;
}

describe("막힌 연결의 429", () => {
  it("public_api_request_blocked 는 한 번만 보내고 실패한다", async () => {
    const retrieve = vi.fn(() => Promise.reject(rateLimited("public_api_request_blocked")));

    await expect(clientWith(retrieve).getPage("p1")).rejects.toThrow();

    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("다른 429 는 예전처럼 다시 보낸다", () => {
    expect(isRequestBlocked(rateLimited("public_api_request_rate_limit"))).toBe(false);
    expect(isRequestBlocked(rateLimited("public_api_request_blocked"))).toBe(true);
    expect(isRequestBlocked(new Error("boom"))).toBe(false);
  });
});
