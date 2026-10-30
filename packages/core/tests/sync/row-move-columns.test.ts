/**
 * 행을 다른 DB 로 옮기면 Notion 이 대상 DB 에 더하는 열(ADR-047) — 2026-10-30 실측의 규칙.
 */
import { describe, expect, it } from "vitest";
import { columnsAddedByMove, hasPropertyValue } from "../../src/sync/row-move-columns.js";

describe("columnsAddedByMove", () => {
  const row = {
    Name: { type: "title", title: [{ plain_text: "행" }] },
    Filled: { type: "rich_text", rich_text: [{ plain_text: "값" }] },
    Empty: { type: "rich_text", rich_text: [] },
    Num: { type: "number", number: null },
    Zero: { type: "number", number: 0 },
    CbTrue: { type: "checkbox", checkbox: true },
    CbFalse: { type: "checkbox", checkbox: false },
    D: { type: "date", date: { start: "2026-10-30" } },
    F: { type: "formula", formula: { type: "number", number: 2 } },
    CT: { type: "created_time", created_time: "2026-10-30T00:00:00.000Z" },
    Same: { type: "select", select: { name: "a" } },
    Kept: { type: "select", select: { name: "b" } },
  };

  it("값이 있는 속성 가운데 대상에 없는 것은 그 이름, 다른 타입이면 `이름 1` — 빈 값 · 계산 속성 · 제목은 아니다", () => {
    expect(
      columnsAddedByMove(row, {
        Name: { type: "title" },
        Same: { type: "multi_select" },
        Kept: { type: "select" },
      }),
    ).toEqual(["Filled", "Zero", "CbTrue", "D", "Same 1"]);
  });

  it("대상에 같은 이름 · 같은 타입이 모두 있으면 더해지는 열이 없다", () => {
    expect(columnsAddedByMove({ Kept: row.Kept }, { Kept: { type: "select" } })).toEqual([]);
  });

  it("hasPropertyValue — 빈 글 · 빈 목록 · null · 거짓 체크박스는 값이 없다", () => {
    expect(hasPropertyValue(row.Empty)).toBe(false);
    expect(hasPropertyValue(row.Num)).toBe(false);
    expect(hasPropertyValue(row.CbFalse)).toBe(false);
    expect(hasPropertyValue({ type: "url", url: "  " })).toBe(false);
    expect(hasPropertyValue(row.Zero)).toBe(true);
    expect(hasPropertyValue(null)).toBe(false);
  });
});
