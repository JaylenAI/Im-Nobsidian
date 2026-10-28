/**
 * 워크스페이스 단위의 한도 — 연결 하나가 아니라 워크스페이스가 막힌 경우.
 *
 * request-limits 문서: 429 의 `additional_data.rate_limit_reason` 이 `public_api_space_request_rate_limit` 이면 같은
 * 워크스페이스의 연결들이 함께 쓰는 한도이고, 그 대기는 1분을 넘을 수 있다. 1분으로 자르면 서버가 말한 시각보다
 * 먼저 두드려 429 를 다시 맞고 재시도 횟수만 버린다.
 *
 * workspace-block-limits 문서(2026-09-01): 멤버가 둘 이상인 Free 워크스페이스는 블록 한도를 넘으면 블록을 만드는
 * 요청이 403 `restricted_resource` + `additional_data.block_limit` 로 거절된다. 한 번 막히면 플랜을 올리기 전에는
 * 풀리지 않으므로, 이어지는 만들기 요청을 다 보내 같은 거절을 수천 번 받지 않는다.
 */
import { describe, it, expect, vi } from "vitest";
import {
  NotionClient,
  describeRetryCause,
  extractRetryAfter,
  isWorkspaceBlockLimit,
} from "../../src/notion/client.js";

function rateLimited(reason: string, retryAfterSeconds: string): Error {
  const error = new Error("rate limited") as Error & Record<string, unknown>;
  error.status = 429;
  error.code = "rate_limited";
  error.headers = new Headers({ "Retry-After": retryAfterSeconds });
  error.additional_data = { retry_after: retryAfterSeconds, rate_limit_reason: reason };
  return error;
}

function blockLimited(): Error {
  const error = new Error(
    "This workspace has used all of its free blocks. Upgrade its plan in Notion to create more content.",
  ) as Error & Record<string, unknown>;
  error.status = 403;
  error.code = "restricted_resource";
  error.additional_data = { block_limit: {} };
  return error;
}

function newClient(): NotionClient {
  return new NotionClient({
    token: "ntn_test_fake_token",
    concurrency: 1,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    rateLimitIntervalMs: 0,
  });
}

function sdk(client: NotionClient): Record<string, unknown> {
  return (client as unknown as { client: Record<string, unknown> }).client;
}

describe("워크스페이스가 함께 쓰는 rate limit", () => {
  it("대기가 1분을 넘어도 서버가 말한 만큼 기다린다(5분까지)", () => {
    expect(extractRetryAfter(rateLimited("public_api_space_request_rate_limit", "150"))).toBe(
      150_000,
    );
    expect(extractRetryAfter(rateLimited("public_api_space_request_rate_limit", "3600"))).toBe(
      300_000,
    );
  });

  it("연결 하나의 한도는 예전처럼 1분에서 자른다", () => {
    expect(extractRetryAfter(rateLimited("public_api_request_rate_limit", "150"))).toBe(60_000);
  });

  it("재시도 로그에 어느 한도인지 남긴다", () => {
    expect(describeRetryCause(rateLimited("public_api_space_request_rate_limit", "1"))).toContain(
      "public_api_space_request_rate_limit",
    );
  });
});

describe("Free 워크스페이스 블록 한도(403)", () => {
  it("block_limit 이 실린 403 만 블록 한도로 본다", () => {
    expect(isWorkspaceBlockLimit(blockLimited())).toBe(true);
    const denied = new Error("no access") as Error & Record<string, unknown>;
    denied.status = 403;
    denied.code = "restricted_resource";
    expect(isWorkspaceBlockLimit(denied)).toBe(false);
  });

  it("거절 사유를 버리지 않고 할 일과 함께 알린다", async () => {
    const client = newClient();
    sdk(client).pages = { create: vi.fn(() => Promise.reject(blockLimited())) };

    const error = await client
      .createPage({ parentId: "root", parentType: "page", title: "t" })
      .catch((e: unknown) => e as Error & { status?: number });

    expect(error.message).toContain("블록 한도");
    expect(error.message).toContain("Upgrade its plan");
    // 403 으로 판정하는 호출처가 그대로 알아보게 상태 코드를 지킨다.
    expect(error.status).toBe(403);
  });

  it("한 번 막히면 이어지는 만들기 요청은 보내지 않는다", async () => {
    const client = newClient();
    const create = vi.fn(() => Promise.reject(blockLimited()));
    const append = vi.fn();
    sdk(client).pages = { create };
    sdk(client).blocks = { children: { append } };

    await expect(
      client.createPage({ parentId: "root", parentType: "page", title: "a" }),
    ).rejects.toThrow("블록 한도");
    await expect(
      client.createPage({ parentId: "root", parentType: "page", title: "b" }),
    ).rejects.toThrow("블록 한도");
    await expect(client.appendChildren("page", [{ paragraph: {} }])).rejects.toThrow("블록 한도");

    expect(create).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });

  it("읽기는 막지 않는다 — 받기(pull)는 한도와 무관하다", async () => {
    const client = newClient();
    sdk(client).pages = {
      create: vi.fn(() => Promise.reject(blockLimited())),
      retrieve: vi.fn(() => Promise.resolve({ id: "p1", object: "page" })),
    };

    await client.createPage({ parentId: "root", parentType: "page", title: "a" }).catch(() => {});

    await expect(client.getPage("p1")).resolves.toMatchObject({ id: "p1" });
  });

  it("시간이 지나면 다시 보내 본다 — 그 사이 플랜을 올렸을 수 있다", async () => {
    vi.useFakeTimers();
    try {
      const client = newClient();
      const create = vi
        .fn()
        .mockRejectedValueOnce(blockLimited())
        .mockResolvedValueOnce({ id: "new", object: "page" });
      sdk(client).pages = { create };

      await client.createPage({ parentId: "root", parentType: "page", title: "a" }).catch(() => {});
      vi.advanceTimersByTime(5 * 60_000 + 1);

      await expect(
        client.createPage({ parentId: "root", parentType: "page", title: "b" }),
      ).resolves.toMatchObject({ id: "new" });
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
