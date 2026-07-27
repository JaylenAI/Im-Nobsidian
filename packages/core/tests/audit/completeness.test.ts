/**
 * R11-B 회귀 잠금 — DB 완결성 게이트.
 *
 * 이 게이트가 존재하는 이유는 **멱등 게이트가 체계적 미발견을 못 잡기 때문**이다.
 * 디스커버리가 매번 같은 행을 놓치면 repull 은 바이트 동일이고 churn 도 0 이라
 * 기존 게이트는 전부 GREEN 을 낸다(실측: 2026-07-17 pull 이 DB 행 296개를 유실한 채
 * 전 게이트 통과). 따라서 여기서 잠글 성질은 "안 바뀐다"가 아니라 "빠짐없다"다.
 *
 * 특히 카운트가 아니라 **집합**을 비교한다는 계약을 못 박는다 — 미발견 1건과 잔재
 * 1건이 동시에 있으면 카운트는 같아져 상쇄되기 때문이다.
 */
import { describe, it, expect, vi } from "vitest";
import { verifyDatabaseCompleteness } from "../../src/audit/completeness.js";
import type {
  CompletenessLocalSource,
  CompletenessRemoteSource,
} from "../../src/audit/completeness.js";

const DB_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DB_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type LocalRecord = {
  notionPageId: string | null;
  notionParentId: string | null;
  fileType: string;
};

function localSource(records: LocalRecord[]): CompletenessLocalSource {
  return { getAll: () => records };
}

function row(pageId: string, databaseId: string): LocalRecord {
  return { notionPageId: pageId, notionParentId: databaseId, fileType: "db-row" };
}

function remoteSource(rows: Record<string, string[]>): CompletenessRemoteSource {
  return {
    queryAllDatabasePages: vi.fn(async (databaseId: string) => {
      const key = databaseId.replace(/-/g, "").toLowerCase();
      return (rows[key] ?? []).map((id) => ({ id }));
    }),
  };
}

describe("verifyDatabaseCompleteness — DB 완결성 게이트", () => {
  it("원격 행이 볼트에 전부 있으면 완결", async () => {
    const report = await verifyDatabaseCompleteness(
      remoteSource({ [DB_A]: ["r1", "r2"] }),
      localSource([row("r1", DB_A), row("r2", DB_A)]),
    );

    expect(report.complete).toBe(true);
    expect(report.remoteTotal).toBe(2);
    expect(report.localTotal).toBe(2);
    expect(report.databases[0]!.missingIds).toEqual([]);
  });

  it("볼트에 없는 원격 행을 미발견으로 집어낸다 (침묵 유실 차단)", async () => {
    const report = await verifyDatabaseCompleteness(
      remoteSource({ [DB_A]: ["r1", "r2", "r3"] }),
      localSource([row("r1", DB_A)]),
    );

    expect(report.complete).toBe(false);
    expect(report.databases[0]!.missingIds).toEqual(["r2", "r3"]);
    expect(report.databases[0]!.remoteRows).toBe(3);
    expect(report.databases[0]!.localRows).toBe(1);
  });

  it("원격에 없는 볼트 행을 잔재로 집어낸다", async () => {
    const report = await verifyDatabaseCompleteness(
      remoteSource({ [DB_A]: ["r1"] }),
      localSource([row("r1", DB_A), row("stale", DB_A)]),
    );

    expect(report.complete).toBe(false);
    expect(report.databases[0]!.extraIds).toEqual(["stale"]);
  });

  it("미발견 1건 + 잔재 1건이 카운트로 상쇄돼도 통과시키지 않는다 (집합 비교 계약)", async () => {
    const report = await verifyDatabaseCompleteness(
      remoteSource({ [DB_A]: ["r1", "r2"] }),
      localSource([row("r1", DB_A), row("stale", DB_A)]),
    );

    // 카운트만 보면 2 = 2 라 통과한다. 집합을 봐야 결함이 드러난다.
    expect(report.remoteTotal).toBe(report.localTotal);
    expect(report.complete).toBe(false);
    expect(report.databases[0]!.missingIds).toEqual(["r2"]);
    expect(report.databases[0]!.extraIds).toEqual(["stale"]);
  });

  it("하이픈 표기 차이를 같은 id 로 본다", async () => {
    const hyphenated = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const report = await verifyDatabaseCompleteness(
      remoteSource({ [DB_A]: ["11111111-1111-1111-1111-111111111111"] }),
      localSource([row("11111111111111111111111111111111", hyphenated)]),
    );

    expect(report.complete).toBe(true);
  });

  it("db-row 가 아닌 레코드는 대조 대상이 아니다", async () => {
    const report = await verifyDatabaseCompleteness(
      remoteSource({}),
      localSource([
        { notionPageId: "p1", notionParentId: DB_A, fileType: "file" },
        { notionPageId: "p2", notionParentId: DB_A, fileType: "folder-note" },
      ]),
    );

    expect(report.databases).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it("여러 database 를 각각 대조한다", async () => {
    const report = await verifyDatabaseCompleteness(
      remoteSource({ [DB_A]: ["a1"], [DB_B]: ["b1", "b2"] }),
      localSource([row("a1", DB_A), row("b1", DB_B)]),
    );

    expect(report.remoteTotal).toBe(3);
    expect(report.localTotal).toBe(2);
    const byDb = new Map(report.databases.map((d) => [d.databaseId, d]));
    expect(byDb.get(DB_A)!.missingIds).toEqual([]);
    expect(byDb.get(DB_B)!.missingIds).toEqual(["b2"]);
  });

  it("databaseIds 로 넘긴 DB 는 볼트에 행이 0개여도 대조한다 (통째 미발견 차단)", async () => {
    const report = await verifyDatabaseCompleteness(
      remoteSource({ [DB_B]: ["b1", "b2"] }),
      localSource([row("a1", DB_A)]),
      { databaseIds: [DB_B] },
    );

    const dbB = report.databases.find((d) => d.databaseId === DB_B)!;
    expect(dbB.localRows).toBe(0);
    expect(dbB.missingIds).toEqual(["b1", "b2"]);
    expect(report.complete).toBe(false);
  });

  it("databaseIds 와 볼트가 같은 DB 를 가리키면 한 번만 대조한다", async () => {
    const remote = remoteSource({ [DB_A]: ["r1"] });
    const report = await verifyDatabaseCompleteness(remote, localSource([row("r1", DB_A)]), {
      databaseIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    });

    expect(report.databases).toHaveLength(1);
    expect(remote.queryAllDatabasePages).toHaveBeenCalledTimes(1);
    expect(report.complete).toBe(true);
  });

  it("원격 열거 실패는 통과로 접지 않고 비침묵 보고한다", async () => {
    const remote: CompletenessRemoteSource = {
      queryAllDatabasePages: vi.fn(async (databaseId: string) => {
        if (databaseId.replace(/-/g, "").toLowerCase() === DB_A)
          throw new Error("object_not_found");
        return [{ id: "b1" }];
      }),
    };

    const report = await verifyDatabaseCompleteness(
      remote,
      localSource([row("a1", DB_A), row("b1", DB_B)]),
    );

    expect(report.complete).toBe(false);
    expect(report.failures).toEqual([{ databaseId: DB_A, error: "object_not_found" }]);
    // 실패한 DB 는 총합에서 빠지되, 나머지 대조는 계속된다.
    expect(report.databases.map((d) => d.databaseId)).toEqual([DB_B]);
    expect(report.remoteTotal).toBe(1);
  });

  it("추적 중인 DB 가 없으면 아무것도 대조하지 않는다", async () => {
    const remote = remoteSource({});
    const report = await verifyDatabaseCompleteness(remote, localSource([]));

    expect(report.databases).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.complete).toBe(true);
    expect(remote.queryAllDatabasePages).not.toHaveBeenCalled();
  });
});
