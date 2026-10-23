/**
 * API 가 읽지 못하는 보기 종류 — 2026-10-23 실측: Notion 앱에서 만든 `page` 보기는 `views.retrieve` 가
 * 400 `Unsupported view type: page` 로 거절한다. 그 보기 하나 때문에 DB 의 보기를 모두 잃지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

function rejection(message: string, code = "validation_error") {
  return Object.assign(new Error(message), { status: 400, code });
}

describe("API 가 읽지 못하는 보기 종류", () => {
  let client: NotionClient;
  let internal: {
    views: {
      list: (args: unknown) => Promise<unknown>;
      retrieve: (args: { view_id: string }) => Promise<unknown>;
    };
  };

  beforeEach(() => {
    client = new NotionClient({ token: "offline-test", rateLimitIntervalMs: 0, maxRetries: 0 });
    internal = client.getInternalClient() as unknown as typeof internal;
    vi.spyOn(internal.views, "list").mockResolvedValue({
      results: [{ id: "v-table" }, { id: "v-page" }],
      next_cursor: null,
    } as never);
  });

  it("그 보기만 건너뛰고 나머지 보기는 받는다", async () => {
    vi.spyOn(internal.views, "retrieve").mockImplementation(async ({ view_id }) => {
      if (view_id === "v-page") throw rejection("Unsupported view type: page");
      return { id: "v-table", name: "표", type: "table", data_source_id: "ds" };
    });
    const views = await client.listDatabaseViews("db");
    expect(views.map((v) => v.name)).toEqual(["표"]);
  });

  it("다른 거절은 그대로 던진다 — 빠진 목록으로 보기를 다시 쓰지 않는다", async () => {
    vi.spyOn(internal.views, "retrieve").mockImplementation(async ({ view_id }) => {
      if (view_id === "v-page") throw rejection("Could not find view", "object_not_found");
      return { id: "v-table", name: "표", type: "table", data_source_id: "ds" };
    });
    await expect(client.listDatabaseViews("db")).rejects.toThrow("Could not find view");
  });
});
