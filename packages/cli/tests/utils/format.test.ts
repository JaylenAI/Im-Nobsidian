/**
 * 원격을 얼마나 훑었나 — pull · sync · status 가 함께 쓰는 문구 (ADR-027).
 *
 * 바뀐 것만 찾은 pull 은 Notion 에서 지운 노트를 아직 볼트에서 지우지 않는다. 그 사실과 언제 반영되는지를
 * 적지 않으면 사람은 «지웠는데 남았다» 를 결함으로 읽는다.
 */
import { describe, it, expect, vi } from "vitest";
import type { FullScanReason, RemoteScanInfo } from "@im-nobsidian/core";

vi.mock("chalk", () => {
  const passthrough = (s: string) => s;
  const fn = Object.assign(passthrough, {
    green: passthrough,
    yellow: passthrough,
    red: passthrough,
    blue: passthrough,
    cyan: passthrough,
    magenta: passthrough,
    dim: passthrough,
    bold: passthrough,
  });
  return { default: fn };
});

import {
  lastFullScanText,
  localDateTime,
  remoteDeletionHint,
  remoteScanLines,
} from "../../src/utils/format.js";

/** 로컬 시각으로 만든 ISO — 시험을 도는 기계의 시간대와 무관하게 같은 글이 나온다. */
const localIso = (hour: number, minute: number, second = 0) =>
  new Date(2026, 8, 28, hour, minute, second).toISOString();

const incremental = (overrides: Partial<RemoteScanInfo> = {}): RemoteScanInfo => ({
  kind: "incremental",
  lastFullAt: localIso(10, 5),
  nextFullAt: localIso(11, 5),
  deletionsDeferred: true,
  ...overrides,
});

describe("localDateTime", () => {
  it("로컬 시각을 YYYY-MM-DD HH:MM:SS 로 적는다", () => {
    expect(localDateTime(localIso(9, 3, 7))).toBe("2026-09-28 09:03:07");
  });

  it("읽을 수 없는 값은 그대로 보인다 — NaN 으로 바꾸지 않는다", () => {
    expect(localDateTime("not-a-time")).toBe("not-a-time");
  });
});

describe("remoteScanLines", () => {
  it.each<[FullScanReason, string]>([
    ["first", "Full scan (first pull)"],
    ["forced", "Full scan (--force)"],
    ["database-mode", "Full scan (database mode)"],
    ["every-pull", "Full scan (every pull)"],
    ["due", "Full scan (scheduled)"],
  ])("전체 대조(%s)는 이유를 사람의 말로 한 줄", (reason, line) => {
    expect(
      remoteScanLines({
        kind: "full",
        reason,
        lastFullAt: localIso(10, 5),
        nextFullAt: null,
        deletionsDeferred: false,
      }),
    ).toEqual([line]);
  });

  it("바뀐 것만 찾았으면 건너뛴 DB 수와 원격 삭제가 반영되는 때를 적는다", () => {
    expect(remoteScanLines(incremental({ skippedDatabases: 3 }))).toEqual([
      "Changes-only scan · 3 unchanged databases skipped",
      "Deletions in Notion apply at the next full scan (2026-09-28 11:05:00) — or run nobsi pull --force",
    ]);
  });

  it("원격 삭제를 반영하지 않는 설정이면 삭제 안내를 붙이지 않는다 — 전체 대조도 지우지 않는다", () => {
    expect(remoteScanLines(incremental({ deletionsDeferred: false, skippedDatabases: 2 }))).toEqual(
      ["Changes-only scan · 2 unchanged databases skipped"],
    );
  });

  it.each([
    [1, "Changes-only scan · 1 unchanged database skipped"],
    [0, "Changes-only scan"],
    [undefined, "Changes-only scan"],
  ])("건너뛴 DB 가 %s 개면 «%s»", (skippedDatabases, line) => {
    expect(remoteScanLines(incremental({ skippedDatabases }))[0]).toBe(line);
  });
});

describe("remoteDeletionHint", () => {
  it("전체 대조가 이미 때가 됐으면 다음 pull 이 한다고 적는다", () => {
    expect(remoteDeletionHint(incremental({ nextFullAt: null }))).toBe(
      "Deletions in Notion apply at the next pull (full scan due) — or run nobsi pull --force",
    );
  });
});

describe("lastFullScanText", () => {
  it("마지막 전체 대조 시각 — 한 번도 없으면 never", () => {
    expect(lastFullScanText(localIso(10, 5))).toBe("2026-09-28 10:05:00");
    expect(lastFullScanText(null)).toBe("never");
  });
});
