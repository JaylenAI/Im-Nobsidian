/**
 * 바뀐 것만 찾는 search — 바뀐 행이 어느 DB 의 것인지 · 스키마가 바뀐 DB 는 어디인지 (ADR-027).
 *
 * pull 은 이것으로 바뀐 DB 만 조회한다. 행의 부모를 잃으면 새 행 · 고친 행이 있는 DB 를 건너뛰고,
 * 스키마가 바뀐 DB 를 못 보면 `.base` 와 행의 속성이 옛것으로 남는다.
 *
 * 취소하면 훑기가 다음 요청 전에 멈춘다 — 예전에는 취소한 뒤에도 훑기가 끝날 때까지(실볼트에서 분
 * 단위) 요청을 계속 보냈다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { NotionClient } from "../../src/notion/client.js";
import { OperationAbortedError } from "../../src/utils/abort.js";

type SearchArgs = { filter?: { value: string }; start_cursor?: string };

describe("바뀐 것 찾기 (ADR-027)", () => {
  let client: NotionClient;
  let internal: { search: (args: SearchArgs) => Promise<unknown> };

  beforeEach(() => {
    client = new NotionClient({ token: "offline-test", rateLimitIntervalMs: 0, maxRetries: 0 });
    internal = client.getInternalClient() as unknown as typeof internal;
  });

  describe("searchRecentPages", () => {
    it("DB 행이면 그 DB 를 싣는다 — data_source_id 부모도 DB id 를 함께 준다(실측)", async () => {
      vi.spyOn(internal, "search").mockResolvedValue({
        results: [
          {
            id: "row-1",
            last_edited_time: "2026-09-28T10:02:00.000Z",
            last_edited_by: { id: "u1" },
            parent: { type: "data_source_id", data_source_id: "ds-1", database_id: "db-1" },
          },
          {
            id: "row-2",
            last_edited_time: "2026-09-28T10:01:00.000Z",
            last_edited_by: { id: "u1" },
            parent: { type: "database_id", database_id: "db-2" },
          },
          {
            id: "page-1",
            last_edited_time: "2026-09-28T10:00:30.000Z",
            last_edited_by: { id: "u1" },
            parent: { type: "page_id", page_id: "root" },
          },
          {
            id: "old",
            last_edited_time: "2026-09-28T09:00:00.000Z",
            last_edited_by: { id: "u1" },
            parent: { type: "page_id", page_id: "root" },
          },
        ],
        next_cursor: null,
      } as never);

      const recent = await client.searchRecentPages("2026-09-28T10:00:00.000Z");

      expect(recent.map((r) => [r.id, r.parentDatabaseId])).toEqual([
        ["row-1", "db-1"],
        ["row-2", "db-2"],
        ["page-1", null],
      ]);
    });

    it("취소됐으면 search 를 보내지 않는다", async () => {
      const search = vi.spyOn(internal, "search");

      await expect(
        client.searchRecentPages("2026-09-28T10:00:00.000Z", { aborted: true }),
      ).rejects.toBeInstanceOf(OperationAbortedError);
      expect(search).not.toHaveBeenCalled();
    });
  });

  describe("searchRecentDataSources", () => {
    it("since 뒤에 바뀐 data source 와 그 DB — 최근 것부터, since 에서 멈춘다", async () => {
      const search = vi.spyOn(internal, "search").mockImplementation(async (args: SearchArgs) =>
        args.start_cursor === "c2"
          ? {
              results: [
                {
                  object: "data_source",
                  id: "ds-2",
                  last_edited_time: "2026-09-28T10:01:00.000Z",
                  parent: { type: "database_id", database_id: "db-2" },
                },
                {
                  object: "data_source",
                  id: "ds-old",
                  last_edited_time: "2026-09-28T10:00:00.000Z",
                  parent: { type: "database_id", database_id: "db-old" },
                },
              ],
              next_cursor: "c3",
            }
          : {
              results: [
                {
                  object: "data_source",
                  id: "ds-1",
                  last_edited_time: "2026-09-28T10:05:00.000Z",
                  parent: { type: "database_id", database_id: "db-1" },
                },
              ],
              next_cursor: "c2",
            },
      );

      const recent = await client.searchRecentDataSources("2026-09-28T10:00:00.000Z");

      expect(recent).toEqual([
        { id: "ds-1", last_edited_time: "2026-09-28T10:05:00.000Z", databaseId: "db-1" },
        { id: "ds-2", last_edited_time: "2026-09-28T10:01:00.000Z", databaseId: "db-2" },
      ]);
      // since 에 닿으면 다음 쪽(c3)을 받지 않는다.
      expect(search).toHaveBeenCalledTimes(2);
      expect(search.mock.calls[0]![0].filter).toEqual({
        property: "object",
        value: "data_source",
      });
    });

    it("DB 를 모르면 null — 추측하지 않는다", async () => {
      vi.spyOn(internal, "search").mockResolvedValue({
        results: [{ id: "ds-1", last_edited_time: "2026-09-28T10:05:00.000Z" }],
        next_cursor: null,
      } as never);

      const recent = await client.searchRecentDataSources("2026-09-28T10:00:00.000Z");

      expect(recent).toEqual([
        { id: "ds-1", last_edited_time: "2026-09-28T10:05:00.000Z", databaseId: null },
      ]);
    });

    it("취소됐으면 다음 쪽을 받지 않는다", async () => {
      const signal = { aborted: false };
      const search = vi.spyOn(internal, "search").mockImplementation(async () => {
        signal.aborted = true;
        return {
          results: [
            {
              id: "ds-1",
              last_edited_time: "2026-09-28T10:05:00.000Z",
              parent: { database_id: "db-1" },
            },
          ],
          next_cursor: "c2",
        };
      });

      await expect(
        client.searchRecentDataSources("2026-09-28T10:00:00.000Z", signal),
      ).rejects.toBeInstanceOf(OperationAbortedError);
      expect(search).toHaveBeenCalledTimes(1);
    });
  });

  describe("훑기 취소", () => {
    const page = (id: string) =>
      ({ id, parent: { type: "page_id", page_id: "root" } }) as unknown as PageObjectResponse;

    it("페이지 순회는 다음 페이지로 가기 전에 멈춘다", async () => {
      const signal = { aborted: false };
      const getChildPages = vi
        .spyOn(client, "getChildPages")
        .mockImplementation(async (id: string) => {
          if (id === "root") {
            signal.aborted = true;
            return [page("a"), page("b")];
          }
          return [];
        });

      await expect(client.getChildPagesRecursive("root", { signal })).rejects.toBeInstanceOf(
        OperationAbortedError,
      );
      // 루트의 자식(a · b)을 열지 않는다.
      expect(getChildPages).toHaveBeenCalledTimes(1);
    });

    it("전체 search 는 다음 쪽을 받기 전에 멈춘다", async () => {
      const signal = { aborted: false };
      const search = vi.spyOn(internal, "search").mockImplementation(async () => {
        signal.aborted = true;
        return { results: [page("a")], next_cursor: "c2" };
      });

      await expect(client.getPagesUnderRootViaSearch("root", signal)).rejects.toBeInstanceOf(
        OperationAbortedError,
      );
      expect(search).toHaveBeenCalledTimes(1);
    });

    it("취소하지 않으면 끝까지 훑는다", async () => {
      vi.spyOn(client, "getChildPages").mockImplementation(async (id: string) =>
        id === "root" ? [page("a")] : [],
      );

      const found = await client.getChildPagesRecursive("root", { signal: { aborted: false } });

      expect(found.map((p) => p.id)).toEqual(["a"]);
    });
  });
});
