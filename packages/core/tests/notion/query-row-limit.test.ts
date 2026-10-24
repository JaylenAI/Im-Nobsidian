/**
 * 한 번의 data source 조회는 결과 10,000건에서 멈춘다(API 2026-04-20). 넘으면 `has_more: false` 와 함께
 * `request_status: { type: "incomplete" }` 가 온다 — 보통의 페이지 넘김은 거기서 끝나, 나머지 행을 «없는 행» 으로
 * 읽었다. 만든 시각 차례로 창을 나눠 이어 읽는다(SDK `iterateAllDataSourceRows` 와 같은 방법 — SDK 도우미는 우리의
 * 속도 제한을 거치지 않아 쓰지 않는다).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

const LIMIT = 5;
const PAGE = 2;

interface Row {
  id: string;
  created_time: string;
}

type Filter = Record<string, unknown> | undefined;

/** 조회 하나가 LIMIT 건에서 멈추는 가짜 서버. 정렬 · 만든 시각 창 · 사용자 필터(이름이 「x」로 시작)를 따른다. */
function fakeServer(rows: Row[]) {
  const calls: Array<{ filter: Filter; sorts: unknown }> = [];
  const windowOf = (filter: Filter): string | undefined => {
    if (!filter) return undefined;
    if (Array.isArray(filter.and)) {
      for (const f of filter.and as Filter[]) {
        const w = windowOf(f);
        if (w) return w;
      }
      return undefined;
    }
    const ct = filter.created_time as { on_or_after?: string } | undefined;
    return ct?.on_or_after;
  };
  const onlyX = (filter: Filter): boolean =>
    JSON.stringify(filter ?? {}).includes('"starts_with":"x"');
  const query = vi.fn(
    async (args: {
      start_cursor?: string;
      filter?: Filter;
      sorts?: unknown;
      page_size?: number;
    }) => {
      if (!args.start_cursor) calls.push({ filter: args.filter, sorts: args.sorts });
      const since = windowOf(args.filter);
      let matched = rows.filter((r) => !since || r.created_time >= since);
      if (onlyX(args.filter)) matched = matched.filter((r) => r.id.startsWith("x"));
      if (args.sorts)
        matched = [...matched].sort((a, b) => a.created_time.localeCompare(b.created_time));
      const offset = Number(args.start_cursor ?? 0);
      const end = Math.min(offset + (args.page_size ?? PAGE), matched.length, LIMIT);
      const results = matched
        .slice(offset, end)
        .map((r) => ({ object: "page", ...r, properties: {} }));
      const hitLimit = end >= LIMIT && matched.length > LIMIT;
      const more = !hitLimit && end < matched.length;
      return {
        results,
        has_more: more,
        next_cursor: more ? String(end) : null,
        ...(hitLimit
          ? {
              request_status: {
                type: "incomplete",
                incomplete_reason: "query_result_limit_reached",
              },
            }
          : {}),
      };
    },
  );
  return { query, calls };
}

function rowsOf(n: number, prefix = "r"): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(i).padStart(2, "0")}`,
    created_time: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
  }));
}

describe("10,000건을 넘는 data source — 창을 나눠 끝까지 읽는다", () => {
  let client: NotionClient;
  let internal: {
    databases: { retrieve: (args: unknown) => Promise<unknown> };
    dataSources: { query: (args: unknown) => Promise<unknown> };
  };

  beforeEach(() => {
    client = new NotionClient({
      token: "offline-test",
      rateLimitIntervalMs: 0,
      maxRetries: 0,
      pageSize: PAGE,
    } as never);
    internal = client.getInternalClient() as unknown as typeof internal;
    vi.spyOn(internal.databases, "retrieve").mockResolvedValue({
      data_sources: [{ id: "ds-1", name: "" }],
    } as never);
  });

  it("한도에 걸리면 만든 시각 차례로 다시 읽어 모든 행을 한 번씩 돌려준다", async () => {
    const rows = rowsOf(12);
    const server = fakeServer(rows);
    vi.spyOn(internal.dataSources, "query").mockImplementation(server.query as never);

    const got = await client.queryAllDatabasePages("db-1");

    expect(got.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id));
    expect(new Set(got.map((r) => r.id)).size).toBe(got.length);
  });

  it("한도 밑이면 정렬 없이 한 번만 읽는다 — 행 차례가 그대로다", async () => {
    const server = fakeServer(rowsOf(4));
    vi.spyOn(internal.dataSources, "query").mockImplementation(server.query as never);

    await client.queryAllDatabasePages("db-1");

    expect(server.calls).toEqual([{ filter: undefined, sorts: undefined }]);
  });

  it("넘겨받은 필터는 창마다 함께 건다", async () => {
    const rows = [...rowsOf(8, "x"), ...rowsOf(3, "y")];
    const server = fakeServer(rows);
    vi.spyOn(internal.dataSources, "query").mockImplementation(server.query as never);
    const filter = { property: "이름", title: { starts_with: "x" } };

    const got = await client.queryAllDatabasePages("db-1", filter);

    expect(got.map((r) => r.id).sort()).toEqual(rowsOf(8, "x").map((r) => r.id));
    for (const call of server.calls.slice(1)) {
      expect(JSON.stringify(call.filter)).toContain('"starts_with":"x"');
    }
  });

  it("같은 시각에 만든 행이 한도보다 많아 창을 줄일 수 없으면 일부만 돌려주지 않고 던진다", async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      created_time: "2026-01-01T00:00:00.000Z",
    }));
    const server = fakeServer(rows);
    vi.spyOn(internal.dataSources, "query").mockImplementation(server.query as never);

    await expect(client.queryAllDatabasePages("db-1")).rejects.toThrow(/10,000/);
  });
});
