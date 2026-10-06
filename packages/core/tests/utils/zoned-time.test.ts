import { describe, expect, it } from "vitest";
import { isTimeZone, isWallTime, toWallTime, toZonedIso } from "../../src/utils/zoned-time.js";

// 시간대는 모두 이름으로 준다 — 이 컴퓨터(KST) 와 CI(UTC) 에서 같은 답이어야 한다.
describe("toWallTime — 오프셋이 붙은 시각을 시간대의 벽시계 시각으로 (F-08)", () => {
  it("Obsidian 날짜시각 속성의 모양(`YYYY-MM-DDTHH:mm`)으로 적는다", () => {
    expect(toWallTime("2026-10-01T01:00:00.000+00:00", "Asia/Seoul")).toBe("2026-10-01T10:00");
    expect(toWallTime("2026-10-04T14:44:00.000Z", "Asia/Seoul")).toBe("2026-10-04T23:44");
    expect(toWallTime("2026-10-01T10:00:00+09:00", "America/New_York")).toBe("2026-09-30T21:00");
  });

  it("초 · 밀리초가 0 이 아니면 잃지 않고 붙인다", () => {
    expect(toWallTime("2026-10-01T01:00:15.000Z", "Asia/Seoul")).toBe("2026-10-01T10:00:15");
    expect(toWallTime("2026-10-01T01:00:00.250Z", "Asia/Seoul")).toBe("2026-10-01T10:00:00.250");
  });

  it("날짜만 있거나 읽을 수 없는 글은 그대로 둔다", () => {
    expect(toWallTime("2026-10-01", "Asia/Seoul")).toBe("2026-10-01");
    expect(toWallTime("2026-10-01T10:00", "Asia/Seoul")).toBe("2026-10-01T10:00");
    expect(toWallTime("내일 오전", "Asia/Seoul")).toBe("내일 오전");
  });

  it("30분 · 45분 오프셋 시간대도 같다", () => {
    expect(toWallTime("2026-10-01T00:00:00Z", "Asia/Kolkata")).toBe("2026-10-01T05:30");
    expect(toWallTime("2026-10-01T00:00:00Z", "Asia/Kathmandu")).toBe("2026-10-01T05:45");
  });
});

describe("toZonedIso — 벽시계 시각에 시간대의 오프셋을 붙인다 (F-08)", () => {
  it("Notion 이 UTC 로 읽지 않게 오프셋을 붙인다", () => {
    expect(toZonedIso("2026-10-01T10:00", "Asia/Seoul")).toBe("2026-10-01T10:00:00+09:00");
    expect(toZonedIso("2026-10-01T10:00", "UTC")).toBe("2026-10-01T10:00:00+00:00");
    expect(toZonedIso("2026-10-01T10:00:15.250", "Asia/Seoul")).toBe(
      "2026-10-01T10:00:15.250+09:00",
    );
  });

  it("서머타임 — 여름 · 겨울 오프셋을 그날에 맞게 고른다", () => {
    expect(toZonedIso("2026-07-01T09:00", "America/New_York")).toBe("2026-07-01T09:00:00-04:00");
    expect(toZonedIso("2026-12-01T09:00", "America/New_York")).toBe("2026-12-01T09:00:00-05:00");
    expect(toZonedIso("2026-01-15T09:00", "Australia/Lord_Howe")).toBe("2026-01-15T09:00:00+11:00");
  });

  it("건너뛴 시각(봄)은 당기기 전 오프셋 · 겹친 시각(가을)은 앞의 것", () => {
    // 2026-03-08 02:00 → 03:00 (뉴욕). 02:30 은 없는 시각이다.
    expect(toZonedIso("2026-03-08T02:30", "America/New_York")).toBe("2026-03-08T02:30:00-05:00");
    // 2026-11-01 02:00 → 01:00 (뉴욕). 01:30 은 두 번 온다.
    expect(toZonedIso("2026-11-01T01:30", "America/New_York")).toBe("2026-11-01T01:30:00-04:00");
  });

  it("달력에 없는 날짜 · 시각은 null", () => {
    expect(toZonedIso("2026-02-30T10:00", "Asia/Seoul")).toBeNull();
    expect(toZonedIso("2026-10-01T24:00", "Asia/Seoul")).toBeNull();
    expect(toZonedIso("2026-10-01T10:60", "Asia/Seoul")).toBeNull();
    expect(toZonedIso("2026-10-01", "Asia/Seoul")).toBeNull();
  });

  it("벽시계 시각 → 오프셋 시각 → 벽시계 시각은 같은 글이다", () => {
    const zones = ["Asia/Seoul", "UTC", "America/New_York", "Europe/London", "Asia/Kolkata"];
    const walls = [
      "2026-01-01T00:00",
      "2026-06-30T23:59",
      "2026-10-25T01:30:05",
      "2026-03-29T12:00",
    ];
    for (const zone of zones) {
      for (const wall of walls) {
        expect(toWallTime(toZonedIso(wall, zone)!, zone)).toBe(wall);
      }
    }
  });
});

describe("isWallTime · isTimeZone", () => {
  it("오프셋 없는 시각만 벽시계 시각이다", () => {
    expect(isWallTime("2026-10-01T10:00")).toBe(true);
    expect(isWallTime("2026-10-01T10:00:15.250")).toBe(true);
    expect(isWallTime("2026-10-01T10:00+09:00")).toBe(false);
    expect(isWallTime("2026-10-01")).toBe(false);
  });

  it("IANA 이름만 시간대다", () => {
    expect(isTimeZone("Asia/Seoul")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    // 오프셋 표기는 런타임마다 받기도 하고 안 받기도 한다 — 던지지만 않으면 된다.
    expect(() => isTimeZone("+09:00")).not.toThrow();
  });
});
