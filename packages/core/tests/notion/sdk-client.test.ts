/**
 * 쓰기의 알림 — 2026-10-23 실측(API 2025-09-03): 페이지 만들기 · 수정 · 블록 추가가 `notifications.mode` 를
 * 받고, 모르는 값은 400 으로 거절한다. SDK 는 이 매개변수를 걸러 내므로 요청 바로 앞에서 붙인다.
 */
import { describe, expect, it } from "vitest";
import { NotionClient } from "../../src/notion/client.js";
import { ConfigSchema, DEFAULT_CONFIG } from "../../src/types/config.js";

function recorder() {
  const sent: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const fetch = (async (url: string, init: { method: string; body?: string }) => {
    sent.push({
      method: init.method.toLowerCase(),
      path: new URL(url).pathname.replace(/^\/v1\//, ""),
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return new Response(JSON.stringify({ object: "page", id: "p1", results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

function clientWith(
  notifications: "silent" | "default" | undefined,
  fetch: typeof globalThis.fetch,
) {
  return new NotionClient({
    token: "offline-test",
    rateLimitIntervalMs: 0,
    maxRetries: 0,
    notifications,
    fetch,
  });
}

describe("쓰기의 알림", () => {
  it("기본은 알림을 끈다 — 페이지 만들기 · 수정 · 블록 추가", async () => {
    const { sent, fetch } = recorder();
    const client = clientWith(undefined, fetch);
    await client.createPageWithMarkdown({
      parentType: "page",
      parentId: "root",
      title: "제목",
      markdown: "본문",
    });
    await client.updatePageProperties("p1", { 이름: { title: [] } });
    await client.getInternalClient().blocks.children.append({ block_id: "p1", children: [] });
    expect(sent.map((r) => [r.method, r.path, r.body?.notifications])).toEqual([
      ["post", "pages", { mode: "silent" }],
      ["patch", "pages/p1", { mode: "silent" }],
      ["patch", "blocks/p1/children", { mode: "silent" }],
    ]);
  });

  it("읽기 · 본문 markdown 쓰기에는 붙이지 않는다", async () => {
    const { sent, fetch } = recorder();
    const client = clientWith("silent", fetch);
    await client.getPage("p1");
    await client.getInternalClient().pages.updateMarkdown({
      page_id: "p1",
      type: "replace_content",
      replace_content: { new_str: "x" },
    } as never);
    expect(sent.map((r) => r.body?.notifications)).toEqual([undefined, undefined]);
  });

  it("default 면 요청을 바꾸지 않는다", async () => {
    const { sent, fetch } = recorder();
    await clientWith("default", fetch).updatePageProperties("p1", {});
    expect(sent[0]!.body).toEqual({ properties: {} });
  });

  it("설정 — 기본 silent, 모르는 값은 거절", () => {
    expect(DEFAULT_CONFIG.sync.notifications).toBe("silent");
    const base = { ...DEFAULT_CONFIG, notion: { ...DEFAULT_CONFIG.notion, token: "ntn_x" } };
    expect(
      ConfigSchema.safeParse({ ...base, sync: { ...base.sync, notifications: "loud" } }).success,
    ).toBe(false);
  });
});
