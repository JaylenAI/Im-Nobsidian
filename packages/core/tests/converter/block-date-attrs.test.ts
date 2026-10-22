/**
 * 블록 방식 받기(`blocks-to-nfm`)가 날짜 멘션을 Markdown API 와 같은 `<mention-date …/>` 로 내도록 하는 속성 변환.
 *
 * 예전에는 옛 블록 변환기 시험(block-fallback)에 함께 있었다 — 그 변환기를 지우며 제품 경로가 쓰는 이 함수만 옮겼다.
 */
import { describe, it, expect } from "vitest";
import { blockDateAttrs } from "../../src/converter/mention.js";

describe("blockDateAttrs — 블록 API 의 날짜를 Markdown API 의 멘션 속성으로 (A3)", () => {
  // 왼쪽은 블록 API 의 date, 오른쪽은 같은 멘션을 Markdown API 가 내보낸 속성(실측).
  it.each([
    [{ start: "2026-09-26" }, [["start", "2026-09-26"]]],
    [
      { start: "2026-09-26", end: "2026-09-27" },
      [
        ["start", "2026-09-26"],
        ["end", "2026-09-27"],
      ],
    ],
    [
      { start: "2026-09-26T09:00:00.000+09:00" },
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["timeZone", "Etc/GMT-9"],
      ],
    ],
    [
      { start: "2026-09-26T09:00:00.000+09:00", end: "2026-09-27T18:00:00.000+09:00" },
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["end", "2026-09-27"],
        ["endTime", "18:00"],
        ["timeZone", "Etc/GMT-9"],
      ],
    ],
    [
      { start: "2026-09-26T09:00:00.000+00:00" },
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["timeZone", "UTC"],
      ],
    ],
    [
      { start: "2026-09-26T09:00:00.000-05:00" },
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["timeZone", "Etc/GMT+5"],
      ],
    ],
  ])("%j → Markdown API 와 같은 속성", (date, attrs) => {
    expect(blockDateAttrs(date)).toEqual(attrs);
  });

  it("시 단위가 아닌 오프셋은 같은 순간을 UTC 로 적는다 — 날이 바뀌어도", () => {
    expect(blockDateAttrs({ start: "2026-09-26T03:00:00.000+05:30" })).toEqual([
      ["start", "2026-09-25"],
      ["startTime", "21:30"],
      ["timeZone", "UTC"],
    ]);
  });

  it("끝의 오프셋이 다르면 시작의 오프셋으로 옮겨 적는다", () => {
    expect(
      blockDateAttrs({ start: "2026-09-26T09:00:00+09:00", end: "2026-09-26T10:00:00+00:00" }),
    ).toEqual([
      ["start", "2026-09-26"],
      ["startTime", "09:00"],
      ["end", "2026-09-26"],
      ["endTime", "19:00"],
      ["timeZone", "Etc/GMT-9"],
    ]);
  });

  it("오프셋 없는 시각은 시간대 이름과 함께일 때만 읽는다", () => {
    expect(blockDateAttrs({ start: "2026-09-26T09:00:00", time_zone: "Asia/Seoul" })).toEqual([
      ["start", "2026-09-26"],
      ["startTime", "09:00"],
      ["timeZone", "Asia/Seoul"],
    ]);
    expect(blockDateAttrs({ start: "2026-09-26T09:00:00" })).toBeNull();
  });

  it("한쪽에만 시각이 있거나 읽지 못하는 모양이면 null", () => {
    expect(blockDateAttrs({ start: "2026-09-26", end: "2026-09-27T09:00:00+09:00" })).toBeNull();
    expect(blockDateAttrs({ start: "2026-09-26", end: "모레" })).toBeNull();
  });
});
