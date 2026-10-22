/**
 * DB 하나는 한 번만 받는다 (ADR-027).
 *
 * 예전에는 DB 하나를 pull 하는 데 같은 DB 를 행 조회 · 스키마 · 전체 스키마 · 제목마다 다시 받아
 * 요청이 6~8회 들었다 — 발견 DB 166개의 pull 이 분 단위였던 이유 가운데 하나다(실측 2026-09-28).
 * 받은 것({@link DatabaseMeta})을 넘기면 다시 받지 않는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

describe("DB 한 번 받기 (ADR-027)", () => {
  let client: NotionClient;
  let internal: {
    databases: { retrieve: (args: { database_id: string }) => Promise<unknown> };
    dataSources: {
      query: (args: { data_source_id: string }) => Promise<unknown>;
      retrieve: (args: { data_source_id: string }) => Promise<unknown>;
    };
  };
  const DB = "0a1b2c3d-0000-4000-8000-000000000001";

  beforeEach(() => {
    client = new NotionClient({ token: "offline-test", rateLimitIntervalMs: 0, maxRetries: 0 });
    internal = client.getInternalClient() as unknown as typeof internal;
  });

  function stubDatabase() {
    const retrieve = vi.spyOn(internal.databases, "retrieve").mockResolvedValue({
      title: [{ plain_text: "책장" }],
      properties: {},
      data_sources: [{ id: "ds-1", name: "책" }],
    } as never);
    const dsRetrieve = vi.spyOn(internal.dataSources, "retrieve").mockResolvedValue({
      properties: {
        이름: { id: "title", type: "title" },
        상태: { id: "s", type: "select", select: { options: [{ id: "o1", name: "읽음" }] } },
      },
    } as never);
    const query = vi.spyOn(internal.dataSources, "query").mockResolvedValue({
      results: [{ id: "row-1", properties: {} }],
      next_cursor: null,
    } as never);
    return { retrieve, dsRetrieve, query };
  }

  it("받은 DB 를 넘기면 행 조회 · 스키마 · 전체 스키마 · 제목이 DB 를 다시 받지 않는다", async () => {
    const { retrieve, dsRetrieve, query } = stubDatabase();

    const meta = await client.getDatabaseMeta(DB);
    const rows = await client.queryAllDatabasePages(DB, undefined, meta);
    const schema = await client.getDatabaseSchema(DB, meta);
    const full = await client.getDatabaseSchemaFull(DB, meta);
    const title = await client.getDatabaseTitle(DB, meta);

    expect(rows.map((r) => r.id)).toEqual(["row-1"]);
    expect(schema).toEqual({
      이름: { id: "title", type: "title" },
      상태: { id: "s", type: "select" },
    });
    expect(full.상태).toMatchObject({ type: "select" });
    expect(title).toBe("책장");
    // DB 1회 + data source 1회 + 행 조회 1회 — 예전에는 같은 DB 를 서너 번 다시 받았다.
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(dsRetrieve).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ data_source_id: "ds-1" }));
  });

  it("하이픈 유무가 달라도 같은 DB 를 받은 것으로 본다", async () => {
    const { retrieve } = stubDatabase();

    const meta = await client.getDatabaseMeta(DB.replace(/-/g, ""));
    await client.getDatabaseSchema(DB, meta);

    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("다른 DB 를 받은 것을 넘기면 그 DB 를 새로 받는다 — 남의 스키마를 읽지 않는다", async () => {
    const { retrieve } = stubDatabase();
    const other = "0a1b2c3d-0000-4000-8000-000000000002";

    const meta = await client.getDatabaseMeta(other);
    await client.getDatabaseSchema(DB, meta);

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenLastCalledWith({ database_id: DB });
  });

  it("data source 가 없는 옛 DB 는 DB id 로 행을 조회한다", async () => {
    vi.spyOn(internal.databases, "retrieve").mockResolvedValue({
      title: [{ plain_text: "옛 DB" }],
      properties: { Name: { id: "title", type: "title" } },
    } as never);
    const query = vi.spyOn(internal.dataSources, "query").mockResolvedValue({
      results: [],
      next_cursor: null,
    } as never);

    const meta = await client.getDatabaseMeta(DB);
    await client.queryAllDatabasePages(DB, undefined, meta);

    expect(meta.dataSources).toEqual([]);
    // data source 를 읽지 못하면 DB 객체의 속성으로 — 제목 · 스키마를 잃지 않는다.
    expect(meta.properties).toEqual({ Name: { id: "title", type: "title" } });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ data_source_id: DB }));
  });
});
