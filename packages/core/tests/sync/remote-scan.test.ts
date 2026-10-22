/**
 * 원격을 얼마나 훑을지 · 어느 DB 를 조회할지 (ADR-027).
 *
 * 전체 대조는 원격 삭제를 보는 유일한 길이지만 비싸다(실볼트 재pull 523.5초). 그래서 주기마다만 하고,
 * 그 사이에는 바뀐 것이 보인 DB 와 지난번에 받지 못한 DB(대기)만 조회한다. 대기를 잘못 비우면 그 DB
 * 는 원격이 다시 바뀌거나 전체 대조가 돌 때까지 받지 못한 채로 남는다 — 오류는 나지 않는다.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_DATABASES,
  chooseRemoteScan,
  DatabasePullLedger,
  parsePendingDatabases,
  remoteScanInfo,
  selectsDatabase,
  serializePendingDatabases,
  type RemoteScanState,
} from "../../src/sync/remote-scan.js";

const LAST_PULL = "2026-09-28T10:00:00.000Z";
const LAST_FULL = "2026-09-28T09:30:00.000Z";
const HOUR = 3600;
/** 마지막 전체 대조에서 한 시간 뒤 — 다음 전체 대조 예정 시각. */
const NEXT_FULL = "2026-09-28T10:30:00.000Z";

const DB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DB_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const compact = (id: string) => id.replace(/-/g, "");

function state(overrides: Partial<RemoteScanState> = {}): RemoteScanState {
  return {
    lastPullAt: LAST_PULL,
    lastFullPullAt: LAST_FULL,
    trackedRecords: 5,
    databaseMode: false,
    fullReconcileIntervalSec: HOUR,
    ...overrides,
  };
}

const at = (iso: string, deltaMs = 0) => Date.parse(iso) + deltaMs;

describe("chooseRemoteScan", () => {
  it("주기 안이면 지난 pull 뒤에 바뀐 것만 찾는다 — 다음 전체 대조 시각과 함께", () => {
    expect(chooseRemoteScan(state(), { force: false, now: at(LAST_PULL) })).toEqual({
      kind: "incremental",
      since: LAST_PULL,
      lastFullAt: LAST_FULL,
      nextFullAt: NEXT_FULL,
    });
  });

  it("주기가 되면 전체 대조한다 — 예정 시각 바로 전까지는 증분", () => {
    expect(chooseRemoteScan(state(), { force: false, now: at(NEXT_FULL, -1) })).toMatchObject({
      kind: "incremental",
    });
    expect(chooseRemoteScan(state(), { force: false, now: at(NEXT_FULL) })).toEqual({
      kind: "full",
      reason: "due",
    });
  });

  it.each([
    ["한 번도 하지 않았으면(업그레이드 직후)", null],
    ["마지막 시각을 읽을 수 없으면", "not-a-time"],
  ])("%s 때가 된 것으로 본다", (_label, lastFullPullAt) => {
    expect(
      chooseRemoteScan(state({ lastFullPullAt }), { force: false, now: at(LAST_PULL) }),
    ).toEqual({ kind: "full", reason: "due" });
  });

  it("때가 됐어도 미루라면(상태 확인 · 경로를 좁힌 pull) 증분으로 찾고 예정 시각은 비운다", () => {
    expect(
      chooseRemoteScan(state({ lastFullPullAt: null }), {
        force: false,
        now: at(LAST_PULL),
        deferDue: true,
      }),
    ).toEqual({ kind: "incremental", since: LAST_PULL, lastFullAt: null, nextFullAt: null });
  });

  it("미루라는 것은 주기만 미룬다 — 강제 · 처음 · DB 모드 · 매번은 그대로 전체 대조", () => {
    const deferred = { force: false, now: at(LAST_PULL), deferDue: true };
    expect(chooseRemoteScan(state(), { ...deferred, force: true })).toEqual({
      kind: "full",
      reason: "forced",
    });
    expect(chooseRemoteScan(state({ lastPullAt: null }), deferred)).toEqual({
      kind: "full",
      reason: "first",
    });
    expect(chooseRemoteScan(state({ databaseMode: true }), deferred)).toEqual({
      kind: "full",
      reason: "database-mode",
    });
    expect(chooseRemoteScan(state({ fullReconcileIntervalSec: 0 }), deferred)).toEqual({
      kind: "full",
      reason: "every-pull",
    });
  });

  it("--force 는 주기 안이어도 전체 대조한다", () => {
    expect(chooseRemoteScan(state(), { force: true, now: at(LAST_PULL) })).toEqual({
      kind: "full",
      reason: "forced",
    });
  });

  it("DB 모드는 늘 전체 대조한다 — 그 DB 조회가 곧 전체 대조다", () => {
    expect(chooseRemoteScan(state({ databaseMode: true }), { force: false, now: 0 })).toEqual({
      kind: "full",
      reason: "database-mode",
    });
  });

  it.each([
    ["지난 pull 이 없으면", { lastPullAt: null }],
    ["받은 것이 없으면(빈 상태 DB)", { trackedRecords: 0 }],
  ])("%s 처음부터 훑는다", (_label, overrides) => {
    expect(chooseRemoteScan(state(overrides), { force: false, now: at(LAST_PULL) })).toEqual({
      kind: "full",
      reason: "first",
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "주기가 %s 면 pull 마다 전체 대조한다 — 읽을 수 없는 주기로 덜 훑지 않는다",
    (interval) => {
      expect(
        chooseRemoteScan(state({ fullReconcileIntervalSec: interval }), {
          force: false,
          now: at(LAST_PULL),
        }),
      ).toEqual({ kind: "full", reason: "every-pull" });
    },
  );
});

describe("remoteScanInfo", () => {
  it("전체 대조는 이유와 마지막 전체 대조 시각을 싣는다 — 다음 예정도 미룬 삭제도 없다", () => {
    expect(remoteScanInfo({ kind: "full", reason: "due" }, LAST_PULL, true)).toEqual({
      kind: "full",
      reason: "due",
      lastFullAt: LAST_PULL,
      nextFullAt: null,
      deletionsDeferred: false,
    });
  });

  it("증분은 훑기를 고를 때의 시각을 싣고, 원격 삭제를 반영하는 설정이면 삭제를 미뤘다고 적는다", () => {
    const scan = chooseRemoteScan(state(), { force: false, now: at(LAST_PULL) });
    expect(remoteScanInfo(scan, "2026-01-01T00:00:00.000Z", true)).toEqual({
      kind: "incremental",
      lastFullAt: LAST_FULL,
      nextFullAt: NEXT_FULL,
      deletionsDeferred: true,
    });
  });

  it("원격 삭제를 반영하지 않는 설정이면 증분이어도 미룬 삭제가 없다 — 전체 대조도 지우지 않는다", () => {
    const scan = chooseRemoteScan(state(), { force: false, now: at(LAST_PULL) });
    expect(remoteScanInfo(scan, LAST_FULL, false)).toMatchObject({
      kind: "incremental",
      deletionsDeferred: false,
    });
  });
});

describe("selectsDatabase", () => {
  it("전체 대조는 모든 DB 를 조회한다", () => {
    expect(selectsDatabase(ALL_DATABASES, DB_A)).toBe(true);
  });

  it("바뀐 DB 만 조회한다 — id 의 하이픈 · 대소문자와 무관하게", () => {
    const selection = { kind: "changed", ids: new Set([compact(DB_A)]) } as const;
    expect(selectsDatabase(selection, DB_A)).toBe(true);
    expect(selectsDatabase(selection, compact(DB_A).toUpperCase())).toBe(true);
    expect(selectsDatabase(selection, DB_B)).toBe(false);
  });
});

describe("대기 DB 의 저장 모양", () => {
  it("정렬한 JSON 배열로 적고 그대로 읽는다", () => {
    const saved = serializePendingDatabases(new Set([compact(DB_B), compact(DB_A)]));
    expect(saved).toBe(JSON.stringify([compact(DB_A), compact(DB_B)]));
    expect(parsePendingDatabases(saved)).toEqual(new Set([compact(DB_A), compact(DB_B)]));
  });

  it("하이픈이 있는 id 도 같은 모양으로 읽는다", () => {
    expect(parsePendingDatabases(JSON.stringify([DB_A]))).toEqual(new Set([compact(DB_A)]));
  });

  it.each([null, "", "not json", '{"a":1}', "42"])(
    "없거나 깨진 값(%s)은 빈 대기다 — 다음 전체 대조가 어차피 모두 조회한다",
    (raw) => {
      expect(parsePendingDatabases(raw)).toEqual(new Set());
    },
  );

  it("글이 아닌 항목은 버리고 나머지는 읽는다", () => {
    expect(parsePendingDatabases(JSON.stringify([DB_A, 7, null, { id: DB_B }]))).toEqual(
      new Set([compact(DB_A)]),
    );
  });
});

describe("DatabasePullLedger", () => {
  const changed = (...ids: string[]) =>
    ({ kind: "changed", ids: new Set(ids.map(compact)) }) as const;

  it("고른 DB 만 조회한다고 답한다", () => {
    const ledger = new DatabasePullLedger(changed(DB_A), new Set());
    expect(ledger.selects(DB_A)).toBe(true);
    expect(ledger.selects(DB_B)).toBe(false);
  });

  it("건너뛴 DB 수를 센다", () => {
    const ledger = new DatabasePullLedger(changed(), new Set());
    expect(ledger.skipped).toBe(0);
    ledger.skip();
    ledger.skip();
    expect(ledger.skipped).toBe(2);
  });

  it("받은 대기는 빠지고 받지 못한 DB 는 더해진다 — 이번에 닿지 않은 대기는 남는다", () => {
    const ledger = new DatabasePullLedger(changed(DB_A), new Set([compact(DB_A), compact(DB_B)]));
    ledger.settle(DB_A);
    ledger.retry(DB_C);
    expect(ledger.nextPending()).toEqual(new Set([compact(DB_B), compact(DB_C)]));
  });

  it("같은 DB 를 받고도 받지 못한 것이 있으면 대기로 남긴다 — 덜 받은 쪽을 따른다", () => {
    const ledger = new DatabasePullLedger(changed(DB_A), new Set([compact(DB_A)]));
    ledger.settle(DB_A);
    ledger.retry(DB_A);
    expect(ledger.nextPending()).toEqual(new Set([compact(DB_A)]));
  });

  it("이제 동기화하는 DB 로 좁힌다 — 뺀 DB 를 영영 들고 있지 않는다", () => {
    const ledger = new DatabasePullLedger(changed(), new Set([compact(DB_A), compact(DB_B)]));
    ledger.retry(DB_C);
    ledger.keepOnly([DB_B, compact(DB_C)]);
    expect(ledger.nextPending()).toEqual(new Set([compact(DB_B), compact(DB_C)]));
  });

  it("동기화하는 DB 를 모르면(발견이 멈춤) 좁히지 않는다 — 모르는 것을 버리지 않는다", () => {
    const ledger = new DatabasePullLedger(changed(), new Set([compact(DB_A)]));
    ledger.retry(DB_B);
    expect(ledger.nextPending()).toEqual(new Set([compact(DB_A), compact(DB_B)]));
  });

  it("동기화하는 DB 가 하나도 없으면 대기를 모두 비운다", () => {
    const ledger = new DatabasePullLedger(changed(), new Set([compact(DB_A)]));
    ledger.keepOnly([]);
    expect(ledger.nextPending()).toEqual(new Set());
  });
});
