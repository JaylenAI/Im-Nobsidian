/**
 * 다중 data source 무손실 회귀 잠금 (I4) — "한 database 에 data source 2개 이상일 때
 * 1차만 동기화하고 2번째+ 의 행/컬럼을 침묵 유실"하던 결함 재발 방지.
 *
 * 결함(rank2): 신 모델(2025-09-03)에서 database 1개가 여러 data source(각자 행 집합·스키마)
 * 를 가질 수 있는데, 기존 코드는 `data_sources[0]` 만 읽어
 *   - queryAllDatabasePages → 1차 DS 행만 조회(2번째+ 행 통째 유실),
 *   - fetchDatabaseModern(=getDatabaseSchema/Full) → 1차 DS 스키마만(2번째+ 컬럼 유실).
 *
 * 수정: getDataSourceMetas 로 전 data source 를 받아 queryAllDatabasePages 가 전 소스를
 *   순회·페이지네이션·디듀프하고, fetchDatabaseModern 이 전 소스 properties 를 union 병합.
 *
 * 본 테스트는 실 NotionClient 의 내부 SDK 클라이언트를 mock 해 각 분기를 단언한다.
 * 가드 유효성: 수정 전(1차 DS 만)에는 ds-B 행/컬럼이 빠져 이 테스트가 실패한다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotionClient } from "../../src/notion/client.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

function pageStub(id: string): PageObjectResponse {
  return {
    id,
    last_edited_time: "2026-05-30T00:00:00.000Z",
    properties: {},
  } as unknown as PageObjectResponse;
}

describe("다중 data source 무손실 (I4)", () => {
  let client: NotionClient;
  // SDK 내부 클라이언트(databases/dataSources)는 생성자에서 고정 객체라 spy 가 안정적으로 붙는다.
  let internal: {
    databases: { retrieve: (args: unknown) => Promise<unknown> };
    dataSources: {
      query: (args: { data_source_id: string; start_cursor?: string }) => Promise<unknown>;
      retrieve: (args: { data_source_id: string }) => Promise<unknown>;
    };
  };
  const DB = "db-1";

  beforeEach(() => {
    // rateLimitIntervalMs:0 으로 테스트 지연 제거, maxRetries:0 으로 즉시 전파.
    client = new NotionClient({ token: "offline-test", rateLimitIntervalMs: 0, maxRetries: 0 });
    internal = client.getInternalClient() as unknown as typeof internal;
  });

  it("queryAllDatabasePages 는 전 data source 의 행을 빠짐없이 합친다", async () => {
    vi.spyOn(internal.databases, "retrieve").mockResolvedValue({
      data_sources: [
        { id: "ds-A", name: "Tab A" },
        { id: "ds-B", name: "Tab B" },
      ],
    } as never);
    const querySpy = vi
      .spyOn(internal.dataSources, "query")
      .mockImplementation((args: { data_source_id: string }) => {
        if (args.data_source_id === "ds-A")
          return Promise.resolve({
            results: [pageStub("a1"), pageStub("a2")],
            next_cursor: null,
          } as never);
        if (args.data_source_id === "ds-B")
          return Promise.resolve({ results: [pageStub("b1")], next_cursor: null } as never);
        return Promise.resolve({ results: [], next_cursor: null } as never);
      });

    const rows = await client.queryAllDatabasePages(DB);

    // 2번째 DS(ds-B)의 b1 이 유실되지 않는다 — 핵심 회귀 잠금.
    expect(rows.map((r) => r.id).sort()).toEqual(["a1", "a2", "b1"]);
    expect(querySpy).toHaveBeenCalledTimes(2); // 두 소스 모두 쿼리됨
  });

  it("각 data source 가 페이지네이션돼도 끝까지 순회한다", async () => {
    vi.spyOn(internal.databases, "retrieve").mockResolvedValue({
      data_sources: [{ id: "ds-A" }, { id: "ds-B" }],
    } as never);
    vi.spyOn(internal.dataSources, "query").mockImplementation(
      (args: { data_source_id: string; start_cursor?: string }) => {
        if (args.data_source_id === "ds-A") {
          return args.start_cursor
            ? Promise.resolve({ results: [pageStub("a2")], next_cursor: null } as never)
            : Promise.resolve({ results: [pageStub("a1")], next_cursor: "cur-A" } as never);
        }
        return Promise.resolve({ results: [pageStub("b1")], next_cursor: null } as never);
      },
    );

    const rows = await client.queryAllDatabasePages(DB);
    expect(rows.map((r) => r.id).sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("소스 간 동일 page_id 는 디듀프된다", async () => {
    vi.spyOn(internal.databases, "retrieve").mockResolvedValue({
      data_sources: [{ id: "ds-A" }, { id: "ds-B" }],
    } as never);
    vi.spyOn(internal.dataSources, "query").mockResolvedValue({
      results: [pageStub("dup")],
      next_cursor: null,
    } as never);

    const rows = await client.queryAllDatabasePages(DB);
    expect(rows.map((r) => r.id)).toEqual(["dup"]); // 두 소스가 같은 페이지를 줘도 1건
  });

  it("getDatabaseSchema 는 전 data source 의 컬럼을 union 병합한다", async () => {
    vi.spyOn(internal.databases, "retrieve").mockResolvedValue({
      title: [{ plain_text: "DB" }],
      properties: {},
      data_sources: [{ id: "ds-A" }, { id: "ds-B" }],
    } as never);
    vi.spyOn(internal.dataSources, "retrieve").mockImplementation(
      (args: { data_source_id: string }) => {
        if (args.data_source_id === "ds-A")
          return Promise.resolve({
            properties: {
              Name: { id: "t", type: "title" },
              Status: { id: "s", type: "select" },
            },
          } as never);
        return Promise.resolve({
          properties: {
            Name: { id: "t", type: "title" },
            Extra: { id: "e", type: "rich_text" },
          },
        } as never);
      },
    );

    const schema = await client.getDatabaseSchema(DB);
    // 2번째 DS 의 Extra 컬럼이 보존된다(union) — 1차만 읽으면 빠졌을 것.
    expect(Object.keys(schema).sort()).toEqual(["Extra", "Name", "Status"]);
  });

  it("단일 data source 는 정확히 1회만 쿼리(지배적 경로 회귀 없음)", async () => {
    vi.spyOn(internal.databases, "retrieve").mockResolvedValue({
      data_sources: [{ id: "ds-only" }],
    } as never);
    const querySpy = vi.spyOn(internal.dataSources, "query").mockResolvedValue({
      results: [pageStub("x")],
      next_cursor: null,
    } as never);

    const rows = await client.queryAllDatabasePages(DB);
    expect(rows.map((r) => r.id)).toEqual(["x"]);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });
});
