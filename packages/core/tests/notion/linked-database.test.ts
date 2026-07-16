/**
 * linked database view → 원본 DB 해소 (F22) — denylist 56개 침묵 스킵 회귀 잠금.
 *
 * 결함: linked view 컨테이너는 `data_sources` 가 비어 getDatabaseSyncability 가
 * queryable=false → 즉시 denylist 영구 편입(AI Engineer 의 Project 갤러리 등 56건).
 * 수정: Views API 로 뷰 상세의 data_source_id → 그 data source 의 parent database 로
 * 원본을 해소한다. 해소 불가(뷰 없음/자기참조/권한)는 null — 기존 접근 불가 처리 유지.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

describe("resolveLinkedDatabase (F22)", () => {
  let client: NotionClient;
  let internal: {
    views: {
      list: (args: unknown) => Promise<unknown>;
      retrieve: (args: { view_id: string }) => Promise<unknown>;
    };
    dataSources: { retrieve: (args: { data_source_id: string }) => Promise<unknown> };
  };
  const LINKED = "cfc13b18-d382-8387-b8bb-8164cc114240";
  const ORIGINAL = "88113b18-d382-83d7-988e-81fece224b75";

  beforeEach(() => {
    client = new NotionClient({ token: "offline-test", rateLimitIntervalMs: 0, maxRetries: 0 });
    internal = client.getInternalClient() as unknown as typeof internal;
  });

  it("뷰의 data_source_id 를 따라 원본 database 로 해소한다", async () => {
    vi.spyOn(internal.views, "list").mockResolvedValue({
      results: [{ id: "view-1" }],
      next_cursor: null,
    } as never);
    vi.spyOn(internal.views, "retrieve").mockResolvedValue({
      id: "view-1",
      name: "Project 갤러리",
      type: "gallery",
      data_source_id: "ds-orig",
    } as never);
    vi.spyOn(internal.dataSources, "retrieve").mockResolvedValue({
      parent: { type: "database_id", database_id: ORIGINAL },
    } as never);

    const resolved = await client.resolveLinkedDatabase(LINKED);
    expect(resolved).toEqual({ originalDbId: ORIGINAL, viewName: "Project 갤러리" });
  });

  it("자기 자신을 가리키면(진짜 소스 없음) null — linked 오판 방지", async () => {
    vi.spyOn(internal.views, "list").mockResolvedValue({
      results: [{ id: "view-1" }],
      next_cursor: null,
    } as never);
    vi.spyOn(internal.views, "retrieve").mockResolvedValue({
      id: "view-1",
      name: "self",
      type: "table",
      data_source_id: "ds-self",
    } as never);
    vi.spyOn(internal.dataSources, "retrieve").mockResolvedValue({
      parent: { type: "database_id", database_id: LINKED },
    } as never);

    expect(await client.resolveLinkedDatabase(LINKED)).toBeNull();
  });

  it("뷰가 없으면 null — 기존 접근 불가 처리로 폴백", async () => {
    vi.spyOn(internal.views, "list").mockResolvedValue({
      results: [],
      next_cursor: null,
    } as never);
    expect(await client.resolveLinkedDatabase(LINKED)).toBeNull();
  });

  it("Views API 자체가 실패해도 throw 하지 않고 null", async () => {
    vi.spyOn(internal.views, "list").mockRejectedValue(new Error("403") as never);
    expect(await client.resolveLinkedDatabase(LINKED)).toBeNull();
  });

  it("data_source_id 없는 뷰는 건너뛰고 다음 뷰에서 해소한다", async () => {
    vi.spyOn(internal.views, "list").mockResolvedValue({
      results: [{ id: "view-1" }, { id: "view-2" }],
      next_cursor: null,
    } as never);
    vi.spyOn(internal.views, "retrieve").mockImplementation((args: { view_id: string }) =>
      Promise.resolve(
        args.view_id === "view-1"
          ? ({ id: "view-1", name: "빈뷰", type: "table" } as never)
          : ({ id: "view-2", name: "본뷰", type: "table", data_source_id: "ds-orig" } as never),
      ),
    );
    vi.spyOn(internal.dataSources, "retrieve").mockResolvedValue({
      parent: { type: "database_id", database_id: ORIGINAL },
    } as never);

    const resolved = await client.resolveLinkedDatabase(LINKED);
    expect(resolved?.originalDbId).toBe(ORIGINAL);
  });
});
