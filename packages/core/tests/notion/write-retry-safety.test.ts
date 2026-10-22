/**
 * S-07 — 쓰기 요청을 다시 보내면 같은 페이지가 두 벌 생긴다.
 *
 * Notion 은 멱등 키를 받지 않는다. 타임아웃 · 연결 끊김 · 5xx 는 요청이 서버에서 이미
 * 적용됐을 수 있는 실패라, 페이지 생성 · 블록 덧붙이기를 그대로 다시 보내면 중복이 생긴다.
 * 예전 판정(isRetryable)은 요청 종류를 보지 않고 이 실패들을 모두 재시도했다.
 *
 * 그래서 세 가지를 잠근다:
 *   1. 두 번 적용하면 결과가 달라지는 쓰기는 모호한 실패에서 다시 보내지 않는다.
 *   2. 서버가 «처리하지 않았다» 고 분명히 말한 실패(429 · 529)는 어떤 요청이든 다시 보낸다.
 *   3. 재시도는 한 층에서만 한다 — SDK 기본 재시도가 켜져 있으면 두 층이 곱해진다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { NotionClient } from "../../src/notion/client.js";
import { setLogger } from "../../src/utils/logger.js";

/** SDK 오류 흉내 — 재시도 판정은 status · code 만 본다. */
function apiError(status: number): Error {
  const error = new Error(`HTTP ${status}`) as Error & Record<string, unknown>;
  error.status = status;
  return error;
}

function codeError(code: string): Error {
  const error = new Error(code) as Error & Record<string, unknown>;
  error.code = code;
  return error;
}

const AMBIGUOUS: ReadonlyArray<readonly [string, () => Error]> = [
  ["요청 타임아웃", () => codeError("notionhq_client_request_timeout")],
  ["연결 끊김", () => codeError("ECONNRESET")],
  ["500", () => apiError(500)],
  ["502", () => apiError(502)],
  ["503", () => apiError(503)],
  ["504", () => apiError(504)],
];

function newClient(fetch?: typeof globalThis.fetch): NotionClient {
  return new NotionClient({
    token: "ntn_test_fake_token",
    concurrency: 1,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    rateLimitIntervalMs: 0,
    ...(fetch ? { fetch } : {}),
  });
}

/** SDK 네임스페이스 하나를 스텁으로 바꾼다. 첫 호출만 `first` 로 실패하고 이후는 성공한다. */
function failOnce<T>(first: Error, ok: T) {
  let calls = 0;
  return vi.fn(() => {
    calls += 1;
    return calls === 1 ? Promise.reject(first) : Promise.resolve(ok);
  });
}

function sdk(client: NotionClient): Record<string, unknown> {
  return (client as unknown as { client: Record<string, unknown> }).client;
}

const PAGE = { id: "p1", last_edited_time: "2026-09-27T00:00:00.000Z" };

beforeEach(() => {
  setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("두 번 적용하면 달라지는 쓰기 — 모호한 실패는 다시 보내지 않는다", () => {
  it.each(AMBIGUOUS)(
    "페이지 생성(마크다운): %s → 한 번만 보내고 오류를 올린다",
    async (_, make) => {
      const client = newClient();
      const create = failOnce(make(), PAGE);
      sdk(client).pages = { create };

      await expect(
        client.createPageWithMarkdown({
          parentId: "parent",
          parentType: "page",
          title: "note",
          markdown: "본문",
        }),
      ).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it("페이지 생성(블록): 504 → 한 번만 보낸다", async () => {
    const client = newClient();
    const create = failOnce(apiError(504), PAGE);
    sdk(client).pages = { create };

    await expect(
      client.createPage({ parentId: "parent", parentType: "page", title: "note" }),
    ).rejects.toThrow("HTTP 504");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("블록 덧붙이기: 502 → 한 번만 보낸다 (다시 보내면 문단이 두 번 붙는다)", async () => {
    const client = newClient();
    const append = failOnce(apiError(502), { results: [{ id: "b1" }] });
    sdk(client).blocks = { children: { append } };

    await expect(client.appendChildren("page", [{ type: "paragraph" }])).rejects.toThrow(
      "HTTP 502",
    );
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("부분 치환(update_content): 타임아웃 → 한 번만 보낸다", async () => {
    const client = newClient();
    const updateMarkdown = failOnce(codeError("notionhq_client_request_timeout"), {});
    sdk(client).pages = { updateMarkdown };

    await expect(
      client.updatePageMarkdownPartial("page", [{ oldStr: "a", newStr: "a a" }]),
    ).rejects.toThrow();
    expect(updateMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe("서버가 처리하지 않았다고 말한 실패 — 어떤 요청이든 다시 보낸다", () => {
  it.each([
    ["429", 429],
    ["529", 529],
  ])("페이지 생성: %s → 다시 보내 성공한다", async (_, status) => {
    const client = newClient();
    const create = failOnce(apiError(status), PAGE);
    sdk(client).pages = { create };

    const page = await client.createPageWithMarkdown({
      parentId: "parent",
      parentType: "page",
      title: "note",
      markdown: "본문",
    });

    expect(page.id).toBe("p1");
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("두 번 적용해도 같은 요청 — 모호한 실패도 다시 보낸다", () => {
  it.each(AMBIGUOUS)("본문 전체 교체(replace_content): %s → 다시 보낸다", async (_, make) => {
    const client = newClient();
    const updateMarkdown = failOnce(make(), { markdown: "" });
    sdk(client).pages = { updateMarkdown };

    await client.replacePageMarkdown("page", "본문");
    expect(updateMarkdown).toHaveBeenCalledTimes(2);
  });

  it("휴지통 이동: 503 → 다시 보낸다", async () => {
    const client = newClient();
    const update = failOnce(apiError(503), PAGE);
    sdk(client).pages = { update };

    await client.archivePage("page");
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("페이지 옮기기: 504 → 다시 보낸다 (같은 부모로 두 번 옮겨도 결과가 같다)", async () => {
    const client = newClient();
    const move = failOnce(apiError(504), PAGE);
    const update = vi.fn();
    sdk(client).pages = { move, update };

    await client.movePage("page", "parent");

    expect(move).toHaveBeenCalledTimes(2);
    expect(move).toHaveBeenLastCalledWith({
      page_id: "page",
      parent: { type: "page_id", page_id: "parent" },
    });
    // S-11 — pages.update 의 parent 는 Notion 이 조용히 무시한다. 부모는 move 로만 바뀐다.
    expect(update).not.toHaveBeenCalled();
  });

  it("블록 삭제: 타임아웃 → 다시 보낸다", async () => {
    const client = newClient();
    const del = failOnce(codeError("notionhq_client_request_timeout"), {});
    sdk(client).blocks = { delete: del };

    await client.deleteBlock("block");
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("조회: 500 → 다시 보낸다 (SDK 가 하던 GET 500 재시도를 이 층이 넘겨받는다)", async () => {
    const client = newClient();
    const retrieve = failOnce(apiError(500), PAGE);
    sdk(client).pages = { retrieve };

    await client.getPage("p1");
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});

describe("재시도는 한 층에서만 — SDK 기본 재시도를 끈다", () => {
  /** 실제 SDK 를 거치게 fetch 만 바꾼다. 응답 모양은 Notion 오류 JSON 그대로다. */
  function fetchAlways(status: number, code: string) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify({ object: "error", status, code, message: code }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  it("429 가 이어지면 요청은 1 + maxRetries 번만 나간다 (SDK 가 켜져 있으면 3배)", async () => {
    const fetch = fetchAlways(429, "rate_limited");
    const client = newClient(fetch as unknown as typeof globalThis.fetch);

    await expect(client.getPage("p1")).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("페이지 생성이 503 이면 fetch 는 정확히 한 번 — 어느 층도 다시 보내지 않는다", async () => {
    const fetch = fetchAlways(503, "service_unavailable");
    const client = newClient(fetch as unknown as typeof globalThis.fetch);

    await expect(
      client.createPageWithMarkdown({
        parentId: "parent",
        parentType: "page",
        title: "note",
        markdown: "본문",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
